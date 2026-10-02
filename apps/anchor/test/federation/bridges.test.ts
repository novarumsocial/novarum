import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, fake, ips, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fakeBridgeSigner, joinedRoom, fakeSend, fakeUser, fedChannelId, fedGuildId, openBridge, signerFor } from '../harness/fedflows';
import { eventually } from '../harness/wait';
import { uniqueName } from '../harness/users';

// TESTING_PLAN §5.3 flow 5: realtime bridges. A guild's events travel over a signed WebSocket that the member's homeserver
// opens to the host (/federation/realtime/guilds/:id); the member's homeserver maps the ids to fed:guild:/fed:channel:.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(async () => {
  await fake.reset();
  await closePg();
});

const hostA = anchors.a.homeserver;

describe('events from a host guild reach the member server, with mapped ids', () => {
  test('message, channel, member and typing events use fed: ids exactly once', async () => {
    const { owner, guild, channel, shadowGuild, shadowChannel, rt, invite } = await joinedRoom();

    const msg = (await send(owner, channel.id, 'through the bridge')).body.message;
    const created = await rt.waitFor('message.created', (e) => e.data.id === msg.id);
    expect(created.data).toMatchObject({ channelId: shadowChannel, guildId: shadowGuild, content: 'through the bridge' });

    await call(owner, 'POST', '/message/edit', { channelId: channel.id, messageId: msg.id, content: 'edited' });
    expect((await rt.waitFor('message.updated', (e) => e.data.id === msg.id)).data).toMatchObject({ channelId: shadowChannel, guildId: shadowGuild });
    await call(owner, 'POST', '/message/delete', { channelId: channel.id, messageId: msg.id });
    expect((await rt.waitFor('message.deleted', (e) => e.data.id === msg.id)).data).toEqual({ id: msg.id, channelId: shadowChannel, guildId: shadowGuild });

    const typing = rt.events.find((e) => e.type === 'channel.typing')!;
    expect(typing.data.channelId).toBe(shadowChannel);

    const newChannel = (await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'second', type: 'TEXT' })).body;
    const chEvent = await rt.waitFor('channel.created', (e) => e.data.name === 'second');
    expect(chEvent.data).toMatchObject({ id: fedChannelId(hostA, newChannel.id), guildId: shadowGuild });
    const reorder = await call(owner, 'PATCH', '/channel/order', { guildId: guild.id, channelIds: [channel.id, newChannel.id] });
    expect(reorder.status).toBe(200);
    const reordered = await rt.waitFor('guild.channels.reordered');
    expect(reordered.data).toEqual({ guildId: shadowGuild, channelIds: [shadowChannel, fedChannelId(hostA, newChannel.id)] });

    const other = await signup('c');
    await call(other, 'POST', '/invite/accept', { code: invite, homeserver: hostA });
    const joined = await rt.waitFor('member.joined');
    expect(joined.data.guildId).toBe(shadowGuild);
    expect(joined.data.user).toMatchObject({ username: other.user.username, homeserver: anchors.c.homeserver });

    // no id anywhere carries two fed: prefixes
    for (const e of rt.events) expect(JSON.stringify(e).match(/fed:(guild|channel):fed:/)).toBeNull();
    rt.close();
  });

  test('voice presence on the host is relayed with mapped ids', async () => {
    const { owner, guild, shadowGuild, rt } = await joinedRoom();
    const vc = (await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'talk', type: 'VOICE' })).body.id as string;
    const ownerRt = await connect(owner);
    ownerRt.send({ type: 'voice.join', channelId: vc });
    const evt = await rt.waitFor('voice.state.changed', (e) => e.data.connected === true);
    expect(evt.data).toMatchObject({ guildId: shadowGuild, channelId: fedChannelId(hostA, vc), connected: true });
    ownerRt.send({ type: 'voice.leave' });
    await rt.waitFor('voice.state.changed', (e) => e.data.connected === false && e.data.channelId === fedChannelId(hostA, vc));
    ownerRt.close();
    rt.close();
  });
});

