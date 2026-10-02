import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, api, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, nonce, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { createGuild } from '../harness/chat';
import { closePg, fakeSend, fakeUser, pg } from '../harness/fedflows';
import { uniqueName } from '../harness/users';

// TESTING_PLAN §5.3 flow 4 (wire side): the /federation/channels/:id/* and /federation/guilds/:id/* routes of A, driven by a
// fake anchor whose user is a member of an A guild. Real B-to-A traffic is covered in guilds.test.ts.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

/** an A guild with a text channel, owned by a local user, plus a fake-anchor member */
async function room() {
  const owner = await signup('a');
  const { guild, channel } = await createGuild(owner, 'wire');
  const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
  const member = fakeUser(uniqueName('fk'));
  const joined = await fakeSend(1, 'a', `/federation/invites/${body.invite.code}/accept`, { user: member });
  expect(joined.status).toBe(200);
  const ch = (suffix: string, extra: object = {}, user: object = member) => fakeSend(1, 'a', `/federation/channels/${channel.id}/${suffix}`, { user, ...extra });
  return { owner, guild, channel, member, ch };
}

const cursorOf = (m: { createdAt: string; id: string }) => Buffer.from(JSON.stringify({ createdAt: m.createdAt, id: m.id })).toString('base64url');

describe('messages', () => {
  test('send: stored with the remote author, nonce makes it idempotent', async () => {
    const { owner, channel, member, ch } = await room();
    const n = nonce();
    const first = await ch('messages/send', { content: 'hi', nonce: n });
    expect(first.status).toBe(200);
    expect(first.json.message).toMatchObject({ channelId: channel.id, guildId: expect.any(String), content: 'hi', nonce: n });
    expect(first.json.message.author).toMatchObject({ username: member.username, homeserver: member.homeserver });
    const again = await ch('messages/send', { content: 'hi', nonce: n });
    expect(again.json.message.id).toBe(first.json.message.id);
    expect((await ch('messages/send', { content: 'different', nonce: n })).status).toBe(409);
    const list = await call(owner, 'GET', `/message/list?channelId=${channel.id}&cursor=0&amount=50`);
    expect(list.body.messages).toHaveLength(1);
  });

  test('send: validation, membership and impersonation errors', async () => {
    const { channel, member, ch } = await room();
    expect((await ch('messages/send', { content: null, nonce: nonce() })).status).toBe(400); // nothing to send
    expect((await ch('messages/send', { content: 5, nonce: nonce() })).status).toBe(400);
    expect((await ch('messages/send', { content: 'x' })).status).toBe(400); // no nonce
    expect((await ch('messages/send', { content: 'x', nonce: nonce(), replyTo: 'nope' })).status).toBe(400);
    expect((await ch('messages/send', { content: 'x', nonce: nonce(), attachmentIds: ['a', 'a'] })).status).toBe(400);
    expect((await ch('messages/send', { content: 'x', nonce: nonce() }, fakeUser(uniqueName('stranger')))).status).toBe(403); // not a member
    // the signer is fake (172.30.0.66) but the payload claims a B user
    const claimed = await ch('messages/send', { content: 'x', nonce: nonce() }, fakeUserOn(anchors.b.homeserver));
    expect(claimed.status).toBe(401);
    expect((await fakeSend(1, 'a', `/federation/channels/doesnotexist/messages/send`, { user: member, content: 'x', nonce: nonce() })).status).toBe(404);
    expect((await fakeSend(1, 'a', `/federation/channels/${channel.id}/messages/send`, { content: 'x', nonce: nonce() })).status).toBe(400); // no user
  });

  test('list: pagination by base64url cursor walks the channel in order', async () => {
    const { owner, channel, ch } = await room();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await send(owner, channel.id, `m${i}`)).body.message.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await ch('messages', { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.json.messages.map((m: any) => m.id));
      if (!res.json.nextCursor) break;
      expect(res.json.messages).toHaveLength(2);
      cursor = res.json.nextCursor;
    }
    expect(seen).toEqual(ids);

    // default page size, and the cursor after the last message is empty
    const all = await ch('messages', {});
    expect(all.json.messages).toHaveLength(5);
    expect(all.json.nextCursor).toBeNull();
    const last = all.json.messages[4];
    expect((await ch('messages', { cursor: cursorOf(last) })).json).toEqual({ messages: [], nextCursor: null });
    // a cursor before everything returns everything
    expect((await ch('messages', { cursor: cursorOf({ createdAt: '2000-01-01T00:00:00.000Z', id: '' }) })).json.messages).toHaveLength(5);
  });

  test('list: limit bounds are 1..100, malformed cursors are 400', async () => {
    const { ch } = await room();
    for (const limit of [1, 100]) expect({ limit, status: (await ch('messages', { limit })).status }).toEqual({ limit, status: 200 });
    for (const limit of [0, 101, -1, 1.5, '5', null, 1e9]) {
      expect({ limit, status: (await ch('messages', { limit })).status }).toEqual({ limit, status: 400 });
    }
    const bad: unknown[] = [
      'not base64 json!',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('[1,2]').toString('base64url'),
      Buffer.from(JSON.stringify({ createdAt: 'garbage', id: 'x' })).toString('base64url'),
      Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: 5 })).toString('base64url'),
      Buffer.from('null').toString('base64url'),
      12345,
      {},
    ];
    for (const cursor of bad) {
      const res = await ch('messages', { cursor });
      expect({ cursor, status: res.status }).toEqual({ cursor, status: 400 });
    }
    // null / missing cursor are fine
    expect((await ch('messages', { cursor: null })).status).toBe(200);
  });

  test('list: only members can read', async () => {
    const { ch } = await room();
    expect((await ch('messages', {}, fakeUser(uniqueName('stranger')))).status).toBe(403);
  });

  test('edit and delete: own messages only', async () => {
    const { owner, channel, ch } = await room();
    const mine = (await ch('messages/send', { content: 'mine', nonce: nonce() })).json.message;
    const theirs = (await send(owner, channel.id, 'theirs')).body.message;

    const edited = await ch('messages/edit', { messageId: mine.id, content: 'mine, edited' });
    expect(edited.status).toBe(200);
    expect(edited.json.message).toMatchObject({ content: 'mine, edited', edited: true });
    expect((await ch('messages/edit', { messageId: theirs.id, content: 'x' })).status).toBe(403);
    expect((await ch('messages/edit', { messageId: 'nope', content: 'x' })).status).toBe(404);
    expect((await ch('messages/edit', { messageId: 5, content: 'x' })).status).toBe(400);
    expect((await ch('messages/edit', { messageId: mine.id, content: null })).status).toBe(400); // nothing left

    expect((await ch('messages/delete', { messageId: theirs.id })).status).toBe(403);
    expect((await ch('messages/delete', { messageId: 'nope' })).status).toBe(404);
    expect((await ch('messages/delete', { messageId: mine.id })).json).toEqual({ success: true });
    expect((await ch('messages', {})).json.messages.map((m: any) => m.id)).toEqual([theirs.id]);
    expect((await ch('messages/edit', { messageId: mine.id, content: 'gone' })).status).toBe(404);
  });

  test('send/edit/delete are published to members on A', async () => {
    const { owner, ch } = await room();
    const rt = await connect(owner);
    const msg = (await ch('messages/send', { content: 'live', nonce: nonce() })).json.message;
    await rt.waitFor('message.created', (e) => e.data.id === msg.id);
    await ch('messages/edit', { messageId: msg.id, content: 'live 2' });
    await rt.waitFor('message.updated', (e) => e.data.id === msg.id && e.data.content === 'live 2');
    await ch('messages/delete', { messageId: msg.id });
    await rt.waitFor('message.deleted', (e) => e.data.id === msg.id);
    rt.close();
  });
});

