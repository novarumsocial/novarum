import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fedChannelId, idOf, makeFriends } from '../harness/fedflows';
import { startPushSink } from '../harness/push';
import { eventually } from '../harness/wait';
import type { TestUser } from '../harness/users';

// Calls ringing across homeservers (modules/dm/ringing.ts). The DM's host decides when a ring ends;
// every member's own homeserver follows the host's ring events over the DM bridge and rings, or stops
// ringing, its own people's phones.

// the anchors push to this stand-in push service over the federation network's docker gateway
const sink = startPushSink({ endpointHost: '172.30.0.1' });
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(async () => {
  sink.stop();
  await closePg();
});

const hostA = anchors.a.homeserver;
type Socket = Awaited<ReturnType<typeof connect>>;

const pushes = (label: string, count: number, message: string) =>
  eventually(() => (sink.for(label).length >= count ? sink.for(label) : null), {
    timeout: 15_000,
    message,
  });
const appUrl = (channelId: string) => `novarum://guilds/dms/${encodeURIComponent(channelId)}`;

/**
 * `user` is on another homeserver than the host: a socket on their homeserver that has seen the
 * host's typing relayed over the DM bridge, so the bridge is up. The socket then says it's in the
 * background, like a phone's, or it would keep the homeserver from pushing.
 */
async function followed(host: TestUser, hostId: string, user: TestUser, shadowId: string) {
  const rt = await connect(user);
  await eventually(
    async () => {
      await call(host, 'POST', `/channel/${hostId}/typing`);
      return rt.events.some((e) => e.type === 'channel.typing' && e.data.channelId === shadowId);
    },
    { timeout: 15_000, interval: 300, message: `dm bridge up on ${user.user.homeserver}` }
  );
  rt.send({ type: 'client.state', active: false });
  await Bun.sleep(300);
  return rt;
}

/** a(A) and b(B) in a 1:1 hosted on A, each with a phone on their own homeserver */
async function oneToOne() {
  const [a, b] = [await signup('a'), await signup('b')];
  await makeFriends(a, b);
  const res = await call(a, 'POST', '/dm', { userId: await idOf(a, b) });
  expect(res.status).toBe(200);
  const hostId = res.body.id as string;
  const shadowId = fedChannelId(hostA, hostId);
  const rb = await followed(a, hostId, b, shadowId);
  const phones = {
    a: await sink.subscribe(a, undefined, 'UNIFIEDPUSH'),
    b: await sink.subscribe(b, undefined, 'UNIFIEDPUSH'),
  };
  return { a, b, hostId, shadowId, rb, phones };
}

/** the host's user `rt` joins the call and rings */
async function callFrom(rt: Socket, channelId: string) {
  rt.send({ type: 'voice.join', channelId });
  await rt.waitFor('voice.state.changed', (e) => e.data.connected);
  rt.send({ type: 'call.ring', channelId, ringing: true });
}

describe('a 1:1 hosted on another homeserver', () => {
  test("the callee's own homeserver rings their phone, replays the ring to a new device, and stops when the caller hangs up", async () => {
    const { a, b, hostId, shadowId, rb, phones } = await oneToOne();
    const ra = await connect(a);
    await callFrom(ra, hostId);

    const [ring] = await pushes(phones.b.label, 1, 'ring push on B');
    expect(ring).toMatchObject({
      type: 'call',
      ringing: true,
      title: a.user.username,
      body: 'Is calling you',
      tag: `call:${shadowId}`,
      url: appUrl(shadowId),
    });

    // b's phone opens the app mid-ring: B still knows the ring
    const late = await connect(b);
    const replayed = await late.waitFor('call.ringing');
    expect(replayed.data).toMatchObject({
      channelId: shadowId,
      ringing: true,
      user: { username: a.user.username, homeserver: hostA },
    });

    ra.send({ type: 'voice.leave' });
    const [, stop] = await pushes(phones.b.label, 2, 'stop push on B');
    expect(stop).toMatchObject({ type: 'call', ringing: false, tag: `call:${shadowId}` });
    // the caller's own phone never rang
    expect(sink.for(phones.a.label)).toHaveLength(0);
    for (const socket of [ra, rb, late]) socket.close();
  });

  test('answering on the other homeserver ends the ring on the host, and stops the phone', async () => {
    const { a, b, hostId, shadowId, rb, phones } = await oneToOne();
    const ra = await connect(a);
    await callFrom(ra, hostId);
    await pushes(phones.b.label, 1, 'ring push on B');

    rb.send({ type: 'voice.join', channelId: shadowId });
    const ended = await ra.waitFor('call.ringing', (e) => !e.data.ringing);
    expect(ended.data.channelId).toBe(hostId);
    const [, stop] = await pushes(phones.b.label, 2, 'answered stops the phone');
    expect(stop).toMatchObject({ ringing: false });

    // a device b connects now doesn't ring for a call b is already in
    const after = await connect(b);
    await sink.settle();
    expect(after.events.filter((e) => e.type === 'call.ringing')).toHaveLength(0);
    for (const socket of [ra, rb, after]) socket.close();
  });

  test("a ring from the non-host side reaches the host's phone, and declining there ends it on both sides", async () => {
    const { a, b, hostId, shadowId, rb, phones } = await oneToOne();
    rb.send({ type: 'call.ring', channelId: shadowId, ringing: true });
    const [ring] = await pushes(phones.a.label, 1, 'ring push on A');
    expect(ring).toMatchObject({ ringing: true, body: 'Is calling you', url: appUrl(hostId) });

    // B follows the ring with the host's id for b, yet b's own new device doesn't ring for b's call
    await rb.waitFor('call.ringing', (e) => e.data.ringing && e.data.channelId === shadowId);
    await Bun.sleep(300);
    const own = await connect(b);
    await Bun.sleep(500);
    expect(own.events.filter((e) => e.type === 'call.ringing')).toHaveLength(0);
    own.close();

    const ra = await connect(a);
    expect((await ra.waitFor('call.ringing')).data).toMatchObject({
      channelId: hostId,
      ringing: true,
    });
    ra.send({ type: 'call.ring', channelId: hostId, ringing: false });

    // the host ends the caller's ring, which comes back to B over the bridge
    await rb.waitFor(
      'call.ringing',
      (e) =>
        !e.data.ringing &&
        e.data.channelId === shadowId &&
        e.data.user.homeserver === anchors.b.homeserver
    );
    await pushes(phones.a.label, 2, "a's other devices stop");
    // b was the caller, so b's own phone never rang
    expect(sink.for(phones.b.label)).toHaveLength(0);
    ra.close();
    rb.close();
  });
});

