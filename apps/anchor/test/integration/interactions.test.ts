import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { signup, type TestUser } from '../harness/users';
import { anonymous, call, createGuild, join, list, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { addBot, connectBot, createBot, type TestBot } from '../harness/bots';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'interactions' });
});
afterAll(() => anchor.destroy());

const commands = [
  { name: 'ping', description: 'Pong' },
  {
    name: 'echo',
    description: 'Says it back',
    options: [
      { name: 'text', description: 'What', type: 'string', required: true, maxLength: 20 },
      { name: 'times', description: 'How often', type: 'integer', minValue: 1, maxValue: 3 },
      { name: 'loud', description: 'Shout', type: 'boolean' },
    ],
  },
  {
    name: 'color',
    description: 'Pick',
    options: [
      {
        name: 'name',
        description: 'Color',
        type: 'string',
        required: true,
        choices: [{ name: 'Red', value: 'red' }],
      },
    ],
  },
  {
    name: 'search',
    description: 'Search',
    options: [
      { name: 'query', description: 'q', type: 'string', required: true, autocomplete: true },
    ],
  },
  {
    name: 'poke',
    description: 'Poke',
    options: [{ name: 'who', description: 'w', type: 'user', required: true }],
  },
];

async function world() {
  const [owner, member, outsider] = await Promise.all([
    signup(anchor.url),
    signup(anchor.url),
    signup(anchor.url),
  ]);
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, member);
  const bot = await createBot(owner);
  await call(bot, 'PUT', '/bots/@me/commands', { commands });
  await addBot(owner, guild.id, bot.bot);
  const rt = await connectBot(anchor.url, bot.token);
  return { owner, member, outsider, guild, channel, bot, rt };
}

type World = Awaited<ReturnType<typeof world>>;

const command = (user: Pick<TestUser, 'fetch'>, w: World, name: string, options: object[] = []) =>
  call(user, 'POST', '/interactions', {
    channelId: w.channel.id,
    type: 'command',
    botId: w.bot.bot.userId,
    name,
    options,
  });

/** starts an interaction as `user`, lets the bot answer it with `answer`, returns both results */
async function interact(
  w: World,
  start: () => Promise<{ status: number; body: any }>,
  answer: (interaction: any) => Promise<unknown>
) {
  const seen = w.rt.events.length;
  const started = start();
  const event = await w.rt.waitFor('interaction.created', (e) => w.rt.events.indexOf(e) >= seen);
  const answered = await answer(event.data);
  return {
    started: await started,
    answered: answered as { status: number; body: any },
    interaction: event.data,
  };
}

const respond = (bot: TestBot, interaction: any, path: string, body: object, method = 'POST') =>
  call(bot, method, `/interactions/${interaction.id}/${interaction.token}/${path}`, body);