describe('attachments', () => {
  test('presign: A creates the pending attachment and the url works', async () => {
    const { channel, ch } = await room();
    const res = await ch('attachments/presign', { filename: '../../weird name?.png', contentType: 'image/png', size: 4 });
    expect(res.status).toBe(200);
    // read the fields first: toMatchObject with asymmetric matchers rewrites the received object under Bun
    const { attachmentId, uploadUrl, headers } = res.json;
    expect(res.json).toMatchObject({ attachmentId: expect.any(String), uploadUrl: expect.stringContaining('http'), headers: { 'content-type': 'image/png' } });
    const [row] = await pg('a')`SELECT status, filename, "channelId" AS channel, size FROM attachment WHERE id = ${attachmentId}`;
    expect({ status: row!.status, channel: row!.channel, size: Number(row!.size) }).toEqual({ status: 'PENDING', channel: channel.id, size: 4 });
    expect(row!.filename).not.toContain('/');
    expect((await fetch(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(4) })).status).toBe(200);
  });

  test('presign: size limit is A\'s maxFileSize, types are allow-listed, members only', async () => {
    const { ch } = await room();
    const { maxFileSize } = (await (await fetch(`${api('a')}/.well-known/anchor/info`)).json()) as { maxFileSize: number };
    const max = maxFileSize * 1024 * 1024;
    expect((await ch('attachments/presign', { filename: 'f', contentType: 'application/pdf', size: max })).status).toBe(200);
    for (const size of [max + 1, 0, -5, 1.5]) {
      expect({ size, status: (await ch('attachments/presign', { filename: 'f', contentType: 'application/pdf', size })).status }).toEqual({ size, status: 400 });
    }
    expect((await ch('attachments/presign', { filename: 'f', contentType: 'text/html', size: 5 })).status).toBe(415);
    expect((await ch('attachments/presign', { filename: '', contentType: 'text/plain', size: 5 })).status).toBe(400);
    expect((await ch('attachments/presign', { filename: 'f', contentType: 'text/plain', size: 5 }, fakeUser(uniqueName('stranger')))).status).toBe(403);
  });

  test('a presigned attachment is claimed by the sender only', async () => {
    const { owner, channel, ch } = await room();
    const { json } = await ch('attachments/presign', { filename: 'a.txt', contentType: 'text/plain', size: 3 });
    await fetch(json.uploadUrl, { method: 'PUT', headers: json.headers, body: 'abc' });
    // the owner (a local user) cannot attach somebody else's upload
    expect((await send(owner, channel.id, 'stolen', { attachmentIds: [json.attachmentId] })).status).toBe(400);
    const sent = await ch('messages/send', { content: 'mine', nonce: nonce(), attachmentIds: [json.attachmentId] });
    expect(sent.status).toBe(200);
    expect(sent.json.message.attachments).toHaveLength(1);
  });
});

