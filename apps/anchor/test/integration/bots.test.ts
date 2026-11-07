import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { cookieName, signup } from '../harness/users';
import { anonymous, call, createGuild, join, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { addBot, botActor, connectBot, createBot } from '../harness/bots';
import { connect as pg } from '../harness/db';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'bots' });
});
afterAll(() => anchor.destroy());

const sql = async (query: string) => {
  const db = pg(anchor.databaseUrl);
  try {
    return await db.unsafe(query);
  } finally {
    await db.close();
  }
};

describe('bot accounts', () => {
  test('creating a bot returns a token that authenticates as the bot', async () => {
    const owner = await signup(anchor.url);
    const created = await call(owner, 'POST', '/developers/bots', {
      username: `b${Date.now().toString(36)}`,
      displayName: 'Helper',
    });
    expect(created.status).toBe(200);
    expect(created.body.bot).toMatchObject({ isBot: true, public: true, displayName: 'Helper' });
    expect(created.body.token).toMatch(/^[^.]+\.[^.]+$/);

    const me = await call(botActor(anchor.url, created.body.token), 'GET', '/bots/@me');
    expect(me.status).toBe(200);
    expect(me.body.bot.userId).toBe(created.body.bot.userId);

    const list = await call(owner, 'GET', '/developers/bots');
    expect(list.body.bots.map((b: any) => b.userId)).toEqual([created.body.bot.userId]);
  });

  test('a bot token is useless as a cookie, and a person session is useless as a bot token', async () => {
    const owner = await signup(anchor.url);
    const { token } = await createBot(owner);
    const asCookie = await fetch(`${anchor.url}/guilds/list`, {
      headers: { cookie: `${cookieName}=${token}` },
    });
    expect(asCookie.status).toBe(401);
    expect(
      (await fetch(`${anchor.url}/auth/me`, { headers: { cookie: `${cookieName}=${token}` } }))
        .status
    ).toBe(401);

    expect((await call(botActor(anchor.url, owner.cookie), 'GET', '/guilds/list')).status).toBe(
      401
    );
    expect((await call(botActor(anchor.url, owner.cookie), 'GET', '/bots/@me')).status).toBe(401);
    // wrong scheme and garbage tokens
    for (const authorization of [
      `Bearer ${token}`,
      'Bot ',
      'Bot a.b',
      `Bot ${token}x`,
      `bot ${token}`,
    ]) {
      const res = await fetch(`${anchor.url}/guilds/list`, { headers: { authorization } });
      expect(res.status, authorization).toBe(401);
    }
    // a bot header wins over a valid person cookie, so a broken token can't fall back to the cookie
    const mixed = await fetch(`${anchor.url}/guilds/list`, {
      headers: { authorization: 'Bot nope.nope', cookie: `${cookieName}=${owner.cookie}` },
    });
    expect(mixed.status).toBe(401);
  });

  test('usernames are validated and shared with people', async () => {
    const owner = await signup(anchor.url);
    expect(
      (await call(owner, 'POST', '/developers/bots', { username: owner.user.username })).status
    ).toBe(409);
    for (const username of ['a', 'has space', 'x'.repeat(33), 'emoji😀', '']) {
      const res = await call(owner, 'POST', '/developers/bots', { username });
      expect([400, 422], username).toContain(res.status);
    }
    const { bot } = await createBot(owner);
    expect((await call(owner, 'POST', '/developers/bots', { username: bot.username })).status).toBe(
      409
    );
  });

  test('people only see and manage their own bots', async () => {
    const [owner, other] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    const { bot } = await createBot(owner);
    for (const [method, path, body] of [
      ['GET', `/developers/bots/${bot.userId}`],
      ['PATCH', `/developers/bots/${bot.userId}`, { public: false }],
      ['POST', `/developers/bots/${bot.userId}/token`],
      ['DELETE', `/developers/bots/${bot.userId}`],
    ] as const) {
      expect((await call(other, method, path, body)).status, `${method} ${path}`).toBe(404);
      expect((await call(anonymous(anchor.url), method, path, body)).status).toBe(401);
    }
    expect((await call(other, 'GET', '/developers/bots')).body.bots).toEqual([]);
  });

  test('bots cannot use the developer panel', async () => {
    const owner = await signup(anchor.url);
    const bot = await createBot(owner);
    expect((await call(bot, 'GET', '/developers/bots')).status).toBe(401);
    expect((await call(bot, 'POST', '/developers/bots', { username: 'sneaky' })).status).toBe(401);
  });

  test('editing the profile and public flag', async () => {
    const owner = await signup(anchor.url);
    const { bot } = await createBot(owner);
    const res = await call(owner, 'PATCH', `/developers/bots/${bot.userId}`, {
      displayName: 'New name',
      about: 'I help',
      public: false,
    });
    expect(res.body.bot).toMatchObject({ displayName: 'New name', about: 'I help', public: false });
    expect(
      (await call(owner, 'PATCH', `/developers/bots/${bot.userId}`, { about: 'x'.repeat(513) }))
        .status
    ).not.toBe(200);
  });

  test('regenerating the token revokes the old one and closes its sockets', async () => {
    const owner = await signup(anchor.url);
    const { bot, token } = await createBot(owner);
    const rt = await connectBot(anchor.url, token);
    expect(rt.closed).toBeNull();

    const res = await call(owner, 'POST', `/developers/bots/${bot.userId}/token`);
    expect(res.status).toBe(200);
    expect(res.body.token).not.toBe(token);
    await rt.waitClosed();
    expect((await call(botActor(anchor.url, token), 'GET', '/bots/@me')).status).toBe(401);
    expect((await call(botActor(anchor.url, res.body.token), 'GET', '/bots/@me')).status).toBe(200);
  });

  test('the realtime socket refuses a bad bot token', async () => {
    const rt = await connectBot(anchor.url, 'bad.token');
    await rt.waitClosed();
    expect(rt.closed!.code).toBe(1008);
  });

  test('bots cannot create guilds, accept invites, open DMs, or use friends', async () => {
    const [owner, person] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    const bot = await createBot(owner);
    const { guild } = await createGuild(owner);
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    expect((await call(bot, 'POST', '/guilds/create', { name: 'x' })).status).toBe(403);
    expect((await call(bot, 'POST', '/invite/accept', { code: body.invite.code })).status).toBe(
      401
    );
    expect((await call(bot, 'POST', '/dm', { userId: person.user.id })).status).toBe(401);
    expect((await call(bot, 'GET', '/friends')).status).toBe(401);
    expect((await call(bot, 'POST', `/guilds/${guild.id}/invites`, {})).status).toBe(403);
    // and nobody can open a DM with a bot
    expect((await call(person, 'POST', '/dm', { userId: bot.bot.userId })).status).not.toBe(200);
  });

  test('the bot cap and the off switch', async () => {
    const capped = await spawnAnchor({ name: 'bots-cap', config: { bots: { max_per_user: 1 } } });
    const off = await spawnAnchor({ name: 'bots-off', config: { bots: { enabled: false } } });
    try {
      const owner = await signup(capped.url);
      await createBot(owner);
      const second = await call(owner, 'POST', '/developers/bots', { username: 'secondbot' });
      expect(second.status).toBe(403);
      const offOwner = await signup(off.url);
      expect((await call(offOwner, 'POST', '/developers/bots', { username: 'nope' })).status).toBe(
        403
      );
    } finally {
      await Promise.all([capped.destroy(), off.destroy()]);
    }
  });

  test('deleting a bot kills its token, frees the username and takes it out of its guilds', async () => {
    const owner = await signup(anchor.url);
    const { guild, channel } = await createGuild(owner);
    const bot = await createBot(owner);
    expect((await addBot(owner, guild.id, bot.bot)).status).toBe(200);
    expect((await send(bot as any, channel.id, 'before')).status).toBe(200);

    expect((await call(owner, 'DELETE', `/developers/bots/${bot.bot.userId}`)).status).toBe(200);
    expect((await call(bot, 'GET', '/bots/@me')).status).toBe(401);
    const users = await call(owner, 'GET', `/channel/${channel.id}/users`);
    expect(users.body.users.map((u: any) => u.userId)).not.toContain(bot.bot.userId);
    // its old message is still there
    const messages = await call(
      owner,
      'GET',
      `/message/list?channelId=${channel.id}&cursor=0&amount=50`
    );
    expect(messages.body.messages.map((m: any) => m.content)).toContain('before');
    expect(
      (await call(owner, 'POST', '/developers/bots', { username: bot.bot.username })).status
    ).toBe(200);
  });
});

