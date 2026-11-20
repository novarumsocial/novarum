import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { S3Client } from 'bun';
import sharp from 'sharp';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { signup } from '../harness/users';
import { befriend, unfriend } from '../harness/friends';
import { openRealtime } from '../harness/ws';
import { eventually } from '../harness/wait';
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
    (await sql`SELECT "userId", closed FROM channel_member WHERE "channelId" = ${channelId}`).map(
      (r: any) => [r.userId, r.closed]
    )
  );

describe('open', () => {
  test('friends open a DM; both participants see it listed with the other as participant', async () => {
    const { a, b } = await friends();
    const res = await open(a, b);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'DM',
      lastMessageAt: null,
      lastMessage: null,
      unread: false,
    });
    expect(res.body.participants.map((p: any) => p.userId)).toEqual([b.user.id]);
    expect((await dms(a))[0].participants.map((p: any) => p.userId)).toEqual([b.user.id]);
    expect((await dms(b))[0]).toMatchObject({ id: res.body.id });
    expect((await dms(b))[0].participants.map((p: any) => p.userId)).toEqual([a.user.id]);
  });

  test('no friendship is 403, and so is a pending request in either direction', async () => {
    const [a, b, c] = await Promise.all([
      signup(anchor.url),
      signup(anchor.url),
      signup(anchor.url),
    ]);
    expect((await open(a, b)).status).toBe(403);
    await a.fetch('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ username: b.user.username, homeserver: b.user.homeserver }),
    });
    expect((await open(a, b)).status).toBe(403);
    expect((await open(b, a)).status).toBe(403);
    expect((await open(a, c)).status).toBe(403);
    expect(
      await sql`SELECT 1 FROM channel WHERE type = 'DM' AND "dmKey" LIKE ${`%${a.user.id}%`}`
    ).toHaveLength(0);
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
    expect(
      await sql`SELECT 1 FROM channel_member WHERE "channelId" = ${first.body.id}`
    ).toHaveLength(2);
    expect(await dmIds(a)).toEqual([first.body.id]);
  });

  test('concurrent opens from both sides settle on one channel', async () => {
    const { a, b } = await friends();
    const results = await Promise.all([
      open(a, b),
      open(b, a),
      open(a, b),
      open(b, a),
      open(a, b),
      open(b, a),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(
      await sql`SELECT 1 FROM channel WHERE "dmKey" = ${[a.user.id, b.user.id].sort().join(':')}`
    ).toHaveLength(1);
  });

  test('the other user is told with dm.created the first time, not on re-open', async () => {
    const { a, b } = await friends();
    const ws = await openRealtime(anchor.url, b.cookie);
    try {
      await Bun.sleep(200);
      const opened = await open(a, b);
      const created = await ws.waitFor('dm.created', (e) => e.data?.id === opened.body.id);
      expect(created.data.lastMessage).toBeNull();
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
    for (const path of ['/dm', '/dm/homeserver/localhost']) {
      expect(JSON.stringify((await call(c, 'GET', path)).body)).not.toContain('secret');
    }
    expect((await list(c, dm.id)).status).toBe(403);
    expect((await send(c, dm.id, 'hi')).status).toBe(403);
    expect((await call(c, 'POST', `/channel/${dm.id}/typing`)).status).toBe(401);
    expect(
      (
        await call(c, 'POST', `/channel/${dm.id}/read`, {
          messageId: msg.id,
          createdAt: msg.createdAt,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(c, 'POST', '/message/edit', {
          channelId: dm.id,
          messageId: msg.id,
          content: 'x',
        })
      ).status
    ).toBe(403);
    expect(
      (await call(c, 'POST', '/message/delete', { channelId: dm.id, messageId: msg.id })).status
    ).toBe(403);
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

  test('lastMessage previews the newest message with its author, for both participants', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await send(a, dm.id, 'first');
    const msg = (await send(b, dm.id, 'second\n  line')).body.message;
    const preview = {
      id: msg.id,
      authorId: b.user.id,
      content: 'second line',
      attachmentCount: 0,
      system: null,
      author: { username: b.user.username, displayName: null },
    };
    expect((await dms(a))[0].lastMessage).toEqual(preview);
    expect((await dms(b))[0].lastMessage).toEqual(preview);

    const own = (await send(a, dm.id, 'mine')).body.message;
    expect((await dms(a))[0].lastMessage).toMatchObject({ id: own.id, authorId: a.user.id });
  });

  test('lastMessage content is cut to 140 characters without splitting emoji', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await send(a, dm.id, '😀'.repeat(300));
    const { content } = (await dms(b))[0].lastMessage;
    expect(Array.from(content)).toHaveLength(140);
    expect(content).toBe(`${'😀'.repeat(139)}…`);
    await send(a, dm.id, 'x'.repeat(140));
    expect((await dms(b))[0].lastMessage.content).toBe('x'.repeat(140));
  });

  test('an attachment-only message previews with null content and its attachment count', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    const attachmentIds = [];
    for (const filename of ['one.txt', 'two.txt']) {
      const presign = await call(a, 'POST', '/upload/presign', {
        channelId: dm.id,
        filename,
        contentType: 'text/plain',
        size: 2,
      });
      expect(presign.status).toBe(200);
      const { uploadUrl, headers, attachmentId } = presign.body;
      expect((await fetch(uploadUrl, { method: 'PUT', headers, body: 'hi' })).status).toBe(200);
      attachmentIds.push(attachmentId);
    }
    const msg = await send(a, dm.id, null, { attachmentIds });
    expect(msg.status).toBe(200);
    expect((await dms(b))[0].lastMessage).toEqual({
      id: msg.body.message.id,
      authorId: a.user.id,
      content: null,
      attachmentCount: 2,
      system: null,
      author: { username: a.user.username, displayName: null },
    });
  });

  test('deleting the newest message moves the preview back to the one before it', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    await send(a, dm.id, 'kept');
    const gone = (await send(a, dm.id, 'oops')).body.message;
    await call(a, 'POST', '/message/delete', { channelId: dm.id, messageId: gone.id });
    expect((await dms(b))[0].lastMessage.content).toBe('kept');
  });

  test('unread: set for the recipient only, cleared by reading', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    const msg = (await send(a, dm.id, 'hello')).body.message;
    expect((await dms(a))[0].unread).toBe(false);
    expect((await dms(b))[0].unread).toBe(true);
    await call(b, 'POST', `/channel/${dm.id}/read`, {
      messageId: msg.id,
      createdAt: msg.createdAt,
    });
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
    expect((await list(a, dm.id)).body.messages.map((m: any) => m.content)).toEqual([
      'while friends',
    ]);
    expect((await list(b, dm.id)).status).toBe(200);
    expect(await dmIds(b)).toEqual([dm.id]);
    expect(
      (
        await call(b, 'POST', `/channel/${dm.id}/read`, {
          messageId: msg.id,
          createdAt: msg.createdAt,
        })
      ).status
    ).toBe(200);
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
    const edit = await call(a, 'POST', '/message/edit', {
      channelId: dm.id,
      messageId: msg.id,
      content: 'edited',
    });
    expect(edit.status).toBe(200);
    expect(
      (
        await call(b, 'POST', '/message/edit', {
          channelId: dm.id,
          messageId: msg.id,
          content: 'x',
        })
      ).status
    ).toBe(403);
    expect(
      (await call(a, 'POST', '/message/delete', { channelId: dm.id, messageId: msg.id })).status
    ).toBe(200);
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

describe('group DMs', () => {
  const trio = async () => {
    const [a, b, c] = await Promise.all([
      signup(anchor.url),
      signup(anchor.url),
      signup(anchor.url),
    ]);
    await Promise.all([befriend(a, b), befriend(a, c)]);
    return { a, b, c };
  };
  const create = (user: Actor, others: Actor[], name?: string) =>
    call(user, 'POST', '/dm/group', { userIds: others.map((o) => o.user.id), name });
  const systemTypes = async (user: Actor, id: string) =>
    (await list(user, id)).body.messages
      .filter((m: any) => m.system)
      .map((m: any) => m.system.type);

  test('the preview names who wrote the last message, and shows system messages too', async () => {
    const { a, b, c } = await trio();
    const group = (await create(a, [b, c])).body.id as string;
    const preview = async (user: Actor) =>
      (await dms(user)).find((d: any) => d.id === group).lastMessage;
    // nobody has written yet: "a created the group"
    expect(await preview(b)).toMatchObject({
      authorId: a.user.id,
      content: null,
      system: { type: 'group.created' },
    });
    const msg = (await send(c, group, 'hi all')).body.message;
    expect(await preview(b)).toEqual({
      id: msg.id,
      authorId: c.user.id,
      content: 'hi all',
      attachmentCount: 0,
      system: null,
      author: { username: c.user.username, displayName: null },
    });

    // c isn't a participant anymore, but the preview still says who left
    expect((await call(c, 'POST', `/dm/${group}/leave`)).status).toBe(200);
    expect(await preview(b)).toMatchObject({
      system: { type: 'member.left' },
      author: { username: c.user.username },
    });
  });

  test('the creator owns a new group with their friends, everyone sees it, and the 1:1 DM is untouched', async () => {
    const { a, b, c } = await trio();
    const dm = await open(a, b);
    const ws = await openRealtime(anchor.url, c.cookie);
    const res = await create(a, [b, c], ' Plans ');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'GROUP_DM', name: 'Plans', ownerId: a.user.id });
    expect(res.body.participants.map((p: any) => p.userId).sort()).toEqual(
      [b.user.id, c.user.id].sort()
    );
    const created = await ws.waitFor('dm.created', (e) => e.data.id === res.body.id);
    expect(created.data.participants.map((p: any) => p.userId).sort()).toEqual(
      [a.user.id, b.user.id].sort()
    );
    ws.close();
    expect(await dmIds(b)).toContain(res.body.id);
    expect((await open(a, b)).body.id).toBe(dm.body.id);
    // the people a group starts with are part of "created", not added one by one
    expect(await systemTypes(a, res.body.id)).toEqual(['group.created']);
  });

  test('members chat in the group; a non-friend or unknown user cannot be added', async () => {
    const { a, b, c } = await trio();
    const stranger = await signup(anchor.url);
    expect((await create(a, [b, stranger])).status).toBe(403);
    expect((await call(a, 'POST', '/dm/group', { userIds: ['nope'] })).status).toBe(403);
    expect((await call(a, 'POST', '/dm/group', { userIds: [] })).status).toBe(422);
    const group = (await create(a, [b, c])).body;
    expect((await send(c, group.id, 'hi all')).status).toBe(200);
    expect((await list(stranger, group.id)).status).not.toBe(200);
    // b isn't friends with c, but anyone in the group can still talk to everyone
    expect((await send(b, group.id, 'hey c')).status).toBe(200);
  });

  test('any member adds their own friends; only the owner renames and kicks', async () => {
    const { a, b, c } = await trio();
    const d = await signup(anchor.url);
    await befriend(b, d);
    const group = (await create(a, [b])).body;

    expect(
      (await call(b, 'POST', `/dm/${group.id}/members`, { userIds: [c.user.id] })).status
    ).toBe(403);
    expect(
      (await call(b, 'POST', `/dm/${group.id}/members`, { userIds: [d.user.id] })).status
    ).toBe(200);
    expect(
      (await call(b, 'POST', `/dm/${group.id}/members`, { userIds: [d.user.id] })).status
    ).toBe(409);
    expect(await dmIds(d)).toContain(group.id);

    expect((await call(b, 'PATCH', `/dm/${group.id}`, { name: 'mine' })).status).toBe(403);
    expect((await call(b, 'DELETE', `/dm/${group.id}/members/${d.user.id}`)).status).toBe(403);
    expect((await call(a, 'PATCH', `/dm/${group.id}`, { name: 'Trip' })).status).toBe(200);
    expect((await dms(b)).find((x) => x.id === group.id).name).toBe('Trip');

    const ws = await openRealtime(anchor.url, d.cookie);
    expect((await call(a, 'DELETE', `/dm/${group.id}/members/${d.user.id}`)).status).toBe(200);
    await ws.waitFor('dm.removed', (e) => e.data.id === group.id);
    ws.close();
    expect(await dmIds(d)).not.toContain(group.id);
    expect((await send(d, group.id, 'still here?')).status).not.toBe(200);
    expect(await systemTypes(a, group.id)).toEqual([
      'group.created',
      'member.added',
      'group.renamed',
      'member.removed',
    ]);
  });

  test('ownership moves on transfer and when the owner leaves; the last person leaving deletes the group', async () => {
    const { a, b, c } = await trio();
    const group = (await create(a, [b, c])).body;
    expect((await call(a, 'POST', `/dm/${group.id}/owner`, { userId: a.user.id })).status).toBe(
      400
    );
    expect((await call(b, 'POST', `/dm/${group.id}/owner`, { userId: c.user.id })).status).toBe(
      403
    );
    expect((await call(a, 'POST', `/dm/${group.id}/owner`, { userId: c.user.id })).status).toBe(
      200
    );
    expect((await dms(b)).find((x) => x.id === group.id).ownerId).toBe(c.user.id);

    // c owns it now; when c leaves, the oldest remaining person takes over
    expect((await call(c, 'POST', `/dm/${group.id}/leave`)).status).toBe(200);
    const owner = (await dms(a)).find((x) => x.id === group.id).ownerId;
    expect([a.user.id, b.user.id]).toContain(owner);

    expect((await call(a, 'POST', `/dm/${group.id}/leave`)).status).toBe(200);
    expect((await call(b, 'POST', `/dm/${group.id}/leave`)).status).toBe(200);
    expect(await sql`SELECT 1 FROM channel WHERE id = ${group.id}`).toHaveLength(0);
  });

  test('group routes 404 for 1:1 DMs and for non-members', async () => {
    const { a, b, c } = await trio();
    const dm = (await open(a, b)).body;
    const group = (await create(a, [b])).body;
    expect((await call(a, 'POST', `/dm/${dm.id}/leave`)).status).toBe(404);
    expect((await call(a, 'PATCH', `/dm/${dm.id}`, { name: 'x' })).status).toBe(404);
    expect((await call(c, 'POST', `/dm/${group.id}/leave`)).status).toBe(404);
    expect((await call(c, 'PATCH', `/dm/${group.id}`, { name: 'x' })).status).toBe(404);
  });

  test('creating groups and adding members is rate limited per user', async () => {
    const { a, b, c } = await trio();
    const group = (await create(a, [b])).body;
    const addB = (user: Actor) =>
      call(user, 'POST', `/dm/${group.id}/members`, { userIds: [b.user.id] });
    for (let i = 1; i < 20; i++) expect((await addB(a)).status).toBe(409);
    expect((await addB(a)).status).toBe(429);
    expect((await create(a, [c])).status).toBe(429);
    expect((await create(b, [a])).status).toBe(200);
  });

  test("renaming, changing the icon, kicking and transferring count towards the same limit, and a refused icon isn't kept", async () => {
    const { a, b, c } = await trio();
    const group = (await create(a, [b, c])).body;
    const icon = async () => {
      const form = new FormData();
      const image = await sharp({
        create: { width: 64, height: 64, channels: 3, background: '#336699' },
      })
        .png()
        .toBuffer();
      form.append('icon', new File([image], 'icon.png', { type: 'image/png' }));
      return a.fetch(`/dm/${group.id}/icon`, { method: 'POST', body: form });
    };

    const before = await iconKeys();
    expect((await icon()).status).toBe(200);
    expect(await iconKeys()).toHaveLength(before.length + 1);
    for (let i = 3; i <= 20; i++) {
      expect((await call(a, 'PATCH', `/dm/${group.id}`, { name: `n${i}` })).status).toBe(200);
    }
    expect((await call(a, 'PATCH', `/dm/${group.id}`, { name: 'again' })).status).toBe(429);
    expect((await call(a, 'DELETE', `/dm/${group.id}/members/${c.user.id}`)).status).toBe(429);
    expect((await call(a, 'POST', `/dm/${group.id}/owner`, { userId: b.user.id })).status).toBe(
      429
    );

    const kept = await iconKeys();
    expect((await icon()).status).toBe(429);
    expect(await iconKeys()).toEqual(kept);
  });
});

// the bucket the anchors of these tests write to (test/config.toml)
const bucket = new S3Client({
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key-0000',
  endpoint: 'http://127.0.0.1:3900',
  region: 'garage',
  bucket: 'anchortest',
});
const iconKeys = async () =>
  ((await bucket.list({ prefix: 'dm-icons/', maxKeys: 1000 })).contents ?? [])
    .map((object) => object.key)
    .sort();

test('max_group_members caps a group, the creator included', async () => {
  const small = await spawnAnchor({ name: 'dm-small', config: { dms: { max_group_members: 3 } } });
  try {
    const [a, b, c, d] = await Promise.all([
      signup(small.url),
      signup(small.url),
      signup(small.url),
      signup(small.url),
    ]);
    await Promise.all([befriend(a, b), befriend(a, c), befriend(a, d)]);
    const ids = (users: Actor[]) => users.map((u) => u.user.id);
    expect((await call(a, 'POST', '/dm/group', { userIds: ids([b, c, d]) })).status).toBe(400);
    const group = await call(a, 'POST', '/dm/group', { userIds: ids([b, c]) });
    expect(group.status).toBe(200);
    expect(
      (await call(a, 'POST', `/dm/${group.body.id}/members`, { userIds: ids([d]) })).status
    ).toBe(400);
  } finally {
    await small.destroy();
  }
});

describe('call messages', () => {
  const calls = async (user: Actor, id: string) =>
    (await list(user, id)).body.messages
      .filter((m: any) => m.system?.type === 'call')
      .map((m: any) => m.system);

  test('a call nobody answers is missed; an answered one gets its duration once everyone left', async () => {
    const { a, b } = await friends();
    const dm = (await open(a, b)).body;
    const [wa, wb] = await Promise.all([
      openRealtime(anchor.url, a.cookie),
      openRealtime(anchor.url, b.cookie),
    ]);

    wa.send({ type: 'voice.join', channelId: dm.id });
    const started = await wb.waitFor('message.created', (e) => e.data.system?.type === 'call');
    expect(started.data.system).toEqual({ type: 'call', durationSeconds: null, missed: false });
    expect(started.data.author.userId).toBe(a.user.id);
    wa.send({ type: 'voice.leave' });
    const missed = await wb.waitFor('message.updated', (e) => e.data.id === started.data.id);
    expect(missed.data.system).toMatchObject({ type: 'call', missed: true });
    expect(missed.data.edited).toBe(false);

    wa.send({ type: 'voice.join', channelId: dm.id });
    await wb.waitFor('message.created', (e) => e.data.system && e.data.id !== started.data.id);
    wb.send({ type: 'voice.join', channelId: dm.id });
    await wa.waitFor('voice.state.changed', (e) => e.data.userId === b.user.id);
    // the call goes on while anyone is still in it
    wa.send({ type: 'voice.leave' });
    await wb.waitFor(
      'voice.state.changed',
      (e) => e.data.userId === a.user.id && !e.data.connected
    );
    expect((await calls(a, dm.id)).at(-1)).toMatchObject({ durationSeconds: null });
    wb.send({ type: 'voice.leave' });
    await eventually(async () => (await calls(a, dm.id)).at(-1).durationSeconds !== null);
    expect(await calls(a, dm.id)).toEqual([
      { type: 'call', durationSeconds: expect.any(Number), missed: true },
      { type: 'call', durationSeconds: expect.any(Number), missed: false },
    ]);
    wa.close();
    wb.close();
  });
});