describe('typing, users, status', () => {
  test('typing is published to members, non-members get 403', async () => {
    const { owner, channel, member, ch } = await room();
    const rt = await connect(owner);
    expect((await ch('typing')).json).toEqual({ ok: true });
    const typing = await rt.waitFor('channel.typing');
    expect(typing.data).toMatchObject({ channelId: channel.id, username: member.username, homeserver: member.homeserver });
    expect((await ch('typing', {}, fakeUser(uniqueName('stranger')))).status).toBe(403);
    rt.close();
  });

  test('users lists the roster with roles, members only', async () => {
    const { owner, member, ch } = await room();
    const res = await ch('users');
    expect(res.status).toBe(200);
    expect(res.json.users.map((u: any) => [u.username, u.role]).sort()).toEqual(
      [[owner.user.username, 'OWNER'], [member.username, 'MEMBER']].sort()
    );
    expect((await ch('users', {}, fakeUser(uniqueName('stranger')))).status).toBe(403);
  });

  test('guilds/:id/users/status updates the member and notifies the guild', async () => {
    const { owner, guild, member } = await room();
    const rt = await connect(owner);
    const path = `/federation/guilds/${guild.id}/users/status`;
    expect((await fakeSend(1, 'a', path, { user: member, status: 'ONLINE' })).json).toEqual({ ok: true });
    const evt = await rt.waitFor('user.status.changed', (e) => e.data.status === 'ONLINE');
    const [row] = await pg('a')`SELECT status FROM "user" WHERE id = ${evt.data.userId}`;
    expect(row!.status).toBe('ONLINE');
    expect((await fakeSend(1, 'a', path, { user: member, status: 'AWAY' })).status).toBe(400);
    expect((await fakeSend(1, 'a', path, { user: fakeUser(uniqueName('stranger')), status: 'ONLINE' })).status).toBe(403);
    expect((await fakeSend(1, 'a', `/federation/guilds/nope/users/status`, { user: member, status: 'ONLINE' })).status).toBe(404);
    expect((await fakeSend(1, 'a', path, { user: fakeUserOn(anchors.b.homeserver), status: 'ONLINE' })).status).toBe(401);
    rt.close();
  });
});

