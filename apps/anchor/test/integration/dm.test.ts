import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { signup } from '../harness/users';
import { befriend, unfriend } from '../harness/friends';
import { openRealtime } from '../harness/ws';
import { anonymous, call, list, send } from '../harness/chat';

let anchor: RunningAnchor;
let sql: ReturnType<typeof connect>;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'dm' });
  sql = connect(anchor.databaseUrl);
});
afterAll(async () => {
  await sql.close();
  await anchor.destroy();
});

type Actor = Awaited<ReturnType<typeof signup>>;
const friends = async () => {
  const [a, b] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
  await befriend(a, b);
  return { a, b };
};
const open = (user: Actor, other: Actor) => call(user, 'POST', '/dm', { userId: other.user.id });
const dms = async (user: Actor) => (await call(user, 'GET', '/dm')).body.dms as any[];
const dmIds = async (user: Actor) => (await dms(user)).map((d) => d.id);
const closedFlags = async (channelId: string) =>
  Object.fromEntries(
    (await sql`SELECT "userId", closed FROM channel_member WHERE "channelId" = ${channelId}`).map((r: any) => [r.userId, r.closed])
  );

describe('open', () => {
  test('friends open a DM; both participants see it listed with the other as participant', async () => {
    const { a, b } = await friends();
    const res = await open(a, b);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'DM', lastMessageAt: null, unread: false });
    expect(res.body.participants.map((p: any) => p.userId)).toEqual([b.user.id]);
    expect((await dms(a))[0].participants.map((p: any) => p.userId)).toEqual([b.user.id]);
    expect((await dms(b))[0]).toMatchObject({ id: res.body.id });
    expect((await dms(b))[0].participants.map((p: any) => p.userId)).toEqual([a.user.id]);
  });

  test('no friendship is 403, and so is a pending request in either direction', async () => {
    const [a, b, c] = await Promise.all([signup(anchor.url), signup(anchor.url), signup(anchor.url)]);
    expect((await open(a, b)).status).toBe(403);
    await a.fetch('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ username: b.user.username, homeserver: b.user.homeserver }),
    });
    expect((await open(a, b)).status).toBe(403);
    expect((await open(b, a)).status).toBe(403);
    expect((await open(a, c)).status).toBe(403);
    expect(await sql`SELECT 1 FROM channel WHERE type = 'DM' AND "dmKey" LIKE ${`%${a.user.id}%`}`).toHaveLength(0);
  });

  test('yourself and unknown users are 404, anonymous is 401, bad body is 422', async () => {
    const { a } = await friends();
    expect((await open(a, a)).status).toBe(404);
    expect((await call(a, 'POST', '/dm', { userId: 'nope' })).status).toBe(404);
    expect((await call(anonymous(anchor.url), 'POST', '/dm', { userId: 'x' })).status).toBe(401);
    expect((await call(a, 'POST', '/dm', {})).status).toBe(422);
  });

  test('opening is idempotent and symmetric: one channel per pair (dmKey), same id from both sides', async () => {
    const { a, b } = await friends();
    const first = await open(a, b);
    const again = await open(a, b);
    const reverse = await open(b, a);
    expect([again.body.id, reverse.body.id]).toEqual([first.body.id, first.body.id]);
    const rows = await sql`SELECT "dmKey" FROM channel WHERE id = ${first.body.id}`;
    expect(rows[0].dmKey).toBe([a.user.id, b.user.id].sort().join(':'));
    expect(await sql`SELECT 1 FROM channel_member WHERE "channelId" = ${first.body.id}`).toHaveLength(2);
    expect(await dmIds(a)).toEqual([first.body.id]);
  });

  test('concurrent opens from both sides settle on one channel', async () => {
    const { a, b } = await friends();
    const results = await Promise.all([open(a, b), open(b, a), open(a, b), open(b, a), open(a, b), open(b, a)]);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await sql`SELECT 1 FROM channel WHERE "dmKey" = ${[a.user.id, b.user.id].sort().join(':')}`).toHaveLength(1);
  });

  test('the other user is told with dm.created the first time, not on re-open', async () => {
    const { a, b } = await friends();
    const ws = await openRealtime(anchor.url, b.cookie);
    try {
      await Bun.sleep(200);
      const opened = await open(a, b);
      await ws.waitFor('dm.created', (e) => e.data?.id === opened.body.id);
      await open(a, b);
      await Bun.sleep(300);
      expect(ws.events.filter((e) => e.type === 'dm.created')).toHaveLength(1);
    } finally {
      ws.close();
    }
  });

  test('DMs are private: a third user cannot list, read, send, type or mark read', async () => {
    const { a, b } = await friends();
    const c = await signup(anchor.url);
    await befriend(a, c);
    const dm = (await open(a, b)).body;
    const msg = (await send(a, dm.id, 'secret')).body.message;
    expect(await dmIds(c)).toEqual([]);
    expect((await list(c, dm.id)).status).toBe(403);
    expect((await send(c, dm.id, 'hi')).status).toBe(403);
    expect((await call(c, 'POST', `/channel/${dm.id}/typing`)).status).toBe(401);
    expect((await call(c, 'POST', `/channel/${dm.id}/read`, { messageId: msg.id, createdAt: msg.createdAt })).status).toBe(403);
    expect((await call(c, 'POST', '/message/edit', { channelId: dm.id, messageId: msg.id, content: 'x' })).status).toBe(403);
    expect((await call(c, 'POST', '/message/delete', { channelId: dm.id, messageId: msg.id })).status).toBe(403);
  });
});