describe('embeds and buttons', () => {
  const embed = {
    title: 'Hello',
    description: 'World',
    color: 0x00ff00,
    url: 'https://example.com',
    fields: [{ name: 'a', value: 'b', inline: true }],
    footer: { text: 'foot' },
    timestamp: new Date().toISOString(),
  };
  const row = {
    type: 'actionRow',
    components: [
      { type: 'button', style: 'primary', label: 'Click', customId: 'click' },
      { type: 'button', style: 'link', label: 'Docs', url: 'https://example.com/docs' },
    ],
  };

  test('bots send, list and edit embeds and buttons; events carry them', async () => {
    const w = await world();
    const memberRt = await connect(w.member);
    const sent = await send(w.bot as any, w.channel.id, null, {
      embeds: [embed],
      components: [row],
    });
    expect(sent.status).toBe(200);
    expect(sent.body.message.embeds).toEqual([embed]);
    expect(sent.body.message.components).toEqual([row]);
    const event = await memberRt.waitFor(
      'message.created',
      (e) => e.data.id === sent.body.message.id
    );
    expect(event.data.embeds[0].title).toBe('Hello');

    const listed = (await list(w.member, w.channel.id)).body.messages.find(
      (m: any) => m.id === sent.body.message.id
    );
    expect(listed.components).toEqual([row]);
    // people's messages have empty extras
    const plain = await send(w.member, w.channel.id, 'hi');
    expect(plain.body.message).toMatchObject({ embeds: [], components: [], interaction: null });

    const edited = await call(w.bot, 'POST', '/message/edit', {
      channelId: w.channel.id,
      messageId: sent.body.message.id,
      content: 'now with text',
      embeds: [{ title: 'Edited' }],
      components: [],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.message).toMatchObject({
      content: 'now with text',
      embeds: [{ title: 'Edited' }],
      components: [],
    });
    memberRt.close();
    w.rt.close();
  });

  test('people cannot send embeds or buttons', async () => {
    const w = await world();
    expect((await send(w.member, w.channel.id, 'x', { embeds: [embed] })).status).toBe(400);
    expect((await send(w.member, w.channel.id, 'x', { components: [row] })).status).toBe(400);
    const mine = (await send(w.member, w.channel.id, 'x')).body.message;
    const edit = await call(w.member, 'POST', '/message/edit', {
      channelId: w.channel.id,
      messageId: mine.id,
      content: 'y',
      embeds: [embed],
    });
    expect(edit.status).toBe(400);
    w.rt.close();
  });

  test('unsafe or oversized embeds and buttons are refused', async () => {
    const w = await world();
    const bad = [
      { embeds: [{ url: 'javascript:alert(1)' }] },
      { embeds: [{ image: { url: 'data:text/html,hi' } }] },
      { embeds: [{ author: { name: 'x', iconUrl: 'file:///etc/passwd' } }] },
      { embeds: Array.from({ length: 11 }, () => ({ title: 'x' })) },
      { embeds: [{ title: 'x'.repeat(257) }] },
      { embeds: [{ fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' })) }] },
      { embeds: [{ color: -1 }] },
      {
        components: [
          {
            type: 'actionRow',
            components: [{ type: 'button', style: 'link', label: 'x', url: 'javascript:alert(1)' }],
          },
        ],
      },
      {
        components: [
          { type: 'actionRow', components: [{ type: 'button', style: 'primary', label: 'x' }] },
        ],
      },
      {
        components: [
          {
            type: 'actionRow',
            components: Array.from({ length: 6 }, (_, i) => ({
              type: 'button',
              style: 'primary',
              label: 'x',
              customId: `b${i}`,
            })),
          },
        ],
      },
      { components: [row, row] },
      {
        components: Array.from({ length: 6 }, (_, i) => ({
          type: 'actionRow',
          components: [{ type: 'button', style: 'primary', label: 'x', customId: `r${i}` }],
        })),
      },
    ];
    for (const extra of bad) {
      const res = await send(w.bot as any, w.channel.id, 'x', extra);
      expect([400, 422], JSON.stringify(extra).slice(0, 100)).toContain(res.status);
    }
    w.rt.close();
  });
});

describe('slash commands', () => {
  test('members list the commands of the bots in the guild; others cannot', async () => {
    const w = await world();
    const res = await call(w.member, 'GET', `/guilds/${w.guild.id}/commands`);
    expect(res.status).toBe(200);
    expect(res.body.bots).toHaveLength(1);
    expect(res.body.bots[0].bot.userId).toBe(w.bot.bot.userId);
    expect(res.body.bots[0].commands.map((c: any) => c.name)).toContain('echo');
    expect((await call(w.outsider, 'GET', `/guilds/${w.guild.id}/commands`)).status).toBe(404);
    expect(
      (await call(anonymous(anchor.url), 'GET', `/guilds/${w.guild.id}/commands`)).status
    ).toBe(401);
    expect((await call(w.bot, 'GET', `/guilds/${w.guild.id}/commands`)).status).toBe(401);
    w.rt.close();
  });

  test('a reply creates a message marked with the command and who used it', async () => {
    const w = await world();
    const memberRt = await connect(w.member);
    const { started, answered, interaction } = await interact(
      w,
      () =>
        command(w.member, w, 'echo', [
          { name: 'text', value: 'hi' },
          { name: 'times', value: 2 },
        ]),
      (i) => respond(w.bot, i, 'callback', { type: 'message', data: { content: 'hi hi' } })
    );
    expect(answered.status).toBe(200);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ type: 'message', ephemeral: false });
    expect(interaction).toMatchObject({
      type: 'command',
      guildId: w.guild.id,
      channelId: w.channel.id,
      data: { name: 'echo' },
    });
    expect(interaction.user.userId).toBe(w.member.user.id);
    expect(interaction.data.options).toEqual([
      { name: 'text', type: 'string', value: 'hi' },
      { name: 'times', type: 'integer', value: 2 },
    ]);

    const event = await memberRt.waitFor('message.created', (e) => e.data.content === 'hi hi');
    expect(event.data.interaction).toMatchObject({
      id: interaction.id,
      name: 'echo',
      user: { userId: w.member.user.id },
    });
    expect(event.data.author.userId).toBe(w.bot.bot.userId);
    // answering twice is refused
    expect(
      (
        await respond(w.bot, interaction, 'callback', {
          type: 'message',
          data: { content: 'again' },
        })
      ).status
    ).toBe(400);
    memberRt.close();
    w.rt.close();
  });

  test('an ephemeral reply only reaches the person who used the command and is never stored', async () => {
    const w = await world();
    const [memberRt, ownerRt] = await Promise.all([connect(w.member), connect(w.owner)]);
    const { started } = await interact(
      w,
      () => command(w.member, w, 'ping'),
      (i) =>
        respond(w.bot, i, 'callback', {
          type: 'message',
          data: { content: 'secret pong', ephemeral: true },
        })
    );
    expect(started.body).toMatchObject({ type: 'message', ephemeral: true });
    const ephemeral = await memberRt.waitFor('message.ephemeral');
    expect(ephemeral.data).toMatchObject({
      content: 'secret pong',
      ephemeral: true,
      channelId: w.channel.id,
    });
    await Bun.sleep(200);
    expect(ownerRt.events.some((e) => JSON.stringify(e).includes('secret pong'))).toBe(false);
    expect(
      (await list(w.owner, w.channel.id)).body.messages.some(
        (m: any) => m.content === 'secret pong'
      )
    ).toBe(false);
    memberRt.close();
    ownerRt.close();
    w.rt.close();
  });

  test('a deferred reply is completed by editing the original, then follow-ups', async () => {
    const w = await world();
    let interaction: any;
    const { started } = await interact(
      w,
      () => command(w.member, w, 'ping'),
      async (i) => {
        interaction = i;
        return respond(w.bot, i, 'callback', { type: 'deferred' });
      }
    );
    expect(started.body).toMatchObject({ type: 'deferred', ephemeral: false });
    // follow-ups need the original first? no: editing creates it
    expect(
      (await respond(w.bot, interaction, 'original', { content: 'done thinking' }, 'PATCH')).status
    ).toBe(200);
    expect(
      (await respond(w.bot, interaction, 'original', { content: 'done (edited)' }, 'PATCH')).status
    ).toBe(200);
    for (let i = 0; i < 10; i++) {
      expect((await respond(w.bot, interaction, 'followup', { content: `more ${i}` })).status).toBe(
        200
      );
    }
    expect((await respond(w.bot, interaction, 'followup', { content: 'too many' })).status).toBe(
      400
    );
    const contents = (await list(w.member, w.channel.id)).body.messages.map((m: any) => m.content);
    expect(contents).toContain('done (edited)');
    expect(contents).not.toContain('done thinking');
    expect(contents).toContain('more 9');
    w.rt.close();
  });

  test('editing before acknowledging, empty messages and bad callbacks are refused', async () => {
    const w = await world();
    await interact(
      w,
      () => command(w.member, w, 'ping'),
      async (i) => {
        expect((await respond(w.bot, i, 'original', { content: 'x' }, 'PATCH')).status).toBe(400);
        expect((await respond(w.bot, i, 'followup', { content: 'x' })).status).toBe(400);
        expect((await respond(w.bot, i, 'callback', { type: 'message', data: {} })).status).toBe(
          400
        );
        expect(
          (await respond(w.bot, i, 'callback', { type: 'autocomplete', data: { choices: [] } }))
            .status
        ).toBe(400);
        expect(
          (await respond(w.bot, i, 'callback', { type: 'update', data: { content: 'x' } })).status
        ).toBe(400);
        return respond(w.bot, i, 'callback', { type: 'message', data: { content: 'ok' } });
      }
    );
    w.rt.close();
  });

  test('a bot that does not answer times out', async () => {
    const w = await world();
    w.rt.close();
    const started = Date.now();
    const res = await command(w.member, w, 'ping');
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  test('only the bot that got the interaction can answer it, with the right token', async () => {
    const w = await world();
    const other = await createBot(w.owner);
    await interact(
      w,
      () => command(w.member, w, 'ping'),
      async (i) => {
        expect(
          (
            await call(other, 'POST', `/interactions/${i.id}/${i.token}/callback`, {
              type: 'deferred',
            })
          ).status
        ).toBe(404);
        expect(
          (
            await call(w.bot, 'POST', `/interactions/${i.id}/${i.token}x/callback`, {
              type: 'deferred',
            })
          ).status
        ).toBe(404);
        expect(
          (
            await call(w.bot, 'POST', `/interactions/nope/${i.token}/callback`, {
              type: 'deferred',
            })
          ).status
        ).toBe(404);
        expect(
          (
            await call(w.member, 'POST', `/interactions/${i.id}/${i.token}/callback`, {
              type: 'deferred',
            })
          ).status
        ).toBe(401);
        expect(
          (
            await call(anonymous(anchor.url), 'POST', `/interactions/${i.id}/${i.token}/callback`, {
              type: 'deferred',
            })
          ).status
        ).toBe(401);
        return respond(w.bot, i, 'callback', { type: 'deferred' });
      }
    );
    w.rt.close();
  });

  test('options are checked against the command before the bot hears of it', async () => {
    const w = await world();
    const bad: [string, object[]][] = [
      ['echo', []],
      ['echo', [{ name: 'text', value: 5 }]],
      ['echo', [{ name: 'text', value: 'x'.repeat(21) }]],
      [
        'echo',
        [
          { name: 'text', value: 'hi' },
          { name: 'times', value: 4 },
        ],
      ],
      [
        'echo',
        [
          { name: 'text', value: 'hi' },
          { name: 'times', value: 1.5 },
        ],
      ],
      [
        'echo',
        [
          { name: 'text', value: 'hi' },
          { name: 'loud', value: 'yes' },
        ],
      ],
      [
        'echo',
        [
          { name: 'text', value: 'hi' },
          { name: 'nope', value: 1 },
        ],
      ],
      [
        'echo',
        [
          { name: 'text', value: 'a' },
          { name: 'text', value: 'b' },
        ],
      ],
      ['color', [{ name: 'name', value: 'blue' }]],
      ['poke', [{ name: 'who', value: w.outsider.user.id }]],
      ['nosuchcommand', []],
    ];
    for (const [name, options] of bad) {
      const res = await command(w.member, w, name, options);
      expect([400, 404], `${name} ${JSON.stringify(options)}`).toContain(res.status);
    }
    await Bun.sleep(100);
    expect(w.rt.events.some((e) => e.type === 'interaction.created')).toBe(false);
    // a bot that isn't in the guild, or a person posing as a bot
    const res = await call(w.member, 'POST', '/interactions', {
      channelId: w.channel.id,
      type: 'command',
      botId: w.owner.user.id,
      name: 'ping',
      options: [],
    });
    expect(res.status).toBe(404);
    w.rt.close();
  });

  test('user options reach the bot as a handle with the profile', async () => {
    const w = await world();
    const { interaction } = await interact(
      w,
      () => command(w.member, w, 'poke', [{ name: 'who', value: w.owner.user.id }]),
      (i) => respond(w.bot, i, 'callback', { type: 'message', data: { content: 'poked' } })
    );
    expect(interaction.data.options[0]).toMatchObject({
      type: 'user',
      value: `@${w.owner.user.username}:${w.owner.user.homeserver}`,
      user: { userId: w.owner.user.id },
    });
    w.rt.close();
  });

  test('autocomplete returns the bot suggestions to the person', async () => {
    const w = await world();
    const { started, interaction } = await interact(
      w,
      () =>
        call(w.member, 'POST', '/interactions', {
          channelId: w.channel.id,
          type: 'autocomplete',
          botId: w.bot.bot.userId,
          name: 'search',
          options: [{ name: 'query', value: 'ca' }],
          focused: 'query',
        }),
      (i) =>
        respond(w.bot, i, 'callback', {
          type: 'autocomplete',
          data: { choices: [{ name: 'Cat', value: 'cat' }] },
        })
    );
    expect(interaction.data.options[0]).toMatchObject({
      name: 'query',
      value: 'ca',
      focused: true,
    });
    expect(started.body).toEqual({
      id: interaction.id,
      type: 'autocomplete',
      choices: [{ name: 'Cat', value: 'cat' }],
    });
    // only options marked for autocomplete
    const res = await call(w.member, 'POST', '/interactions', {
      channelId: w.channel.id,
      type: 'autocomplete',
      botId: w.bot.bot.userId,
      name: 'echo',
      options: [],
      focused: 'text',
    });
    expect(res.status).toBe(400);
    w.rt.close();
  });

  test('a bot only answers in public where it may post itself', async () => {
    const w = await world();
    await call(w.owner, 'PATCH', `/channel/${w.channel.id}`, { ownerOnly: true });
    const memberRt = await connect(w.member);
    const { started, answered, interaction } = await interact(
      w,
      () => command(w.member, w, 'ping'),
      async (i) => {
        const refused = await respond(w.bot, i, 'callback', {
          type: 'message',
          data: { content: 'announcement' },
        });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('This bot cannot send messages in this channel');
        return respond(w.bot, i, 'callback', {
          type: 'message',
          data: { content: 'just you', ephemeral: true },
        });
      }
    );
    expect(answered.status).toBe(200);
    expect(started.body).toMatchObject({ type: 'message', ephemeral: true });
    expect(
      (await respond(w.bot, interaction, 'followup', { content: 'announcement' })).status
    ).toBe(403);
    expect((await list(w.owner, w.channel.id)).body.messages).toEqual([]);
    memberRt.close();
    w.rt.close();
  });

  test('a person can only start so many interactions a minute', async () => {
    const w = await world();
    const bogus = () =>
      call(w.member, 'POST', '/interactions', {
        channelId: w.channel.id,
        type: 'command',
        botId: 'not-a-bot',
        name: 'ping',
        options: [],
      });
    for (let i = 0; i < 120; i++) expect((await bogus()).status).toBe(404);
    expect((await bogus()).status).toBe(429);
    // others are not affected
    expect((await command(w.owner, w, 'nope')).status).toBe(404);
    w.rt.close();
  });

  test('outsiders cannot start interactions', async () => {
    const w = await world();
    expect((await command(w.outsider, w, 'ping')).status).toBe(403);
    expect((await command(anonymous(anchor.url), w, 'ping')).status).toBe(401);
    expect((await command(w.bot, w, 'ping')).status).toBe(401);
    w.rt.close();
  });
});

describe('buttons', () => {
  const buttons = (disabled = false) => [
    {
      type: 'actionRow',
      components: [
        { type: 'button', style: 'success', label: 'Yes', customId: 'yes', disabled },
        { type: 'button', style: 'link', label: 'Site', url: 'https://example.com' },
      ],
    },
  ];
  const press = (user: Pick<TestUser, 'fetch'>, w: World, messageId: string, customId: string) =>
    call(user, 'POST', '/interactions', {
      channelId: w.channel.id,
      type: 'button',
      messageId,
      customId,
    });

  test('pressing a button lets the bot update the message', async () => {
    const w = await world();
    const memberRt = await connect(w.member);
    const message = (await send(w.bot as any, w.channel.id, 'Agree?', { components: buttons() }))
      .body.message;
    const { started, interaction } = await interact(
      w,
      () => press(w.member, w, message.id, 'yes'),
      (i) =>
        respond(w.bot, i, 'callback', {
          type: 'update',
          data: { content: 'Agreed!', components: buttons(true) },
        })
    );
    expect(started.body.type).toBe('update');
    expect(interaction).toMatchObject({
      type: 'button',
      data: { customId: 'yes' },
      message: { id: message.id, ephemeral: false },
    });
    const updated = await memberRt.waitFor('message.updated', (e) => e.data.id === message.id);
    expect(updated.data.content).toBe('Agreed!');
    // a disabled button can't be pressed any more
    expect((await press(w.member, w, message.id, 'yes')).status).toBe(404);
    memberRt.close();
    w.rt.close();
  });

  test('link buttons, unknown buttons and people messages have nothing to press', async () => {
    const w = await world();
    const message = (await send(w.bot as any, w.channel.id, 'x', { components: buttons() })).body
      .message;
    const mine = (await send(w.member, w.channel.id, 'x')).body.message;
    expect((await press(w.member, w, message.id, 'Site')).status).toBe(404);
    expect((await press(w.member, w, message.id, 'nope')).status).toBe(404);
    expect((await press(w.member, w, mine.id, 'yes')).status).toBe(404);
    expect((await press(w.outsider, w, message.id, 'yes')).status).toBe(403);
    w.rt.close();
  });

  test('buttons on an ephemeral message only work for the person who got it', async () => {
    const w = await world();
    const memberRt = await connect(w.member);
    await interact(
      w,
      () => command(w.member, w, 'ping'),
      (i) =>
        respond(w.bot, i, 'callback', {
          type: 'message',
          data: { content: 'Only you', ephemeral: true, components: buttons() },
        })
    );
    const ephemeral = await memberRt.waitFor('message.ephemeral');
    expect((await press(w.owner, w, ephemeral.data.id, 'yes')).status).toBe(404);
    const { started } = await interact(
      w,
      () => press(w.member, w, ephemeral.data.id, 'yes'),
      (i) =>
        respond(w.bot, i, 'callback', { type: 'update', data: { content: 'Updated just for you' } })
    );
    expect(started.status).toBe(200);
    await memberRt.waitFor(
      'message.ephemeral',
      (e) => e.data.id === ephemeral.data.id && e.data.content === 'Updated just for you'
    );
    memberRt.close();
    w.rt.close();
  });

  test('a removed bot can no longer be pressed or used', async () => {
    const w = await world();
    const message = (await send(w.bot as any, w.channel.id, 'x', { components: buttons() })).body
      .message;
    await call(w.owner, 'DELETE', `/guilds/${w.guild.id}/bots/${w.bot.bot.userId}`);
    expect((await press(w.member, w, message.id, 'yes')).status).toBe(404);
    expect((await command(w.member, w, 'ping')).status).toBe(404);
    expect((await call(w.member, 'GET', `/guilds/${w.guild.id}/commands`)).body.bots).toEqual([]);
    w.rt.close();
  });
});
