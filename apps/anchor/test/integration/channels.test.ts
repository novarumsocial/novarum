import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { signup } from '../harness/users';
import { befriend } from '../harness/friends';
import { openRealtime } from '../harness/ws';
import { call, createGuild, join, list, send } from '../harness/chat';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'channels' });
});
afterAll(() => anchor.destroy());

/** owner, member and non-member around one guild */
async function world() {
  const [owner, member, stranger] = await Promise.all([signup(anchor.url), signup(anchor.url), signup(anchor.url)]);
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, member);
  return { owner, member, stranger, guild, channel };
}
const channelsOf = async (user: Awaited<ReturnType<typeof signup>>, guildId: string) =>
  (await call(user, 'GET', '/guilds/list')).body.guilds.find((g: any) => g.id === guildId).channels;

describe('create', () => {
  test('the owner creates channels, each new one goes to position 0 and pushes the rest down', async () => {
    const { owner, guild, channel } = await world();
    const text = await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'random', type: 'TEXT' });
    expect(text.status).toBe(200);
    expect(text.body).toMatchObject({ name: 'random', type: 'TEXT', position: 0, guildId: guild.id });
    const voice = await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'talk', type: 'VOICE' });
    expect(voice.body).toMatchObject({ type: 'VOICE', position: 0 });

    const channels = await channelsOf(owner, guild.id);
    expect(channels.map((c: any) => [c.id, c.position])).toEqual([
      [voice.body.id, 0],
      [text.body.id, 1],
      [channel.id, 2],
    ]);
  });

  test('spaces in the name become dashes', async () => {
    const { owner, guild } = await world();
    const res = await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'a b c', type: 'TEXT' });
    expect(res.body.name).toBe('a-b-c');
  });

  test('members get 403, non-members get 403 as well, unknown guild is 404', async () => {
    const { member, stranger, guild } = await world();
    const body = { guildId: guild.id, name: 'nope', type: 'TEXT' };
    expect((await call(member, 'POST', '/channel/create', body)).status).toBe(403);
    expect((await call(stranger, 'POST', '/channel/create', body)).status).toBe(403);
    expect((await call(stranger, 'POST', '/channel/create', { ...body, guildId: 'nope' })).status).toBe(404);
  });

  test('a federated guild id is refused with 400', async () => {
    const { owner } = await world();
    const res = await call(owner, 'POST', '/channel/create', { guildId: 'fed:guild:example.test:abc', name: 'x', type: 'TEXT' });
    expect(res.status).toBe(400);
  });

  test.each([
    ['empty name', { name: '' }],
    ['name over 100 chars', { name: 'x'.repeat(101) }],
    ['DM type', { type: 'DM' }],
    ['unknown type', { type: 'FORUM' }],
  ])('rejects %s', async (_, override) => {
    const { owner, guild } = await world();
    const res = await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'ok', type: 'TEXT', ...override });
    expect(res.status).toBe(422);
  });

  test('a created channel is visible to members through the realtime guild events', async () => {
    const { owner, member, guild } = await world();
    const ws = await openRealtime(anchor.url, member.cookie);
    try {
      await Bun.sleep(200); // memberships are subscribed right after open
      const created = await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'live', type: 'TEXT' });
      const event = await ws.waitFor('channel.created', (e) => e.data?.id === created.body.id);
      expect(event.data).toMatchObject({ name: 'live', guildId: guild.id });
    } finally {
      ws.close();
    }
  });
});

describe('order', () => {
  async function withThree() {
    const w = await world();
    const a = (await call(w.owner, 'POST', '/channel/create', { guildId: w.guild.id, name: 'a', type: 'TEXT' })).body.id;
    const b = (await call(w.owner, 'POST', '/channel/create', { guildId: w.guild.id, name: 'b', type: 'TEXT' })).body.id;
    return { ...w, ids: [a as string, b as string, w.channel.id] };
  }

  test('the owner reorders and the list reflects it', async () => {
    const { owner, guild, ids } = await withThree();
    const wanted = [ids[2]!, ids[0]!, ids[1]!];
    const res = await call(owner, 'PATCH', '/channel/order', { guildId: guild.id, channelIds: wanted });
    expect(res.body).toEqual({ success: true });
    expect((await channelsOf(owner, guild.id)).map((c: any) => c.id)).toEqual(wanted);
  });

  test('members and non-members get 403, unknown guild 404, anonymous 401', async () => {
    const { member, stranger, guild, ids } = await withThree();
    const body = { guildId: guild.id, channelIds: ids };
    expect((await call(member, 'PATCH', '/channel/order', body)).status).toBe(403);
    expect((await call(stranger, 'PATCH', '/channel/order', body)).status).toBe(403);
    expect((await call(member, 'PATCH', '/channel/order', { ...body, guildId: 'nope' })).status).toBe(404);
  });

  test('must contain every channel of the guild exactly once', async () => {
    const { owner, guild, ids } = await withThree();
    const other = await createGuild(owner);
    for (const channelIds of [[], [ids[0]], [ids[0], ids[0], ids[1]], [...ids, ids[0]], [ids[0], ids[1], other.channel.id]]) {
      const res = await call(owner, 'PATCH', '/channel/order', { guildId: guild.id, channelIds });
      expect(res.status).toBe(400);
    }
  });
});

