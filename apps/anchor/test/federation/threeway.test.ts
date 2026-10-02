import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fedChannelId, fedGuildId, idOf, makeFriends, openBridge, signerFor, userPayload } from '../harness/fedflows';
import { eventually } from '../harness/wait';
import { nonce } from '../harness/chat';

// TESTING_PLAN §5.3 flow 6: three real anchors. (The three-edge friend chain A<->B, B<->C, A<->C is in friends.test.ts.)
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const hostA = anchors.a.homeserver;

describe('a guild on A with members from B and C', () => {
  test('a message from C reaches B through A\'s bridge, and C sees its own', async () => {
    const owner = await signup('a');
    const { guild, channel } = await createGuild(owner, 'three');
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    const [b, c] = [await signup('b'), await signup('c')];
    for (const u of [b, c]) expect((await call(u, 'POST', '/invite/accept', { code: body.invite.code, homeserver: hostA })).status).toBe(200);
    const [rtB, rtC] = [await connect(b), await connect(c)];
    // the bridges come up asynchronously; A typing is relayed over them once they do
    await eventually(
      async () => {
        await call(owner, 'POST', `/channel/${channel.id}/typing`);
        return [rtB, rtC].every((rt) => rt.events.some((e) => e.type === 'channel.typing'));
      },
      { timeout: 15_000, interval: 300, message: 'both bridges up' }
    );

    const shadowChannel = fedChannelId(hostA, channel.id);
    const sent = await send(c, shadowChannel, 'hello from C');
    expect(sent.status).toBe(200);
    const onB = await rtB.waitFor('message.created', (e) => e.data.content === 'hello from C');
    expect(onB.data).toMatchObject({ channelId: shadowChannel, guildId: fedGuildId(hostA, guild.id) });
    expect(onB.data.author).toMatchObject({ username: c.user.username, homeserver: anchors.c.homeserver });
    // B can read it and the owner on A sees it
    expect((await call(b, 'GET', `/message/list?channelId=${encodeURIComponent(shadowChannel)}&cursor=0&amount=50`)).body.messages.map((m: any) => m.content)).toEqual(['hello from C']);
    expect((await call(owner, 'GET', `/message/list?channelId=${channel.id}&cursor=0&amount=50`)).body.messages[0].author.homeserver).toBe(anchors.c.homeserver);
    // the roster on A lists both remote members
    const users = (await call(owner, 'GET', `/channel/${channel.id}/users`)).body.users;
    expect(users.map((u: any) => u.homeserver).sort()).toEqual([anchors.a.homeserver, anchors.b.homeserver, anchors.c.homeserver].sort());
    rtB.close();
    rtC.close();
  });
});

describe('C is a stranger to a DM between A and B and to guilds it has not joined', () => {
  async function dmBetweenAandB() {
    const [a, b, c] = [await signup('a'), await signup('b'), await signup('c')];
    await makeFriends(a, b);
    // A knows C's user too, so a refusal is about the channel and not about an unknown user
    await makeFriends(a, c);
    const dmId = (await call(a, 'POST', '/dm', { userId: await idOf(a, b) })).body.id as string;
    await call(a, 'POST', `/channel/${dmId}/typing`); // sanity: the channel exists
    return { a, b, c, dmId, shadowDm: fedChannelId(hostA, dmId) };
  }

  test('every /federation/channels/:dm/* route signed by C is 403', async () => {
    const { a, b, c, dmId } = await dmBetweenAandB();
    await send(a, dmId, 'private');
    const fromC = await signerFor('c');
    const user = userPayload(c.user);
    const routes: [string, object][] = [
      ['messages', {}],
      ['messages/send', { content: 'intrusion', nonce: nonce() }],
      ['messages/edit', { messageId: 'x', content: 'x' }],
      ['messages/delete', { messageId: 'x' }],
      ['attachments/presign', { filename: 'f', contentType: 'text/plain', size: 3 }],
      ['users', {}],
      ['typing', {}],
      ['call/token', {}],
      ['voice-state', { connected: true }],
      ['ring', { ringing: true }],
    ];
    for (const [route, extra] of routes) {
      const res = await fromC.send('a', 'POST', `/federation/channels/${dmId}/${route}`, { user, ...extra });
      expect({ route, status: res.status }).toEqual({ route, status: 403 });
    }
    expect((await call(a, 'GET', `/message/list?channelId=${dmId}&cursor=0&amount=50`)).body.messages).toHaveLength(1);
    // the two participants are fine, C posing as B is not
    const fromB = await signerFor('b');
    expect((await fromB.send('a', 'POST', `/federation/channels/${dmId}/messages`, { user: userPayload(b.user) })).status).toBe(200);
    const poser = await fromC.send('a', 'POST', `/federation/channels/${dmId}/messages`, { user: userPayload(b.user) });
    expect(poser.status).toBe(401);
  });

  test('B\'s shadow of the DM does not let C in either, and C cannot open any DM bridge', async () => {
    const { b, c, dmId, shadowDm } = await dmBetweenAandB();
    const fromC = await signerFor('c');
    // the shadow channel on B exists, but C is not a member of it
    await eventually(async () => (await call(b, 'GET', `/dm/homeserver/${hostA}`)).body.dms.some((d: any) => d.id === shadowDm), { message: 'shadow on b' });
    const onB = await fromC.send('b', 'POST', `/federation/channels/${shadowDm}/messages`, { user: userPayload(c.user) });
    expect([403, 404]).toContain(onB.status);
    for (const [target, id] of [['a', dmId], ['b', shadowDm]] as const) {
      const bridge = await openBridge(target, 'dms', id, async (t, path) => fromC.headersFor(t, 'GET', path));
      expect(await bridge.waitClosed()).toMatchObject({ code: 1008, reason: 'Forbidden' });
    }
  });

  test('C cannot open the bridge of a guild it has no member in, nor read it', async () => {
    const owner = await signup('b'); // a guild hosted on B
    const { guild, channel } = await createGuild(owner, 'bonly');
    const c = await signup('c');
    const fromC = await signerFor('c');
    const bridge = await openBridge('b', 'guilds', guild.id, async (t, path) => fromC.headersFor(t, 'GET', path));
    expect(await bridge.waitClosed()).toMatchObject({ code: 1008, reason: 'Forbidden' });
    // A is no member either
    const fromA = await signerFor('a');
    const viaA = await openBridge('b', 'guilds', guild.id, async (t, path) => fromA.headersFor(t, 'GET', path));
    expect(await viaA.waitClosed()).toMatchObject({ code: 1008, reason: 'Forbidden' });
    // reading, typing and the roster are refused while C is not a member (C's user is not even known to B yet: 403 either way)
    for (const route of ['messages', 'users', 'typing']) {
      const res = await fromC.send('b', 'POST', `/federation/channels/${channel.id}/${route}`, { user: userPayload(c.user) });
      expect({ route, status: res.status }).toEqual({ route, status: 403 });
    }
    // once C joins, the same bridge is accepted
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    expect((await call(c, 'POST', '/invite/accept', { code: body.invite.code, homeserver: anchors.b.homeserver })).status).toBe(200);
    const ok = await openBridge('b', 'guilds', guild.id, async (t, path) => fromC.headersFor(t, 'GET', path));
    await ok.waitFor('voice.states.snapshot');
    expect(ok.closed).toBeNull();
    ok.close();
  });
});