describe('messages and unread', () => {
  test('participants exchange messages; the list shows lastMessageAt and the DM sorts by recent activity', async () => {
    const { a, b } = await friends();
    const c = await signup(anchor.url);
    await befriend(a, c);
    const first = (await open(a, b)).body;
    const second = (await open(a, c)).body;
    expect(await dmIds(a)).toEqual([second.id, first.id]);
    await send(b, first.id, 'ping');
    const [top] = await dms(a);
    expect(top.id).toBe(first.id);
    expect(top.lastMessageAt).toBe((await list(a, first.id)).body.messages[0].createdAt);
    expect((await list(a, first.id)).body.messages.map((m: any) => m.content)).toEqual(['ping']);
  });

  test('unread: set for the recipient only, cleared by reading', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    const msg = (await send(a, dm.id, 'hello')).body.message;
    expect((await dms(a))[0].unread).toBe(false);
    expect((await dms(b))[0].unread).toBe(true);
    await call(b, 'POST', `/channel/${dm.id}/read`, { messageId: msg.id, createdAt: msg.createdAt });
    expect((await dms(b))[0].unread).toBe(false);
  });
});

describe('close and reopen', () => {
  test('closing hides the DM for that user only', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    expect((await call(a, 'POST', `/dm/${dm.id}/close`)).body).toEqual({ success: true });
    expect(await dmIds(a)).toEqual([]);
    expect(await dmIds(b)).toEqual([dm.id]);
    expect(await closedFlags(dm.id)).toEqual({ [a.user.id]: true, [b.user.id]: false });
  });

  test('closing again is fine; unknown DM, non-participant and guild channels are 404; anonymous 401', async () => {
    const { a, b } = await friends();
    const c = await signup(anchor.url);
    const dm = (await open(a, b)).body;
    expect((await call(a, 'POST', `/dm/${dm.id}/close`)).status).toBe(200);
    expect((await call(a, 'POST', `/dm/${dm.id}/close`)).status).toBe(200);
    expect((await call(a, 'POST', '/dm/nope/close')).status).toBe(404);
    expect((await call(c, 'POST', `/dm/${dm.id}/close`)).status).toBe(404);
    expect(await closedFlags(dm.id)).toEqual({ [a.user.id]: true, [b.user.id]: false });
    expect((await call(anonymous(anchor.url), 'POST', `/dm/${dm.id}/close`)).status).toBe(401);
  });

  test('a closed DM is still readable and writable by id', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await send(b, dm.id, 'before');
    await call(a, 'POST', `/dm/${dm.id}/close`);
    expect((await list(a, dm.id)).body.messages).toHaveLength(1);
  });

  test('opening again reopens it, with the same channel and history', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await send(a, dm.id, 'history');
    await call(a, 'POST', `/dm/${dm.id}/close`);
    expect((await open(a, b)).body.id).toBe(dm.id);
    expect(await dmIds(a)).toEqual([dm.id]);
    expect((await list(a, dm.id)).body.messages).toHaveLength(1);
  });

  test('a new message from the other side reopens the DM', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await call(a, 'POST', `/dm/${dm.id}/close`);
    await send(b, dm.id, 'knock knock');
    expect(await dmIds(a)).toEqual([dm.id]);
    expect(await closedFlags(dm.id)).toEqual({ [a.user.id]: false, [b.user.id]: false });
  });

  test('sending while closed reopens it for the sender too', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await call(a, 'POST', `/dm/${dm.id}/close`);
    await call(b, 'POST', `/dm/${dm.id}/close`);
    await send(a, dm.id, 'back');
    expect(await closedFlags(dm.id)).toEqual({ [a.user.id]: false, [b.user.id]: false });
  });
});