describe('bridge authentication (a hostile homeserver opening bridges to A)', () => {
  async function room() {
    const owner = await signup('a');
    const { guild, channel } = await createGuild(owner, 'auth');
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    return { owner, guild, channel, code: body.invite.code as string };
  }
  const signer = fakeBridgeSigner(1);

  test('unsigned, tampered, replayed and stale connections are closed with 1008', async () => {
    const { guild } = await room();
    const none = await openBridge('a', 'guilds', guild.id, async () => ({}));
    expect(await none.waitClosed()).toMatchObject({ code: 1008, reason: expect.stringMatching(/Missing/) });

    const bad = await openBridge('a', 'guilds', guild.id, async (t, path) => (await fake.sign({ identity: 1, method: 'GET', path, host: new URL(anchors[t].baseUrl).host, body: '', tamper: true })).headers);
    expect(await bad.waitClosed()).toMatchObject({ code: 1008, reason: 'Invalid signature' });

    const stale = await openBridge('a', 'guilds', guild.id, async (t, path) => (await fake.sign({ identity: 1, method: 'GET', path, host: new URL(anchors[t].baseUrl).host, body: '', dateOffsetSeconds: -3600 })).headers);
    expect(await stale.waitClosed()).toMatchObject({ code: 1008, reason: 'Stale federation request' });

    // a signature for another path (another guild) does not carry over
    const wrongPath = await openBridge('a', 'guilds', guild.id, async (t) => (await fake.sign({ identity: 1, method: 'GET', path: '/federation/realtime/guilds/other', host: new URL(anchors[t].baseUrl).host, body: '' })).headers);
    expect(await wrongPath.waitClosed()).toMatchObject({ code: 1008, reason: 'Invalid signature' });

    // the same nonce twice
    const fixed = async (t: 'a', path: string) => (await fake.sign({ identity: 1, method: 'GET', path, host: new URL(anchors[t].baseUrl).host, body: '', nonce: `replay-${uniqueName()}` })).headers;
    const headers = await fixed('a', `/federation/realtime/guilds/${encodeURIComponent(guild.id)}`);
    const first = await openBridge('a', 'guilds', guild.id, async () => headers);
    await first.waitClosed(); // not a member: Forbidden, but the nonce is stored
    const replay = await openBridge('a', 'guilds', guild.id, async () => headers);
    expect(await replay.waitClosed()).toMatchObject({ code: 1008, reason: 'Federation nonce already used' });
  });

  test('a homeserver with no member in the guild, or an unknown guild, is Forbidden (1008)', async () => {
    const { guild } = await room();
    const notMember = await openBridge('a', 'guilds', guild.id, signer);
    expect(await notMember.waitClosed()).toMatchObject({ code: 1008, reason: 'Forbidden' });
    const unknown = await openBridge('a', 'guilds', 'does-not-exist', signer);
    expect(await unknown.waitClosed()).toMatchObject({ code: 1008, reason: 'Forbidden' });
  });

  test('a member homeserver is accepted, gets a presence snapshot and then the guild events unmapped', async () => {
    const { owner, guild, channel, code } = await room();
    expect((await fakeSend(1, 'a', `/federation/invites/${code}/accept`, { user: fakeUser(uniqueName('fk')) })).status).toBe(200);
    const bridge = await openBridge('a', 'guilds', guild.id, signer);
    const snapshot = await bridge.waitFor('voice.states.snapshot');
    expect(snapshot.data).toEqual({ guildIds: [guild.id], states: [] });
    expect(bridge.closed).toBeNull();
    const msg = (await send(owner, channel.id, 'native ids')).body.message;
    const evt = await bridge.waitFor('message.created');
    expect(evt.data).toMatchObject({ id: msg.id, channelId: channel.id, guildId: guild.id }); // the receiver maps, the host does not
    bridge.close();
  });

  test('DM bridges: only a homeserver of a participant may subscribe', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    const { makeFriends, idOf } = await import('../harness/fedflows');
    await makeFriends(a, b);
    const dmId = (await call(a, 'POST', '/dm', { userId: await idOf(a, b) })).body.id as string;
    const intruder = await openBridge('a', 'dms', dmId, signer);
    expect(await intruder.waitClosed()).toMatchObject({ code: 1008, reason: 'Forbidden' });
    const fromB = await signerFor('b');
    const ok = await openBridge('a', 'dms', dmId, async (t, path) => fromB.headersFor(t, 'GET', path));
    await ok.waitFor('voice.states.snapshot');
    expect(ok.closed).toBeNull();
    ok.close();
  });
});