describe('slash command registration', () => {
  const command = { name: 'ping', description: 'Pong!', options: [] };

  test('replacing and reading the global commands', async () => {
    const owner = await signup(anchor.url);
    const bot = await createBot(owner);
    const put = await call(bot, 'PUT', '/bots/@me/commands', {
      commands: [
        command,
        {
          name: 'echo',
          description: 'Says it back',
          options: [{ name: 'text', description: 'What to say', type: 'string', required: true }],
        },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.commands.map((c: any) => c.name)).toEqual(['ping', 'echo']);
    expect((await call(bot, 'GET', '/bots/@me/commands')).body.commands).toHaveLength(2);
    // the developer panel shows them
    expect(
      (await call(owner, 'GET', `/developers/bots/${bot.bot.userId}`)).body.bot.commands
    ).toHaveLength(2);
    expect((await call(bot, 'PUT', '/bots/@me/commands', { commands: [] })).body.commands).toEqual(
      []
    );
  });

  test('invalid command lists are refused', async () => {
    const owner = await signup(anchor.url);
    const bot = await createBot(owner);
    const option = (o: object) => ({ name: 'o', description: 'd', type: 'string', ...o });
    const invalid = [
      [command, command],
      [{ ...command, name: 'Has Caps' }],
      [{ ...command, name: 'x'.repeat(33) }],
      [{ ...command, description: '' }],
      [
        {
          ...command,
          options: [option({ required: false }), option({ name: 'p', required: true })],
        },
      ],
      [{ ...command, options: [option({}), option({})] }],
      [{ ...command, options: [option({ type: 'channel' })] }],
      [
        {
          ...command,
          options: [option({ autocomplete: true, choices: [{ name: 'a', value: 'a' }] })],
        },
      ],
      Array.from({ length: 101 }, (_, i) => ({ ...command, name: `c${i}` })),
    ];
    for (const commands of invalid) {
      const res = await call(bot, 'PUT', '/bots/@me/commands', { commands });
      expect([400, 422], JSON.stringify(commands).slice(0, 80)).toContain(res.status);
    }
    expect(
      (await call(anonymous(anchor.url), 'PUT', '/bots/@me/commands', { commands: [] })).status
    ).toBe(401);
    expect((await call(owner, 'PUT', '/bots/@me/commands', { commands: [] })).status).toBe(401);
  });
});

describe('adding bots to guilds', () => {
  test('the owner adds a public bot; it gets guild.created and the guild sees member.joined', async () => {
    const [owner, person] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    const { guild, channel } = await createGuild(owner);
    await join(owner, guild.id, person);
    const bot = await createBot(person);
    const botRt = await connectBot(anchor.url, bot.token);
    const ownerRt = await connect(owner);

    expect((await addBot(owner, guild.id, bot.bot)).status).toBe(200);
    const created = await botRt.waitFor('guild.created', (e) => e.data.id === guild.id);
    expect(created.data.channels.map((c: any) => c.id)).toContain(channel.id);
    const joined = await ownerRt.waitFor(
      'member.joined',
      (e) => e.data.user.userId === bot.bot.userId
    );
    expect(joined.data.user.isBot).toBe(true);

    // the bot subscribes like a client does, then gets the guild's messages
    botRt.send({ type: 'subscribe.guild', guildId: guild.id });
    await botRt.waitFor('voice.states.snapshot', (e) => e.data.guildIds?.includes(guild.id));
    await send(person, channel.id, 'hello bot');
    const message = await botRt.waitFor('message.created', (e) => e.data.content === 'hello bot');
    expect(message.data.channelId).toBe(channel.id);

    // and it can talk
    const sent = await send(bot as any, channel.id, 'hello human');
    expect(sent.status).toBe(200);
    expect(sent.body.message.author.isBot).toBe(true);
    expect((await addBot(owner, guild.id, bot.bot)).status).toBe(409);
    botRt.close();
    ownerRt.close();
  });

  test('members cannot add bots; ADMIN bots can only be added by the owner', async () => {
    const [owner, member, admin] = await Promise.all([
      signup(anchor.url),
      signup(anchor.url),
      signup(anchor.url),
    ]);
    const { guild } = await createGuild(owner);
    await join(owner, guild.id, member);
    await join(owner, guild.id, admin);
    await sql(`UPDATE guild_member SET role = 'ADMIN' WHERE "userId" = '${admin.user.id}'`);
    const bot = await createBot(owner);

    expect((await addBot(member, guild.id, bot.bot)).status).toBe(403);
    expect((await addBot(admin, guild.id, bot.bot, 'ADMIN')).status).toBe(403);
    expect((await addBot(admin, guild.id, bot.bot)).status).toBe(200);
    // an admin can't take out an ADMIN bot either
    const adminBot = await createBot(owner);
    expect((await addBot(owner, guild.id, adminBot.bot, 'ADMIN')).status).toBe(200);
    expect(
      (await call(admin, 'DELETE', `/guilds/${guild.id}/bots/${adminBot.bot.userId}`)).status
    ).toBe(403);
    expect(
      (await call(member, 'DELETE', `/guilds/${guild.id}/bots/${bot.bot.userId}`)).status
    ).toBe(403);
    expect((await call(admin, 'DELETE', `/guilds/${guild.id}/bots/${bot.bot.userId}`)).status).toBe(
      200
    );
  });

  test('outsiders, anonymous people and bots cannot add bots', async () => {
    const [owner, outsider] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    const { guild } = await createGuild(owner);
    const bot = await createBot(owner);
    const otherBot = await createBot(owner);
    await addBot(owner, guild.id, otherBot.bot, 'ADMIN');
    expect((await addBot(outsider, guild.id, bot.bot)).status).toBe(403);
    expect((await addBot(anonymous(anchor.url), guild.id, bot.bot)).status).toBe(401);
    expect((await addBot(otherBot, guild.id, bot.bot)).status).toBe(401);
    expect((await addBot(owner, 'nope', bot.bot)).status).toBe(404);
  });

  test('a private bot can only be added by its owner', async () => {
    const [botOwner, guildOwner] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    const bot = await createBot(botOwner, { public: false });
    const { guild } = await createGuild(guildOwner);
    expect((await addBot(guildOwner, guild.id, bot.bot)).status).toBe(403);

    const own = await createGuild(botOwner);
    expect((await addBot(botOwner, own.guild.id, bot.bot)).status).toBe(200);
  });

  test('only bots can be added, and unknown bots are 404', async () => {
    const [owner, person] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    const { guild } = await createGuild(owner);
    expect((await addBot(owner, guild.id, person.user)).status).toBe(404);
    expect(
      (await addBot(owner, guild.id, { username: 'nobody', homeserver: 'localhost' })).status
    ).toBe(404);
  });

  test('removing a bot sends guild.deleted and stops its guild events', async () => {
    const owner = await signup(anchor.url);
    const { guild, channel } = await createGuild(owner);
    const bot = await createBot(owner);
    await addBot(owner, guild.id, bot.bot);
    const botRt = await connectBot(anchor.url, bot.token);
    const ownerRt = await connect(owner);

    expect((await call(owner, 'DELETE', `/guilds/${guild.id}/bots/${bot.bot.userId}`)).status).toBe(
      200
    );
    await botRt.waitFor('guild.deleted', (e) => e.data.guildId === guild.id);
    await ownerRt.waitFor('member.left', (e) => e.data.userId === bot.bot.userId);
    await send(owner, channel.id, 'secret after removal');
    await Bun.sleep(300);
    expect(botRt.events.some((e) => e.data?.content === 'secret after removal')).toBe(false);
    expect((await send(bot as any, channel.id, 'still here?')).status).toBe(403);
    // people can't be removed through this route
    expect((await call(owner, 'DELETE', `/guilds/${guild.id}/bots/${owner.user.id}`)).status).toBe(
      404
    );
    botRt.close();
    ownerRt.close();
  });

  test('a bot can leave a guild', async () => {
    const owner = await signup(anchor.url);
    const { guild } = await createGuild(owner);
    const bot = await createBot(owner);
    await addBot(owner, guild.id, bot.bot);
    expect((await call(bot, 'POST', `/bots/@me/guilds/${guild.id}/leave`)).status).toBe(200);
    expect((await call(bot, 'POST', `/bots/@me/guilds/${guild.id}/leave`)).status).toBe(404);
    expect((await call(bot, 'GET', '/guilds/list')).body.guilds).toEqual([]);
  });

  test('ADMIN bots manage channels and post in owner-only channels; MEMBER bots do not', async () => {
    const [owner, member] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    const { guild, channel } = await createGuild(owner);
    await join(owner, guild.id, member);
    const admin = await createBot(owner);
    const plain = await createBot(owner);
    await addBot(owner, guild.id, admin.bot, 'ADMIN');
    await addBot(owner, guild.id, plain.bot);
    const message = (await send(member, channel.id, 'spam')).body.message;

    const create = (actor: any) =>
      call(actor, 'POST', '/channel/create', { guildId: guild.id, name: 'botchan', type: 'TEXT' });
    expect((await create(plain)).status).toBe(403);
    expect((await create(admin)).status).toBe(200);
    await call(owner, 'PATCH', `/channel/${channel.id}`, { ownerOnly: true });
    expect((await send(plain as any, channel.id, 'x')).status).toBe(403);
    expect((await send(admin as any, channel.id, 'announcement')).status).toBe(200);
    // nobody but the author deletes a message, bots included
    const del = (actor: any) =>
      call(actor, 'POST', '/message/delete', { channelId: channel.id, messageId: message.id });
    expect((await del(admin)).status).toBe(403);
    // the guild list says so
    const list = await call(admin, 'GET', '/guilds/list');
    expect(list.body.guilds[0].canManageChannels).toBe(true);
  });

  test('looking bots up', async () => {
    const owner = await signup(anchor.url);
    const { bot } = await createBot(owner);
    const found = await call(
      owner,
      'GET',
      `/bots/lookup?username=${bot.username}&homeserver=${bot.homeserver}`
    );
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      public: true,
      user: { username: bot.username, isBot: true },
    });
    expect(
      (
        await call(
          owner,
          'GET',
          `/bots/lookup?username=${owner.user.username}&homeserver=localhost`
        )
      ).status
    ).toBe(404);
    expect(
      (
        await call(
          anonymous(anchor.url),
          'GET',
          `/bots/lookup?username=${bot.username}&homeserver=localhost`
        )
      ).status
    ).toBe(401);
  });
});