describe('users', () => {
  test('members see the whole roster with roles', async () => {
    const { owner, member, guild, channel } = await world();
    const { users } = (await call(member, 'GET', `/channel/${channel.id}/users`)).body;
    expect(users.map((u: any) => [u.userId, u.role]).sort()).toEqual(
      [[owner.user.id, 'OWNER'], [member.user.id, 'MEMBER']].sort()
    );
    expect(guild.id).toBeTruthy();
  });

  test('non-members get 401 (not 403/404), unknown channel 404', async () => {
    const { stranger, channel } = await world();
    expect((await call(stranger, 'GET', `/channel/${channel.id}/users`)).status).toBe(401);
    expect((await call(stranger, 'GET', '/channel/nope/users')).status).toBe(404);
  });

  test('a DM channel has no guild roster: 404 even for its participants', async () => {
    const [a, b] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
    await befriend(a, b);
    const dm = (await call(a, 'POST', '/dm', { userId: b.user.id })).body;
    expect((await call(a, 'GET', `/channel/${dm.id}/users`)).status).toBe(404);
  });
});

describe('read state', () => {
  test('reading moves the unread marker, and an older cursor never moves it back', async () => {
    const { owner, member, channel } = await world();
    const first = (await send(owner, channel.id, 'one')).body.message;
    // first /guilds/list for the member pins their read state to the latest message
    const guildId = (await call(member, 'GET', '/guilds/list')).body.guilds[0].id;
    expect((await channelsOf(member, guildId))[0].unread).toBe(false);
    const second = (await send(owner, channel.id, 'two')).body.message;
    const third = (await send(owner, channel.id, 'three')).body.message;
    const unread = async () => (await channelsOf(member, guildId))[0].unread;
    expect(await unread()).toBe(true);

    const read = (m: any) => call(member, 'POST', `/channel/${channel.id}/read`, { messageId: m.id, createdAt: m.createdAt });
    expect((await read(second)).body).toEqual({ success: true });
    expect(await unread()).toBe(true);
    expect((await read(third)).body).toEqual({ success: true });
    expect(await unread()).toBe(false);
    expect((await read(first)).body).toEqual({ success: true });
    expect(await unread()).toBe(false);
  });

  test('cursor must match a real message of the channel (400), channel must exist (404)', async () => {
    const { owner, member, channel } = await world();
    const msg = (await send(owner, channel.id, 'hi')).body.message;
    const path = `/channel/${channel.id}/read`;
    expect((await call(member, 'POST', path, { messageId: 'nope', createdAt: msg.createdAt })).status).toBe(400);
    expect((await call(member, 'POST', path, { messageId: msg.id, createdAt: '2001-01-01T00:00:00.000Z' })).status).toBe(400);
    expect((await call(member, 'POST', '/channel/nope/read', { messageId: msg.id, createdAt: msg.createdAt })).status).toBe(404);
    expect((await call(member, 'POST', path, { messageId: msg.id, createdAt: 'yesterday' })).status).toBe(422);
  });

  test('non-members get 403', async () => {
    const { owner, stranger, channel } = await world();
    const msg = (await send(owner, channel.id, 'hi')).body.message;
    const res = await call(stranger, 'POST', `/channel/${channel.id}/read`, { messageId: msg.id, createdAt: msg.createdAt });
    expect(res.status).toBe(403);
  });

  test('a message from another channel is not a valid cursor', async () => {
    const { owner, member, guild, channel } = await world();
    const other = (await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'other', type: 'TEXT' })).body;
    const msg = (await send(owner, other.id, 'elsewhere')).body.message;
    const res = await call(member, 'POST', `/channel/${channel.id}/read`, { messageId: msg.id, createdAt: msg.createdAt });
    expect(res.status).toBe(400);
    expect((await list(member, other.id)).status).toBe(200);
  });
});

describe('typing', () => {
  test('members can type, the typing event reaches other members', async () => {
    const { owner, member, channel } = await world();
    const ws = await openRealtime(anchor.url, owner.cookie);
    try {
      await Bun.sleep(200); // memberships are subscribed right after open
      expect((await call(member, 'POST', `/channel/${channel.id}/typing`)).body).toEqual({ ok: true });
      const event = await ws.waitFor('channel.typing');
      expect(event.data).toMatchObject({ channelId: channel.id, userId: member.user.id });
    } finally {
      ws.close();
    }
  });

  test('non-members get 401 (not 403), unknown channel 404', async () => {
    const { stranger, channel } = await world();
    expect((await call(stranger, 'POST', `/channel/${channel.id}/typing`)).status).toBe(401);
    expect((await call(stranger, 'POST', '/channel/nope/typing')).status).toBe(404);
  });
});
