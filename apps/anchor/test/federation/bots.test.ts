import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, api, restart, signup, stackIsUp } from '../harness/federation';
import { freshAnchor } from '../harness/ssrf';
import { call, createGuild, list, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import {
  closePg,
  fakeSend,
  fedChannelId,
  fedGuildId,
  pg,
  signerFor,
  userPayload,
} from '../harness/fedflows';
import { addBot, connectBot, createBot, type TestBot } from '../harness/bots';
import { eventually } from '../harness/wait';
import type { TestUser } from '../harness/users';

// Bots across homeservers: a guild hosted on A, bots living on B, people on B and C.
beforeAll(async () => {
  await stackIsUp();
  // an earlier suite may have rotated a homeserver key that the others still have cached
  // A first (its restart also restarts its canary, which this waits for), so B and C come up
  // to a reachable A instead of caching it as down
  await freshAnchor('a');
  await Promise.all([restart('b'), restart('c')]);
}, 120_000);
afterAll(closePg);

const hostA = anchors.a.homeserver;
const commands = [
  { name: 'ping', description: 'Pong' },
  {
    name: 'search',
    description: 'Search',
    options: [{ name: 'q', description: 'q', type: 'string', required: true, autocomplete: true }],
  },
];

/** `user` (on another homeserver) joins an A guild through an invite */
async function joinRemote(owner: TestUser, guildId: string, user: TestUser) {
  const { body } = await call(owner, 'POST', `/guilds/${guildId}/invites`, {});
  const res = await call(user, 'POST', '/invite/accept', {
    code: body.invite.code,
    homeserver: hostA,
  });
  if (res.status !== 200)
    throw new Error(`remote join failed: ${res.status} ${JSON.stringify(res.body)}`);
}

const makeAdminOnA = async (guildId: string, user: TestUser) =>
  pg('a')`UPDATE guild_member SET role = 'ADMIN' WHERE "guildId" = ${guildId}
    AND "userId" = (SELECT id FROM "user" WHERE username = ${user.user.username} AND "homeserverName" = ${user.user.homeserver.toLowerCase()})`;

/** an A guild with a public B bot in it, connected and subscribed */
async function world(role: 'MEMBER' | 'ADMIN' = 'MEMBER') {
  const owner = await signup('a');
  const { guild, channel } = await createGuild(owner, 'botguild');
  const botOwner = await signup('b');
  const bot = await createBot(botOwner);
  await call(bot, 'PUT', '/bots/@me/commands', { commands });
  const rt = await connectBot(api('b'), bot.token);
  const added = await addBot(owner, guild.id, bot.bot, role);
  if (added.status !== 200)
    throw new Error(`add failed: ${added.status} ${JSON.stringify(added.body)}`);
  const shadowGuild = fedGuildId(hostA, guild.id);
  const shadowChannel = fedChannelId(hostA, channel.id);
  await rt.waitFor('guild.created', (e) => e.data.id === shadowGuild);
  rt.send({ type: 'subscribe.guild', guildId: shadowGuild });
  await rt.waitFor('voice.states.snapshot', (e) => e.data.guildIds?.includes(shadowGuild));
  return { owner, guild, channel, botOwner, bot, rt, shadowGuild, shadowChannel };
}

const respond = (bot: TestBot, i: any, path: string, body: object, method = 'POST') =>
  call(bot, method, `/interactions/${i.id}/${i.token}/${path}`, body);

describe('adding bots across homeservers', () => {
  test('an A guild adds a public B bot; it hears the guild and talks back with embeds', async () => {
    const w = await world();
    const users = await call(w.owner, 'GET', `/channel/${w.channel.id}/users`);
    expect(users.body.users.find((u: any) => u.username === w.bot.bot.username)).toMatchObject({
      isBot: true,
      homeserver: anchors.b.homeserver,
      role: 'MEMBER',
    });

    // the bridge from B to A may still be reconnecting after an earlier suite restarted anchors
    const heard = await eventually(
      async () => {
        await send(w.owner, w.channel.id, 'hello bot');
        return w.rt
          .waitFor('message.created', (e) => e.data.content === 'hello bot', 3_000)
          .catch(() => null);
      },
      { timeout: 45_000, interval: 0, message: 'the bot hears the guild' }
    );
    expect(heard.data.channelId).toBe(w.shadowChannel);

    const sent = await send(w.bot as any, w.shadowChannel, null, {
      embeds: [{ title: 'Hi from B' }],
    });
    expect(sent.status).toBe(200);
    const onA = (await list(w.owner, w.channel.id)).body.messages.find(
      (m: any) => m.id === sent.body.message.id
    );
    expect(onA).toMatchObject({ embeds: [{ title: 'Hi from B' }], author: { isBot: true } });
    w.rt.close();
  });

  test('a private B bot can only be added by its owner, starting from B', async () => {
    const owner = await signup('a');
    const { guild } = await createGuild(owner);
    const botOwner = await signup('b');
    await joinRemote(owner, guild.id, botOwner);
    await makeAdminOnA(guild.id, botOwner);
    const bot = await createBot(botOwner, { public: false });

    const refused = await addBot(owner, guild.id, bot.bot);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('This bot is private');

    expect((await addBot(botOwner, fedGuildId(hostA, guild.id), bot.bot)).status).toBe(200);
    const users = await call(owner, 'GET', `/guilds/${guild.id}/commands`);
    expect(users.body.bots.map((b: any) => b.bot.username)).toContain(bot.bot.username);
  });

  test('B people need to be managers of the A guild to add bots there', async () => {
    const owner = await signup('a');
    const { guild } = await createGuild(owner);
    const [member, admin] = await Promise.all([signup('b'), signup('b')]);
    await joinRemote(owner, guild.id, member);
    await joinRemote(owner, guild.id, admin);
    await makeAdminOnA(guild.id, admin);
    const botOnA = await createBot(owner);
    const shadow = fedGuildId(hostA, guild.id);

    expect((await addBot(member, shadow, botOnA.bot)).status).toBe(403);
    expect((await addBot(admin, shadow, botOnA.bot, 'ADMIN')).status).toBe(403);
    expect((await addBot(admin, shadow, botOnA.bot)).status).toBe(200);
    // and only managers take bots out again
    expect(
      (await call(member, 'DELETE', `/guilds/${shadow}/bots/${botOnA.bot.userId}`)).status
    ).toBe(403);
    expect(
      (await call(admin, 'DELETE', `/guilds/${shadow}/bots/${botOnA.bot.userId}`)).status
    ).toBe(200);
  });

  test('looking up a remote bot shows its public profile', async () => {
    const someone = await signup('a');
    const botOwner = await signup('b');
    const bot = await createBot(botOwner, { public: false });
    const res = await call(
      someone,
      'GET',
      `/bots/lookup?username=${bot.bot.username}&homeserver=${anchors.b.homeserver}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      public: false,
      user: { username: bot.bot.username, isBot: true },
    });
    const person = await call(
      someone,
      'GET',
      `/bots/lookup?username=${botOwner.user.username}&homeserver=${anchors.b.homeserver}`
    );
    expect(person.status).toBe(404);
  });

  test('removing the bot on A tells B; a bot leaving from B tells A', async () => {
    const w = await world();
    expect(
      (await call(w.owner, 'DELETE', `/guilds/${w.guild.id}/bots/${await botIdOnA(w)}`)).status
    ).toBe(200);
    await w.rt.waitFor('guild.deleted', (e) => e.data.guildId === w.shadowGuild, 15_000);
    expect((await call(w.bot, 'GET', '/guilds/list')).body.guilds).toEqual([]);

    expect((await addBot(w.owner, w.guild.id, w.bot.bot)).status).toBe(200);
    await eventually(
      async () => (await call(w.bot, 'GET', '/guilds/list')).body.guilds.length === 1
    );
    const ownerRt = await connect(w.owner);
    expect(
      (await call(w.bot, 'POST', `/bots/@me/guilds/${encodeURIComponent(w.shadowGuild)}/leave`))
        .status
    ).toBe(200);
    await ownerRt.waitFor('member.left', () => true, 15_000);
    const users = await call(w.owner, 'GET', `/channel/${w.channel.id}/users`);
    expect(users.body.users.map((u: any) => u.username)).not.toContain(w.bot.bot.username);
    ownerRt.close();
    w.rt.close();
  });
});

async function botIdOnA(w: Awaited<ReturnType<typeof world>>) {
  const users = await call(w.owner, 'GET', `/channel/${w.channel.id}/users`);
  return users.body.users.find((u: any) => u.username === w.bot.bot.username).userId as string;
}

describe('interactions across three homeservers', () => {
  test('a C person uses a B bot in an A guild: commands, ephemeral and public replies, autocomplete, buttons', async () => {
    const w = await world();
    const person = await signup('c');
    await joinRemote(w.owner, w.guild.id, person);
    const personGuild = fedGuildId(hostA, w.guild.id);
    const personChannel = fedChannelId(hostA, w.channel.id);
    const personRt = await connect(person);

    const listed = await call(person, 'GET', `/guilds/${encodeURIComponent(personGuild)}/commands`);
    expect(listed.status).toBe(200);
    const entry = listed.body.bots.find((b: any) => b.bot.username === w.bot.bot.username);
    expect(entry.commands.map((c: any) => c.name)).toEqual(['ping', 'search']);
    const botId = entry.bot.userId;

    const interact = async (body: object, answer: (i: any) => Promise<unknown>) => {
      const seen = w.rt.events.length;
      const started = call(person, 'POST', '/interactions', { channelId: personChannel, ...body });
      const event = await w.rt.waitFor(
        'interaction.created',
        (e) => w.rt.events.indexOf(e) >= seen,
        15_000
      );
      const answered = (await answer(event.data)) as { status: number; body: any };
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      return { started: await started, interaction: event.data };
    };

    // ephemeral: only the C person sees it, in C's own ids
    const first = await interact({ type: 'command', botId, name: 'ping', options: [] }, (i) =>
      respond(w.bot, i, 'callback', {
        type: 'message',
        data: { content: 'pssst', ephemeral: true },
      })
    );
    expect(first.started.status).toBe(200);
    expect(first.started.body).toMatchObject({ type: 'message', ephemeral: true });
    expect(first.interaction).toMatchObject({ guildId: w.shadowGuild, channelId: w.shadowChannel });
    expect(first.interaction.user).toMatchObject({
      username: person.user.username,
      homeserver: anchors.c.homeserver,
    });
    const ephemeral = await personRt.waitFor('message.ephemeral', () => true, 15_000);
    expect(ephemeral.data).toMatchObject({
      content: 'pssst',
      channelId: personChannel,
      guildId: personGuild,
    });

    // a public reply lands in the guild for everyone
    const ownerRt = await connect(w.owner);
    await interact({ type: 'command', botId, name: 'ping', options: [] }, (i) =>
      respond(w.bot, i, 'callback', {
        type: 'message',
        data: {
          content: 'pong for all',
          components: [
            {
              type: 'actionRow',
              components: [{ type: 'button', style: 'primary', label: 'Again', customId: 'again' }],
            },
          ],
        },
      })
    );
    const pong = await ownerRt.waitFor(
      'message.created',
      (e) => e.data.content === 'pong for all',
      15_000
    );
    expect(pong.data.interaction).toMatchObject({
      name: 'ping',
      user: { username: person.user.username },
    });

    // autocomplete goes all the way to the bot and back
    const auto = await interact(
      {
        type: 'autocomplete',
        botId,
        name: 'search',
        options: [{ name: 'q', value: 'no' }],
        focused: 'q',
      },
      (i) =>
        respond(w.bot, i, 'callback', {
          type: 'autocomplete',
          data: { choices: [{ name: 'Novarum', value: 'novarum' }] },
        })
    );
    expect(auto.started.body).toMatchObject({
      type: 'autocomplete',
      choices: [{ name: 'Novarum', value: 'novarum' }],
    });

    // pressing the button on the public reply lets the bot update it
    const pressed = await interact(
      { type: 'button', messageId: pong.data.id, customId: 'again' },
      (i) =>
        respond(w.bot, i, 'callback', {
          type: 'update',
          data: { content: 'pong again', components: [] },
        })
    );
    expect(pressed.started.body.type).toBe('update');
    await ownerRt.waitFor(
      'message.updated',
      (e) => e.data.id === pong.data.id && e.data.content === 'pong again',
      15_000
    );

    // a deferred answer followed up later
    const deferred = await interact({ type: 'command', botId, name: 'ping', options: [] }, (i) =>
      respond(w.bot, i, 'callback', { type: 'deferred', data: { ephemeral: true } })
    );
    expect(deferred.started.body).toMatchObject({ type: 'deferred', ephemeral: true });
    expect(
      (
        await respond(
          w.bot,
          deferred.interaction,
          'original',
          { content: 'thought about it' },
          'PATCH'
        )
      ).status
    ).toBe(200);
    await personRt.waitFor(
      'message.ephemeral',
      (e) => e.data.content === 'thought about it',
      15_000
    );

    personRt.close();
    ownerRt.close();
    w.rt.close();
  });

  test('a B bot that is offline makes the C person time out cleanly', async () => {
    const w = await world();
    w.rt.close();
    const person = await signup('c');
    await joinRemote(w.owner, w.guild.id, person);
    const listed = await call(
      person,
      'GET',
      `/guilds/${encodeURIComponent(fedGuildId(hostA, w.guild.id))}/commands`
    );
    const res = await call(person, 'POST', '/interactions', {
      channelId: fedChannelId(hostA, w.channel.id),
      type: 'command',
      botId: listed.body.bots[0].bot.userId,
      name: 'ping',
      options: [],
    });
    expect(res.status).toBe(504);
  });
});

describe('hostile homeservers', () => {
  test('C cannot deliver interactions for, or take bots out of, guilds hosted on A', async () => {
    const w = await world();
    const c = await signerFor('c');
    const someone = await signup('c');
    const interaction = {
      id: 'forged1',
      token: 'forgedtoken',
      type: 'command',
      guildId: w.guild.id,
      channelId: w.channel.id,
      user: { ...userPayload(someone.user), userId: someone.user.id },
      data: { name: 'ping', options: [] },
    };
    const delivered = await c.send('b', 'POST', '/federation/interactions', {
      bot: w.bot.bot.username,
      interaction,
    });
    expect(delivered.status).toBe(403);
    await Bun.sleep(200);
    expect(w.rt.events.some((e) => e.type === 'interaction.created')).toBe(false);

    // leaving only affects guilds the sender hosts: this would be fed:guild:C:..., which the bot isn't in
    await c.send('b', 'POST', `/federation/bots/${w.bot.bot.username}/leave`, {
      guildId: w.guild.id,
    });
    expect((await call(w.bot, 'GET', '/guilds/list')).body.guilds.map((g: any) => g.id)).toContain(
      w.shadowGuild
    );

    // nor ask for its commands in a guild of A
    expect(
      (
        await c.send('b', 'POST', `/federation/bots/${w.bot.bot.username}/commands`, {
          guildId: w.guild.id,
        })
      ).status
    ).toBe(404);
    w.rt.close();
  });

  test('a host cannot invent an A-person in an interaction it delivers to a B bot', async () => {
    const w = await world();
    const a = await signerFor('a');
    const stranger = await signup('b');
    const delivered = await a.send('b', 'POST', '/federation/interactions', {
      bot: w.bot.bot.username,
      interaction: {
        id: 'forged2',
        token: 'forgedtoken',
        type: 'command',
        guildId: w.guild.id,
        channelId: w.channel.id,
        // a B person who isn't in the guild
        user: { ...userPayload(stranger.user), userId: 'x' },
        data: { name: 'ping', options: [] },
      },
    });
    expect(delivered.status).toBe(403);
    w.rt.close();
  });

  test('joining: private bots need a grant, and only for guilds the sender hosts', async () => {
    const botOwner = await signup('b');
    const bot = await createBot(botOwner, { public: false });
    const c = await signerFor('c');
    const guild = { id: 'g1', name: 'x', description: null, avatarUrl: null };
    const join = (homeserver: string, grant?: string) =>
      c.send('b', 'POST', `/federation/bots/${bot.bot.username}/join`, {
        guild: { ...guild, homeserver },
        channels: [],
        role: 'MEMBER',
        grant,
      });
    expect((await join(anchors.c.homeserver)).status).toBe(403);
    expect((await join(anchors.c.homeserver, 'made-up-grant')).status).toBe(403);
    expect((await join(hostA)).status).toBe(403);
    expect((await call(bot, 'GET', '/guilds/list')).body.guilds).toEqual([]);

    // a public bot can join C's guilds, but C still can't speak for A's
    const publicBot = await createBot(botOwner);
    const joinPublic = (homeserver: string) =>
      c.send('b', 'POST', `/federation/bots/${publicBot.bot.username}/join`, {
        guild: { ...guild, homeserver },
        channels: [],
        role: 'MEMBER',
      });
    expect((await joinPublic(hostA)).status).toBe(403);
    expect((await joinPublic(anchors.c.homeserver)).status).toBe(200);
  });

  test('ephemeral messages only go to people in a guild the sender hosts', async () => {
    const w = await world();
    const c = await signerFor('c');
    const person = await signup('b');
    await joinRemote(w.owner, w.guild.id, person);
    const message = {
      id: 'e1',
      channelId: w.channel.id,
      guildId: w.guild.id,
      content: 'phish',
      embeds: [],
      components: [],
      author: {
        ...userPayload({ username: 'fakebot', homeserver: anchors.c.homeserver }, { isBot: true }),
        userId: 'x',
      },
      interaction: null,
      createdAt: new Date().toISOString(),
      ephemeral: true,
    };
    expect(
      (
        await c.send('b', 'POST', '/federation/interactions/ephemeral', {
          username: person.user.username,
          message,
        })
      ).status
    ).toBe(403);
    // A hosts the guild, but can't put words in the mouth of a B person who isn't there
    const a = await signerFor('a');
    const outsider = await signup('b');
    const forged = { ...message, author: { ...userPayload(outsider.user), userId: 'y' } };
    expect(
      (
        await a.send('b', 'POST', '/federation/interactions/ephemeral', {
          username: person.user.username,
          message: forged,
        })
      ).status
    ).toBe(403);

    // the host can't whisper at a member out of the blue, even as a bot of a guild they're in
    const whisper = () =>
      a.send('b', 'POST', '/federation/interactions/ephemeral', {
        username: person.user.username,
        message,
      });
    expect((await whisper()).status).toBe(403);
    // once they used an interaction there, the bot's answers get through
    const shadowChannel = fedChannelId(hostA, w.channel.id);
    await call(person, 'POST', '/interactions', {
      channelId: shadowChannel,
      type: 'command',
      botId: 'not-a-bot',
      name: 'ping',
      options: [],
    });
    expect((await whisper()).status).toBe(200);
    // but only from a bot, and only in a channel of that guild
    const asPerson = { ...message, author: { ...message.author, isBot: false } };
    const elsewhere = { ...message, channelId: 'not-a-channel' };
    for (const forgedMessage of [asPerson, elsewhere]) {
      expect(
        (
          await a.send('b', 'POST', '/federation/interactions/ephemeral', {
            username: person.user.username,
            message: forgedMessage,
          })
        ).status
      ).toBe(403);
    }
    w.rt.close();
  });

  test('a bot homeserver cannot turn its bot into a person to dodge removal', async () => {
    const w = await world('ADMIN');
    const b = await signerFor('b');
    const typing = await b.send('a', 'POST', `/federation/channels/${w.channel.id}/typing`, {
      user: userPayload(w.bot.bot, { isBot: false }),
    });
    expect(typing.status).toBe(200);
    const users = await call(w.owner, 'GET', `/channel/${w.channel.id}/users`);
    expect(users.body.users.find((u: any) => u.username === w.bot.bot.username)).toMatchObject({
      isBot: true,
      role: 'ADMIN',
    });
    expect(
      (await call(w.owner, 'DELETE', `/guilds/${w.guild.id}/bots/${await botIdOnA(w)}`)).status
    ).toBe(200);
    w.rt.close();
  });

  test('a homeserver cannot turn its person into a bot either', async () => {
    const owner = await signup('a');
    const { guild, channel } = await createGuild(owner);
    const person = await signup('b');
    await joinRemote(owner, guild.id, person);
    const b = await signerFor('b');
    await b.send('a', 'POST', `/federation/channels/${channel.id}/typing`, {
      user: userPayload(person.user, { isBot: true }),
    });
    const sent = await b.send('a', 'POST', `/federation/channels/${channel.id}/messages/send`, {
      user: userPayload(person.user, { isBot: true }),
      content: null,
      nonce: 'n1',
      embeds: [{ title: 'not a bot' }],
    });
    expect(sent.status).toBe(400);
    expect(sent.json.error).toBe('Only bots can send embeds or buttons');
    // nor be added to a guild as one
    const added = await addBot(owner, guild.id, person.user);
    expect(added.status).toBe(400);
    expect(added.body.error).toBe('That user is not a bot');
  });

  test('a remote ADMIN bot cannot add or remove bots', async () => {
    const w = await world('ADMIN');
    const b = await signerFor('b');
    const other = await createBot(w.botOwner);
    const added = await b.send('a', 'POST', `/federation/guilds/${w.guild.id}/bots`, {
      user: userPayload(w.bot.bot, { isBot: true }),
      username: other.bot.username,
      homeserver: anchors.b.homeserver,
      role: 'MEMBER',
    });
    expect(added.status).toBe(403);
    expect((await call(other, 'GET', '/guilds/list')).body.guilds).toEqual([]);

    const memberBot = await createBot(w.botOwner);
    expect((await addBot(w.owner, w.guild.id, memberBot.bot)).status).toBe(200);
    const users = await call(w.owner, 'GET', `/channel/${w.channel.id}/users`);
    const memberBotId = users.body.users.find(
      (u: any) => u.username === memberBot.bot.username
    ).userId;
    const removed = await b.send('a', 'POST', `/federation/guilds/${w.guild.id}/bots/remove`, {
      user: userPayload(w.bot.bot, { isBot: true }),
      userId: memberBotId,
    });
    expect(removed.status).toBe(403);
    w.rt.close();
  });

  test('a bot that does not exist leaves no user row behind on the host', async () => {
    const owner = await signup('a');
    const { guild } = await createGuild(owner);
    const ghost = { username: `ghost${Date.now()}`, homeserver: anchors.b.homeserver };
    expect((await addBot(owner, guild.id, ghost)).status).toBe(404);
    const rows = await pg('a')`SELECT id FROM "user" WHERE username = ${ghost.username}`;
    expect(rows).toHaveLength(0);
    // and names that can't be anyone's are refused before anything is asked
    const badName = await addBot(owner, guild.id, { ...ghost, username: 'no/slash' });
    expect(badName.status).toBe(422);
  });

  test('responses to an interaction need the bot it went to', async () => {
    const w = await world();
    const person = await signup('a');
    await call(w.owner, 'POST', `/guilds/${w.guild.id}/invites`, {});
    const { body } = await call(w.owner, 'POST', `/guilds/${w.guild.id}/invites`, {});
    await call(person, 'POST', '/invite/accept', { code: body.invite.code });
    const botId = await botIdOnA(w);
    const started = call(person, 'POST', '/interactions', {
      channelId: w.channel.id,
      type: 'command',
      botId,
      name: 'ping',
      options: [],
    });
    const event = await w.rt.waitFor('interaction.created', () => true, 15_000);
    const i = event.data;

    // C claims to be the bot (a B user): the signature is C's, so it is refused outright
    const c = await signerFor('c');
    const asBot = {
      user: userPayload(w.bot.bot, { isBot: true }),
      token: i.token,
      action: 'callback',
      body: { type: 'deferred' },
    };
    expect(
      (await c.send('a', 'POST', `/federation/interactions/${i.id}/respond`, asBot)).status
    ).toBe(401);
    // a C bot with the right token is still not the bot it went to
    const cBotOwner = await signup('c');
    const cBot = await createBot(cBotOwner);
    const asOther = { ...asBot, user: userPayload(cBot.bot, { isBot: true }) };
    expect(
      (await c.send('a', 'POST', `/federation/interactions/${i.id}/respond`, asOther)).status
    ).toBe(404);
    // a fake homeserver can't either
    expect((await fakeSend(1, 'a', `/federation/interactions/${i.id}/respond`, asBot)).status).toBe(
      401
    );

    expect(
      (await respond(w.bot, i, 'callback', { type: 'message', data: { content: 'real' } })).status
    ).toBe(200);
    expect((await started).status).toBe(200);
    w.rt.close();
  });
});
