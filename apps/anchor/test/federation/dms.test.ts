import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, restart, signup, stackIsUp } from '../harness/federation';
import { call, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fedChannelId, friendList, idOf, listHas, makeFriends, pg, signerFor, userPayload } from '../harness/fedflows';
import { eventually } from '../harness/wait';
import { nonce } from '../harness/chat';
import type { TestUser } from '../harness/users';

// TESTING_PLAN §5.3 flow 3: DMs across servers. A (172.30.0.11) is the authority for A<->B, so A hosts the DM.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const hostA = anchors.a.homeserver;
const dmsFrom = async (u: TestUser, hs = hostA) => ((await call(u, 'GET', `/dm/homeserver/${hs}`)).body.dms ?? []) as any[];
const hasDm = async (u: TestUser, id: string) => (await dmsFrom(u)).some((d) => d.id === id);

/** friends a(A) and b(B), the DM opened from `from`, and the bridge on B up (probed through typing events) */
async function setup(from: 'host' | 'guest' = 'host') {
  const [a, b] = [await signup('a'), await signup('b')];
  await makeFriends(a, b);
  let hostId: string;
  if (from === 'host') {
    const res = await call(a, 'POST', '/dm', { userId: await idOf(a, b) });
    expect(res.status).toBe(200);
    hostId = res.body.id;
  } else {
    const res = await call(b, 'POST', '/dm', { userId: await idOf(b, a) });
    expect(res.status).toBe(200);
    hostId = res.body.id.split(':').slice(3).join(':');
  }
  const shadowId = fedChannelId(hostA, hostId);
  await eventually(() => hasDm(b, shadowId), { message: 'shadow dm on b' });
  const rt = await connect(b);
  await bridgeUp(a, hostId, rt, shadowId);
  return { a, b, hostId, shadowId, rt };
}

/** the DM bridge from B is established asynchronously; A typing is relayed over it once it is */
async function bridgeUp(host: TestUser, hostId: string, rt: Awaited<ReturnType<typeof connect>>, shadowId: string) {
  await eventually(
    async () => {
      await call(host, 'POST', `/channel/${hostId}/typing`);
      return rt.events.some((e) => e.type === 'channel.typing' && e.data.channelId === shadowId);
    },
    { timeout: 15_000, interval: 300, message: 'dm bridge up on b' }
  );
}

describe('opening', () => {
  test('from the host side: /dms/notify creates a fed:channel: shadow on B and B can use it', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    await makeFriends(a, b);
    const opened = await call(a, 'POST', '/dm', { userId: await idOf(a, b) });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ type: 'DM' });
    const shadowId = fedChannelId(hostA, opened.body.id);
    await eventually(() => hasDm(b, shadowId), { message: 'shadow on b' });
    // B lists the DM under the host's homeserver, with the host user as participant
    const [dm] = (await dmsFrom(b)).filter((d) => d.id === shadowId);
    expect(dm.participants.map((p: any) => p.username)).toEqual([a.user.username]);
    expect((await call(b, 'GET', '/dm')).body.pending).toContain(hostA);
    const [row] = await pg('b')`SELECT type, "guildId" FROM channel WHERE id = ${shadowId}`;
    expect(row).toMatchObject({ type: 'DM', guildId: null });
  });

  test('from the non-host side: /dms/open returns the canonical channel, which also shows up on A', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    await makeFriends(a, b);
    const opened = await call(b, 'POST', '/dm', { userId: await idOf(b, a) });
    expect(opened.status).toBe(200);
    expect(opened.body.id).toMatch(/^fed:channel:/);
    const hostId = opened.body.id.split(':').slice(3).join(':');
    expect(opened.body.id).toBe(fedChannelId(hostA, hostId)); // no double mapping
    const onA = await call(a, 'GET', '/dm');
    expect(onA.body.dms.map((d: any) => d.id)).toContain(hostId);
    // opening again is idempotent: same canonical channel
    expect((await call(b, 'POST', '/dm', { userId: await idOf(b, a) })).body.id).toBe(opened.body.id);
  });

  test('not friends: both sides refuse (403)', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    await call(a, 'POST', '/friends/request', { username: b.user.username, homeserver: b.user.homeserver });
    const target = await idOf(a, b);
    expect((await call(a, 'POST', '/dm', { userId: target })).status).toBe(403);
    expect((await call(b, 'POST', '/dm', { userId: await eventually(() => idOf(b, a), { message: 'b sees request' }) })).status).toBe(403);
  });
});