describe('the member server consuming a bridge (the host is the fake anchor)', () => {
  const guildPath = (id: string) => `/federation/realtime/guilds/${id}`;

  /** a B user joined to a guild "hosted" by the fake anchor; the bridge route answers 404 until the test sets a rule for it */
  async function fakeHosted(wsRule?: Parameters<typeof fake.respond>[2]) {
    const guildId = uniqueName('fg');
    const channelId = uniqueName('fc');
    if (wsRule) await fake.respond(1, guildPath(guildId), wsRule);
    await fake.respond(1, `POST /federation/invites/${guildId}/accept`, {
      json: {
        guild: { id: guildId, homeserver: ips.fake[1], name: 'fakehost', description: null, avatarUrl: null },
        channels: [{ id: channelId, guildId, name: 'general', position: 0, type: 'TEXT' }],
      },
    });
    const user = await signup('b');
    const res = await call(user, 'POST', '/invite/accept', { code: guildId, homeserver: ips.fake[1] });
    expect(res.status).toBe(200);
    const attempts = async () => (await fake.requests(1, { path: guildPath(guildId) })).filter((r) => r.headers.upgrade?.toLowerCase() === 'websocket');
    return { user, guildId, channelId, shadowGuild: fedGuildId(ips.fake[1], guildId), shadowChannel: fedChannelId(ips.fake[1], channelId), attempts };
  }
  const messageData = (guildId: string, channelId: string, over: object = {}) => ({
    id: uniqueName('m'),
    channelId,
    guildId,
    content: 'from the fake host',
    nonce: 'n',
    replyTo: null,
    edited: false,
    pingedHandles: [],
    attachments: [],
    createdAt: new Date().toISOString(),
    author: { userId: 'u1', username: 'remoteuser', homeserver: ips.fake[1], displayName: null, avatarUrl: null, avatarColor: null, speakingRingColor: null, isBot: false },
    ...over,
  });

  test('reconnects with exponential backoff: first delays are about 1s then 2s', async () => {
    const h = await fakeHosted();
    // no websocket route: every attempt fails
    const four = await eventually(async () => ((await h.attempts()).length >= 3 ? h.attempts() : null), { timeout: 15_000, interval: 200, message: '3 attempts' });
    const [t0, t1, t2] = four.map((r) => r.ts);
    expect(t1! - t0!).toBeGreaterThan(800);
    expect(t1! - t0!).toBeLessThan(1800);
    expect(t2! - t1!).toBeGreaterThan(1800);
    expect(t2! - t1!).toBeLessThan(3000);
    await retire(h);
  });

  test('1008 from the host stops reconnecting; GET /guilds/list starts a fresh bridge', async () => {
    const h = await fakeHosted({ ws: { messages: [], close: { code: 1008, reason: 'Forbidden' } } });
    await eventually(async () => (await h.attempts()).length >= 1, { message: 'first attempt' });
    // a reconnect would have come after 1s (and again after 3s)
    await Bun.sleep(4500);
    expect(await h.attempts()).toHaveLength(1);
    // the next GET /guilds/list re-creates the bridge, and this time the host accepts it
    await fake.respond(1, guildPath(h.guildId), { ws: { messages: [] } });
    expect((await call(h.user, 'GET', '/guilds/list')).status).toBe(200);
    await eventually(async () => (await h.attempts()).length === 2, { message: 'bridge recreated by /guilds/list' });
    await Bun.sleep(1500);
    expect(await h.attempts()).toHaveLength(2); // and it stays up
  });

  test('malformed and unknown events are ignored, the bridge stays up, valid ones still arrive mapped', async () => {
    const h = await fakeHosted();
    const rt = await connect(h.user);
    await fake.respond(1, guildPath(h.guildId), {
      ws: {
        messages: [
          'this is not json',
          '{"type":',
          { type: 'definitely.unknown', data: {} },
          { type: 'message.created', data: { nope: true } },
          { type: 'message.created' },
          [1, 2, 3],
          null,
          42,
          { type: 'message.created', data: messageData(h.guildId, h.channelId, { content: 'the valid one' }) },
        ],
      },
    });
    const evt = await rt.waitFor('message.created', () => true, 15_000);
    expect(evt.data).toMatchObject({ content: 'the valid one', channelId: h.shadowChannel, guildId: h.shadowGuild });
    await Bun.sleep(1000);
    expect(rt.events.filter((e) => e.type === 'message.created')).toHaveLength(1);
    expect(rt.events.filter((e) => e.type === 'definitely.unknown')).toHaveLength(0);
    const connections = (await h.attempts()).length;
    await Bun.sleep(3500);
    expect(await h.attempts()).toHaveLength(connections); // no reconnects: still connected
    // the realtime socket of the member is intact too
    expect(rt.closed).toBeNull();
    rt.close();
  });

  test('remote voice presence is cleared when the bridge drops', async () => {
    const h = await fakeHosted();
    const rt = await connect(h.user);
    const state = { guildId: h.guildId, channelId: h.channelId, userId: 'remote-u1', name: 'Remote Talker' };
    await fake.respond(1, guildPath(h.guildId), {
      ws: { messages: [{ type: 'voice.states.snapshot', data: { guildIds: [h.guildId], states: [state] } }], close: { code: 1001, reason: 'going away' } },
    });
    const snapshot = await rt.waitFor('voice.states.snapshot', (e) => e.data.states.length > 0, 15_000);
    expect(snapshot.data.states[0]).toMatchObject({ guildId: h.shadowGuild, channelId: h.shadowChannel, userId: 'remote-u1' });
    const cleared = await rt.waitFor('voice.state.changed', (e) => e.data.connected === false, 15_000);
    expect(cleared.data).toMatchObject({ userId: 'remote-u1', guildId: h.shadowGuild, channelId: h.shadowChannel, connected: false });
    await retire(h);
    rt.close();
  });

  /** stops a bridge from reconnecting for good: the next attempt gets a 1008 */
  async function retire(h: Awaited<ReturnType<typeof fakeHosted>>) {
    const before = (await h.attempts()).length;
    await fake.respond(1, guildPath(h.guildId), { ws: { messages: [], close: { code: 1008, reason: 'done' } } });
    await eventually(async () => (await h.attempts()).length > before, { timeout: 40_000, interval: 300, message: 'final attempt' });
  }
});
