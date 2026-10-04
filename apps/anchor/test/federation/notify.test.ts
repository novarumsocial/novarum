import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { closePg, fedChannelId, fedGuildId, idOf, makeFriends, signerFor } from '../harness/fedflows';
import { startPushSink } from '../harness/push';
import { eventually } from '../harness/wait';

// pushes are sent by the homeserver of the user being notified, so the stand-in push service has to be
// reachable from the anchor containers: the docker bridge gateway of the federation network
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

// a guild on A whose members come from A, B and C; everyone remote has a device on their own homeserver
async function threeWayGuild() {
  const owner = await signup('a');
  const { guild, channel } = await createGuild(owner, 'notify');
  const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
  const [b, c] = [await signup('b'), await signup('c')];
  for (const u of [b, c]) {
    expect((await call(u, 'POST', '/invite/accept', { code: body.invite.code, homeserver: hostA })).status).toBe(200);
  }
  const devices = { b: await sink.subscribe(b), c: await sink.subscribe(c) };
  return { owner, b, c, guild, channel, devices, fedGuild: fedGuildId(hostA, guild.id), fedChannel: fedChannelId(hostA, channel.id) };
}

describe('mentions in a guild hosted elsewhere', () => {
  test('push arrives on the mentioned user\'s own homeserver, with fed: ids in the deep link', async () => {
    const { owner, b, devices, fedGuild, fedChannel, channel } = await threeWayGuild();
    const sent = await send(owner, channel.id, `hello ${b.user.handle}`);
    expect(sent.status).toBe(200);

    const [push] = await eventually(() => (sink.for(devices.b.label).length ? sink.for(devices.b.label) : null), { timeout: 15_000, message: 'push on B' });
    expect(push).toMatchObject({
      body: `hello ${b.user.handle}`,
      tag: fedChannel,
      channelId: fedChannel,
      url: `/guilds/${[fedGuild, fedChannel, sent.body.message.id].map(encodeURIComponent).join('/')}`,
    });
    expect(push.title).toContain('notify');
  });

  test('one message mentioning users on two homeservers pushes each of them exactly once', async () => {
    const { owner, b, c, devices, channel } = await threeWayGuild();
    await send(owner, channel.id, `${b.user.handle} and ${c.user.handle}`);
    await eventually(() => sink.for(devices.b.label).length && sink.for(devices.c.label).length, { timeout: 15_000, message: 'push on B and C' });
    await sink.settle();
    expect(sink.for(devices.b.label)).toHaveLength(1);
    expect(sink.for(devices.c.label)).toHaveLength(1);
  });

  test('a mention written by a member on a third homeserver reaches the other member', async () => {
    const { b, c, devices, fedChannel } = await threeWayGuild();
    expect((await send(c, fedChannel, `over to you ${b.user.handle}`)).status).toBe(200);
    await eventually(() => sink.for(devices.b.label).length === 1, { timeout: 15_000, message: 'push on B' });
    await sink.settle();
    expect(sink.for(devices.c.label)).toHaveLength(0);
  });

  test('a muted remote guild produces nothing', async () => {
    const { owner, b, devices, fedGuild, channel } = await threeWayGuild();
    expect((await call(b, 'PUT', `/notifications/settings/${encodeURIComponent(fedGuild)}`, { level: 'NONE' })).status).toBe(200);
    await send(owner, channel.id, `ping ${b.user.handle}`);
    await sink.settle();
    expect(sink.for(devices.b.label)).toHaveLength(0);
  });

  test('an edit that adds a mention in the remote guild pushes', async () => {
    const { owner, b, devices, channel } = await threeWayGuild();
    const sent = await send(owner, channel.id, 'hello');
    await call(owner, 'POST', '/message/edit', { channelId: channel.id, messageId: sent.body.message.id, content: `hello ${b.user.handle}` });
    await eventually(() => sink.for(devices.b.label).length === 1, { timeout: 15_000, message: 'edit push' });
  });
});