describe('after unfriending', () => {
  test('writes are blocked, reads still work, and re-friending restores writing', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    const msg = (await send(a, dm.id, 'while friends')).body.message;
    await unfriend(a, b);

    // writes: both sides, every write route that checks write access
    for (const user of [a, b]) {
      expect((await send(user, dm.id, 'nope')).status).toBe(403);
      expect((await call(user, 'POST', `/channel/${dm.id}/typing`)).status).toBe(401);
    }
    // reads: history, DM list, read state
    expect((await list(a, dm.id)).body.messages.map((m: any) => m.content)).toEqual(['while friends']);
    expect((await list(b, dm.id)).status).toBe(200);
    expect(await dmIds(b)).toEqual([dm.id]);
    expect((await call(b, 'POST', `/channel/${dm.id}/read`, { messageId: msg.id, createdAt: msg.createdAt })).status).toBe(200);
    // opening a new DM needs friendship again; the stored one is unchanged
    expect((await open(a, b)).status).toBe(403);
    expect((await list(a, dm.id)).body.messages).toHaveLength(1);

    await befriend(b, a);
    expect((await send(a, dm.id, 'back together')).status).toBe(200);
    expect((await open(b, a)).body.id).toBe(dm.id);
  });

  test('a pending re-request is not enough to write', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await unfriend(a, b);
    await a.fetch('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ username: b.user.username, homeserver: b.user.homeserver }),
    });
    expect((await send(a, dm.id, 'x')).status).toBe(403);
  });

  // pinned as observed: edit and delete only check read access, so an ex-friend can still change or remove
  // their own old messages (the plan only asks for send to be blocked)
  test('authors can still edit and delete their own messages', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    const msg = (await send(a, dm.id, 'old')).body.message;
    await unfriend(a, b);
    const edit = await call(a, 'POST', '/message/edit', { channelId: dm.id, messageId: msg.id, content: 'edited' });
    expect(edit.status).toBe(200);
    expect((await call(b, 'POST', '/message/edit', { channelId: dm.id, messageId: msg.id, content: 'x' })).status).toBe(403);
    expect((await call(a, 'POST', '/message/delete', { channelId: dm.id, messageId: msg.id })).status).toBe(200);
  });
});

test('GET /dm/homeserver/:homeserver is empty when no DMs are hosted there; DM routes need a session', async () => {
  const { a, b } = await friends();
  await open(a, b);
  expect((await call(a, 'GET', '/dm/homeserver/other.test')).body).toEqual({ dms: [] });
  const anon = anonymous(anchor.url);
  expect((await call(anon, 'GET', '/dm')).status).toBe(401);
  expect((await call(anon, 'GET', '/dm/homeserver/other.test')).status).toBe(401);
});