describe('unread-mentions', () => {
  const mention = (m: { username: string; homeserver: string }) => `ping @${m.username}:${m.homeserver}`;

  test('counts pings after the cursor, and rejects channels the user is not in', async () => {
    const { owner, channel, member } = await room();
    const first = (await send(owner, channel.id, mention(member))).body.message;
    const second = (await send(owner, channel.id, mention(member))).body.message;
    const ask = (channels: unknown, user: object = member) => fakeSend(1, 'a', '/federation/unread-mentions', { user, channels });

    expect((await ask([{ id: channel.id, cursor: null }])).json).toEqual({ channels: [{ id: channel.id, mention: 2 }] });
    expect((await ask([{ id: channel.id, cursor: { createdAt: first.createdAt, id: first.id } }])).json.channels[0].mention).toBe(1);
    expect((await ask([{ id: channel.id, cursor: { createdAt: second.createdAt, id: second.id } }])).json.channels[0].mention).toBe(0);
    // duplicates collapse; an empty list is fine
    expect((await ask([{ id: channel.id, cursor: null }, { id: channel.id, cursor: null }])).json.channels).toHaveLength(1);
    expect((await ask([])).json).toEqual({ channels: [] });

    expect((await ask([{ id: 'nope', cursor: null }])).status).toBe(403); // unknown channel
    expect((await ask([{ id: channel.id, cursor: null }], fakeUser(uniqueName('stranger')))).status).toBe(403);
    expect((await ask([{ id: channel.id, cursor: { createdAt: 'x', id: 'y' } }])).status).toBe(400);
    expect((await ask('nope')).status).toBe(400);
  });

  test('at most 1000 channels per request', async () => {
    const { channel, member } = await room();
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i === 0 ? channel.id : `x${i}`, cursor: null }));
    // 1001 is refused by validation before any lookup; 1000 unknown ids pass validation and fail the access check
    expect((await fakeSend(1, 'a', '/federation/unread-mentions', { user: member, channels: many(1001) })).status).toBe(400);
    expect((await fakeSend(1, 'a', '/federation/unread-mentions', { user: member, channels: many(1000) })).status).toBe(403);
  });
});

describe('voice (token and presence are computed locally; no LiveKit connection is made)', () => {
  async function voiceRoom() {
    const r = await room();
    const created = await call(r.owner, 'POST', '/channel/create', { guildId: r.guild.id, name: 'talk', type: 'VOICE' });
    expect(created.status).toBe(200);
    const vc = created.body.id as string;
    const v = (suffix: string, extra: object = {}, user: object = r.member) => fakeSend(1, 'a', `/federation/channels/${vc}/${suffix}`, { user, ...extra });
    return { ...r, vc, v };
  }

  test('call/token: a JWT scoped to the voice room, members and voice channels only', async () => {
    const { vc, v, ch } = await voiceRoom();
    const res = await v('call/token');
    expect(res.status).toBe(200);
    expect(res.json.serverUrl).toMatch(/^ws/);
    const payload = JSON.parse(Buffer.from(res.json.token.split('.')[1], 'base64url').toString());
    expect(payload.video).toMatchObject({ roomJoin: true, room: `voice:${vc}` });
    expect(JSON.parse(payload.metadata)).toMatchObject({ channelId: vc });
    expect((await v('call/token', {}, fakeUser(uniqueName('stranger')))).status).toBe(403);
    expect((await ch('call/token')).status).toBe(404); // the text channel
  });

  test('voice-state: presence is recorded, published, and validated', async () => {
    const { owner, vc, v, member } = await voiceRoom();
    const rt = await connect(owner);
    const joined = await v('voice-state', { connected: true });
    expect(joined.status).toBe(200);
    expect(joined.json.state).toMatchObject({ channelId: vc, name: member.username });
    await rt.waitFor('voice.state.changed', (e) => e.data.channelId === vc && e.data.connected === true);
    expect((await v('voice-state', { connected: 'yes' })).status).toBe(400);
    expect((await v('voice-state', { connected: true }, fakeUser(uniqueName('stranger')))).status).toBe(403);
    await v('voice-state', { connected: false });
    await rt.waitFor('voice.state.changed', (e) => e.data.channelId === vc && e.data.connected === false);
    rt.close();
  });

  test('ring only works in DMs', async () => {
    const { v } = await voiceRoom();
    expect((await v('ring', { ringing: true })).status).toBe(404);
    expect((await v('ring', { ringing: 'x' })).status).toBe(400);
  });
});

/** a `user` payload whose homeserver is not the one that signed the request */
function fakeUserOn(homeserver: string) {
  return { ...fakeUser(uniqueName('fk')), homeserver };
}