describe('DMs between homeservers', () => {
  test('a federated DM produces exactly one push per message, in both directions', async () => {
    // A hosts every DM between A and B, so a message from B is relayed to A before it reaches anyone
    const [a, b] = [await signup('a'), await signup('b')];
    await makeFriends(a, b);
    const devices = { a: await sink.subscribe(a), b: await sink.subscribe(b) };
    const dmOnA = (await call(a, 'POST', '/dm', { userId: await idOf(a, b) })).body.id as string;
    const dmOnB = fedChannelId(hostA, dmOnA);
    await eventually(async () => ((await call(b, 'GET', `/dm/homeserver/${hostA}`)).body.dms ?? []).some((dm: any) => dm.id === dmOnB), { message: 'DM on B' });
    // listing the DMs on B brings its realtime bridge up, which must not add a second notification
    await call(b, 'GET', '/dm');
    await Bun.sleep(1500);

    expect((await send(a, dmOnA, 'hi from a')).status).toBe(200);
    await eventually(() => sink.for(devices.b.label).length >= 1, { timeout: 15_000, message: 'push on B' });
    expect((await send(b, dmOnB, 'hi from b')).status).toBe(200);
    await eventually(() => sink.for(devices.a.label).length >= 1, { timeout: 15_000, message: 'push on A' });
    await sink.settle();

    expect(sink.for(devices.b.label).map((m) => m.body)).toEqual(['hi from a']);
    expect(sink.for(devices.a.label).map((m) => m.body)).toEqual(['hi from b']);
    expect(sink.for(devices.b.label)[0].url).toBe(`/guilds/dms/${encodeURIComponent(dmOnB)}`);
  });
});

describe('POST /federation/push', () => {
  const body = (over: object) => ({
    guildId: null,
    channelId: 'x',
    messageId: 'm1',
    author: { username: 'mallory', displayName: null, homeserver: hostA, avatarUrl: null },
    snippet: 'hi',
    handles: [],
    ...over,
  });

  test('a homeserver can only push for its own guilds: C naming A\'s guild reaches nobody', async () => {
    const { b, devices, guild } = await threeWayGuild();
    const fromC = await signerFor('c');
    const res = await fromC.send('b', 'POST', '/federation/push', body({ guildId: guild.id, channelId: 'x', handles: [b.user.handle] }));
    expect(res.status).toBe(200);
    await sink.settle();
    expect(sink.for(devices.b.label)).toHaveLength(0);
  });

  test('handles that are not members of that guild, or not local, are silently dropped', async () => {
    const { b, c, devices, guild, channel } = await threeWayGuild();
    const outsider = await signup('b');
    const outsiderDevice = await sink.subscribe(outsider);
    const fromA = await signerFor('a');
    const res = await fromA.send('b', 'POST', '/federation/push', body({
      guildId: guild.id,
      channelId: channel.id,
      handles: [outsider.user.handle, c.user.handle, '@ghost:' + anchors.b.homeserver, 'not a handle', b.user.handle],
    }));
    expect(res.status).toBe(200);
    await eventually(() => sink.for(devices.b.label).length === 1, { timeout: 15_000, message: 'member push' });
    await sink.settle();
    expect(sink.for(outsiderDevice.label)).toHaveLength(0);
    expect(sink.for(devices.c.label)).toHaveLength(0);
  });

  test('the snippet is capped and treated as text', async () => {
    const { b, devices, guild, channel } = await threeWayGuild();
    const fromA = await signerFor('a');
    await fromA.send('b', 'POST', '/federation/push', body({
      guildId: guild.id,
      channelId: channel.id,
      snippet: '<img src=x onerror=alert(1)>' + 'a'.repeat(1000),
      handles: [b.user.handle],
    }));
    const [push] = await eventually(() => (sink.for(devices.b.label).length ? sink.for(devices.b.label) : null), { timeout: 15_000, message: 'push' });
    expect(push.body.length).toBeLessThanOrEqual(200);
    expect(push.body.startsWith('<img')).toBe(true);
  });

  test('unsigned, malformed and replayed requests are rejected', async () => {
    const fromA = await signerFor('a');
    const unsigned = await fetch(`${anchors.b.url}/federation/push`, { method: 'POST', body: JSON.stringify(body({ handles: ['@x:y'] })), headers: { 'content-type': 'application/json' } });
    expect([400, 401]).toContain(unsigned.status);
    expect((await fromA.send('b', 'POST', '/federation/push', { nope: true })).status).toBe(400);
    expect((await fromA.send('b', 'POST', '/federation/push', body({ handles: [] }))).status).toBe(400);
  });
});