describe('a group spread over three homeservers', () => {
  test("every member's homeserver rings them; whoever answers stops, the rest ring until the caller hangs up", async () => {
    const [a, b, c] = [await signup('a'), await signup('b'), await signup('c')];
    await makeFriends(a, b);
    await makeFriends(a, c);
    const res = await call(a, 'POST', '/dm/group', {
      userIds: [await idOf(a, b), await idOf(a, c)],
      name: 'Across',
    });
    expect(res.status).toBe(200);
    const hostId = res.body.id as string;
    const shadowId = fedChannelId(hostA, hostId);
    const rb = await followed(a, hostId, b, shadowId);
    const rc = await followed(a, hostId, c, shadowId);
    const phones = {
      b: await sink.subscribe(b, undefined, 'UNIFIEDPUSH'),
      c: await sink.subscribe(c, undefined, 'UNIFIEDPUSH'),
    };

    const ra = await connect(a);
    await callFrom(ra, hostId);
    const [ringB] = await pushes(phones.b.label, 1, 'group ring on B');
    const [ringC] = await pushes(phones.c.label, 1, 'group ring on C');
    // the group's name came to B and C with the group, so their pushes say what's calling
    for (const ring of [ringB, ringC])
      expect(ring).toMatchObject({ ringing: true, body: 'Calling Across', url: appUrl(shadowId) });

    rb.send({ type: 'voice.join', channelId: shadowId });
    await pushes(phones.b.label, 2, 'b answered, so b stops');
    await sink.settle();
    expect(sink.for(phones.c.label)).toHaveLength(1);
    // answering a group doesn't end the ring for the caller
    expect(ra.events.some((e) => e.type === 'call.ringing' && !e.data.ringing)).toBe(false);

    ra.send({ type: 'voice.leave' });
    const [, stop] = await pushes(phones.c.label, 2, 'the caller left, so c stops');
    expect(stop).toMatchObject({ ringing: false, tag: `call:${shadowId}` });
    for (const socket of [ra, rb, rc]) socket.close();
  });

  test("declining from the notification stops that member's phone and devices on their own homeserver, and nobody else's", async () => {
    const [a, b, c] = [await signup('a'), await signup('b'), await signup('c')];
    await makeFriends(a, b);
    await makeFriends(a, c);
    const res = await call(a, 'POST', '/dm/group', {
      userIds: [await idOf(a, b), await idOf(a, c)],
    });
    expect(res.status).toBe(200);
    const hostId = res.body.id as string;
    const shadowId = fedChannelId(hostA, hostId);
    const rb = await followed(a, hostId, b, shadowId);
    const rc = await followed(a, hostId, c, shadowId);
    const phones = {
      b: await sink.subscribe(b, undefined, 'UNIFIEDPUSH'),
      c: await sink.subscribe(c, undefined, 'UNIFIEDPUSH'),
    };

    const ra = await connect(a);
    await callFrom(ra, hostId);
    await pushes(phones.b.label, 1, 'group ring on B');
    const [ringC] = await pushes(phones.c.label, 1, 'group ring on C');
    expect(new URL(ringC.decline).origin).toBe(anchors.c.baseUrl);

    expect((await fetch(ringC.decline, { method: 'POST' })).status).toBe(200);
    await rc.waitFor('call.ringing', (e) => !e.data.ringing && e.data.channelId === shadowId);
    const [, stop] = await pushes(phones.c.label, 2, "c's phone stops");
    expect(stop).toMatchObject({ ringing: false, tag: `call:${shadowId}` });
    await sink.settle();
    expect(sink.for(phones.b.label)).toHaveLength(1);
    expect(ra.events.some((e) => e.type === 'call.ringing' && !e.data.ringing)).toBe(false);
    for (const socket of [ra, rb, rc]) socket.close();
  });
});
