import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../../anchor/test/harness/anchor';
import { signup } from '../../anchor/test/harness/users';
import { call, createGuild, join, list, send } from '../../anchor/test/harness/chat';
import { connect } from '../../anchor/test/harness/realtime';
import { eventually } from '../../anchor/test/harness/wait';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  SlashCommandBuilder,
  type Message,
} from '../src/index';

// The SDK against a real Anchor (needs `bun run --filter anchor test:infra`): run with `bun run test:e2e`.
let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'sdk' });
});
afterAll(() => anchor.destroy());

async function setup() {
  const owner = await signup(anchor.url);
  const member = await signup(anchor.url);
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, member);
  const created = await call(owner, 'POST', '/developers/bots', {
    username: `sdk${Date.now().toString(36)}`,
  });
  const client = new Client({ token: created.body.token, baseUrl: anchor.url, reconnect: false });
  return { owner, member, guild, channel, client, bot: created.body.bot };
}

describe('Client', () => {
  test('logs in, joins a guild, hears messages and replies with an embed', async () => {
    const { owner, member, guild, channel, client, bot } = await setup();
    await client.login();
    expect(client.user?.username).toBe(bot.username);
    expect(client.guilds.size).toBe(0);

    const joined = new Promise((resolve) => client.once('guildCreate', resolve));
    await call(owner, 'POST', `/guilds/${guild.id}/bots`, {
      username: bot.username,
      homeserver: bot.homeserver,
    });
    await joined;
    expect(client.guilds.get(guild.id)?.channels.get(channel.id)?.name).toBe('general');

    client.on('messageCreate', async (message: Message) => {
      if (message.author.bot || message.content !== '!ping') return;
      await message.reply({
        content: 'pong',
        embeds: [new EmbedBuilder().setTitle('Pong!').setColor('#00ff00')],
      });
    });
    // the guild subscription is asynchronous, so keep pinging until the bot answers
    await eventually(
      async () => {
        await send(member, channel.id, '!ping');
        await Bun.sleep(300);
        return (await list(member, channel.id)).body.messages.find(
          (m: any) => m.content === 'pong'
        );
      },
      { timeout: 10_000 }
    );
    const pong = (await list(member, channel.id)).body.messages.find(
      (m: any) => m.content === 'pong'
    );
    expect(pong.embeds).toEqual([{ title: 'Pong!', color: 0x00ff00 }]);
    expect(pong.replyTo).not.toBeNull();
    client.destroy();
  });

  test('slash commands with options, ephemeral replies and buttons', async () => {
    const { owner, member, guild, channel, client, bot } = await setup();
    await client.login();
    await client.commands.set([
      new SlashCommandBuilder()
        .setName('greet')
        .setDescription('Greets someone')
        .addStringOption((o) => o.setName('name').setDescription('Who').setRequired()),
    ]);
    expect((await client.commands.fetch()).map((c) => c.name)).toEqual(['greet']);
    await call(owner, 'POST', `/guilds/${guild.id}/bots`, {
      username: bot.username,
      homeserver: bot.homeserver,
    });
    await eventually(() => client.guilds.has(guild.id));

    client.on('interactionCreate', async (interaction) => {
      if (interaction.isCommand() && interaction.commandName === 'greet') {
        const name = interaction.options.getString('name', true);
        await interaction.reply({
          content: `Hello ${name}! (asked by ${interaction.user.tag})`,
          ephemeral: true,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('wave').setLabel('Wave').setStyle(ButtonStyle.Primary)
            ),
          ],
        });
      }
      if (interaction.isButton() && interaction.customId === 'wave') {
        await interaction.update({ content: 'waved', components: [] });
      }
    });

    const memberRt = await connect(member);
    const res = await call(member, 'POST', '/interactions', {
      channelId: channel.id,
      type: 'command',
      botId: bot.userId,
      name: 'greet',
      options: [{ name: 'name', value: 'Ada' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'message', ephemeral: true });
    const ephemeral = await memberRt.waitFor('message.ephemeral');
    expect(ephemeral.data.content).toBe(
      `Hello Ada! (asked by @${member.user.username}:${member.user.homeserver})`
    );

    const pressed = await call(member, 'POST', '/interactions', {
      channelId: channel.id,
      type: 'button',
      messageId: ephemeral.data.id,
      customId: 'wave',
    });
    expect(pressed.body.type).toBe('update');
    await memberRt.waitFor('message.ephemeral', (e) => e.data.content === 'waved');
    memberRt.close();
    client.destroy();
  });

  test('a bad token fails to log in', async () => {
    const client = new Client({ token: 'nope.nope', baseUrl: anchor.url });
    await expect(client.login()).rejects.toThrow(/401/);
  });
});