describe('messages', () => {
  test('both directions, listing, edit and delete propagate, realtime ids are mapped once', async () => {
    const { a, b, hostId, shadowId, rt } = await setup('host');

    // b -> a through the shadow channel
    const sent = await send(b, shadowId, 'hello from b');
    expect(sent.status).toBe(200);
    expect(sent.body.message).toMatchObject({ channelId: shadowId, content: 'hello from b', guildId: null });
    const onA = await call(a, 'GET', `/message/list?channelId=${hostId}&cursor=0&amount=50`);
    expect(onA.body.messages.map((m: any) => m.content)).toEqual(['hello from b']);
    expect(onA.body.messages[0].author).toMatchObject({ username: b.user.username, homeserver: anchors.b.homeserver });

    // a -> b arrives on b's websocket with the mapped channel id
    const fromA = await send(a, hostId, 'hello from a');
    expect(fromA.status).toBe(200);
    const evt = await rt.waitFor('message.created', (e) => e.data.content === 'hello from a');
    expect(evt.data.channelId).toBe(shadowId);
    expect(evt.data.channelId.match(/fed:channel:/g)).toHaveLength(1);
    expect(evt.data.guildId).toBeNull();

    // listing from b goes to the host and keeps the shadow id
    const onB = await call(b, 'GET', `/message/list?channelId=${encodeURIComponent(shadowId)}&cursor=0&amount=50`);
    expect(onB.body.messages.map((m: any) => [m.content, m.channelId])).toEqual([
      ['hello from b', shadowId],
      ['hello from a', shadowId],
    ]);

    // edit by b (own message) shows on A and arrives as message.updated
    const msgId = sent.body.message.id;
    expect((await call(b, 'POST', '/message/edit', { channelId: shadowId, messageId: msgId, content: 'edited by b' })).status).toBe(200);
    expect((await call(a, 'GET', `/message/list?channelId=${hostId}&cursor=0&amount=50`)).body.messages[0]).toMatchObject({ content: 'edited by b', edited: true });
    await rt.waitFor('message.updated', (e) => e.data.id === msgId && e.data.channelId === shadowId);
    // b cannot edit a's message
    const aMsg = fromA.body.message.id;
    expect((await call(b, 'POST', '/message/edit', { channelId: shadowId, messageId: aMsg, content: 'nope' })).status).toBe(403);

    // delete by b, then by a, both reach the other side
    expect((await call(b, 'POST', '/message/delete', { channelId: shadowId, messageId: msgId })).status).toBe(200);
    await rt.waitFor('message.deleted', (e) => e.data.id === msgId && e.data.channelId === shadowId);
    expect((await call(a, 'POST', '/message/delete', { channelId: hostId, messageId: aMsg })).status).toBe(200);
    await rt.waitFor('message.deleted', (e) => e.data.id === aMsg && e.data.channelId === shadowId);
    expect((await call(a, 'GET', `/message/list?channelId=${hostId}&cursor=0&amount=50`)).body.messages).toEqual([]);
    rt.close();
  });

  test('opened from the non-host side works the same way', async () => {
    const { a, b, hostId, shadowId, rt } = await setup('guest');
    expect((await send(b, shadowId, 'from the guest')).status).toBe(200);
    expect((await call(a, 'GET', `/message/list?channelId=${hostId}&cursor=0&amount=50`)).body.messages[0]).toMatchObject({ content: 'from the guest' });
    await send(a, hostId, 'from the host');
    await rt.waitFor('message.created', (e) => e.data.content === 'from the host');
    rt.close();
  });

  test('/dms/latest: B sees the latest message time and unread state of a hosted DM', async () => {
    const { a, b, hostId, shadowId, rt } = await setup('host');
    expect((await dmsFrom(b)).find((d) => d.id === shadowId)).toMatchObject({ lastMessageAt: null, unread: false });
    await send(a, hostId, 'ping');
    await rt.waitFor('message.created');
    const dm = await eventually(async () => (await dmsFrom(b)).find((d) => d.id === shadowId && d.lastMessageAt), { message: 'latest via /dms/latest' });
    expect(dm.unread).toBe(true); // authored by a, not read by b
    // b's own message is never unread for b
    await send(b, shadowId, 'reply');
    await eventually(async () => (await dmsFrom(b)).find((d) => d.id === shadowId)?.unread === false, { message: 'own message not unread' });
    rt.close();
  });
});

describe('calls', () => {
  test('ringing from the non-host side reaches the host user, and comes back mapped', async () => {
    const { a, b, hostId, shadowId, rt } = await setup('host');
    const rtA = await connect(a);
    rt.send({ type: 'call.ring', channelId: shadowId, ringing: true });
    const onA = await rtA.waitFor('call.ringing');
    expect(onA.data).toMatchObject({ channelId: hostId, ringing: true, user: { username: b.user.username } });
    const echoed = await rt.waitFor('call.ringing', (e) => e.data.channelId === shadowId);
    expect(echoed.data.ringing).toBe(true);
    rtA.close();
    rt.close();
  });
});

describe('friendship changes and closing', () => {
  test('unfriend: writes are refused on the host, reads stay allowed', async () => {
    const { a, b, hostId, shadowId, rt } = await setup('host');
    await send(b, shadowId, 'before unfriend');
    expect((await call(a, 'DELETE', `/friends/${await idOf(a, b)}`)).status).toBe(200);
    await eventually(async () => !listHas((await friendList(b)).accepted, a), { message: 'b sees unfriend' });

    // B itself refuses the write (no friendship there)
    expect((await send(b, shadowId, 'after unfriend')).status).toBe(403);
    // and so does the host, when B is bypassed and asks A directly with its real signature
    const fromB = await signerFor('b');
    const payload = userPayload(b.user);
    const write = await fromB.send('a', 'POST', `/federation/channels/${hostId}/messages/send`, { user: payload, content: 'sneaky', nonce: nonce() });
    expect(write.status).toBe(403);
    // reads still work, from B's API and on the wire
    const list = await call(b, 'GET', `/message/list?channelId=${encodeURIComponent(shadowId)}&cursor=0&amount=50`);
    expect(list.status).toBe(200);
    expect(list.body.messages.map((m: any) => m.content)).toEqual(['before unfriend']);
    const wire = await fromB.send('a', 'POST', `/federation/channels/${hostId}/messages`, { user: payload });
    expect(wire.status).toBe(200);
    expect(wire.json.messages).toHaveLength(1);
    rt.close();
  });

  test('closing the DM on B hides it until A sends, which reopens it via the bridge', async () => {
    const { a, b, hostId, shadowId, rt } = await setup('host');
    expect((await call(b, 'POST', `/dm/${encodeURIComponent(shadowId)}/close`)).status).toBe(200);
    expect(await hasDm(b, shadowId)).toBe(false);
    await send(a, hostId, 'knock knock');
    await eventually(() => hasDm(b, shadowId), { message: 'dm reopened on b' });
    rt.close();
  });
});

describe('restart of B', () => {
  test('the DM bridge is restored at boot: the next message arrives with no client action on B', async () => {
    const { a, b, hostId, shadowId, rt } = await setup('host');
    // a closed DM must reopen after the restart too
    expect((await call(b, 'POST', `/dm/${encodeURIComponent(shadowId)}/close`)).status).toBe(200);
    rt.close();

    await restart('b');

    // reconnect b's websocket only; nothing here asks B to (re)create bridges (no GET /dm, no GET /guilds/list)
    const rt2 = await connect(b);
    // typing from A is the probe: it only reaches B once B's boot-time bridge is connected
    await bridgeUp(a, hostId, rt2, shadowId);
    await send(a, hostId, 'after the restart');
    await rt2.waitFor('message.created', (e) => e.data.content === 'after the restart');
    expect(await hasDm(b, shadowId)).toBe(true);
    rt2.close();
  });
});
