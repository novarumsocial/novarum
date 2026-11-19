import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fedChannelId, idOf, makeFriends } from '../harness/fedflows';
import { eventually } from '../harness/wait';
import type { TestUser } from '../harness/users';

// pins in channels hosted on A, used by B users through B (which proxies to A)
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const hostA = anchors.a.homeserver;
const pin = (user: TestUser, channelId: string, messageId: string, pinned = true) =>
  call(user, 'POST', '/message/pin', { channelId, messageId, pinned });
const pinIds = async (user: TestUser, channelId: string) =>
  (
    await call(user, 'GET', `/message/pins?channelId=${encodeURIComponent(channelId)}`)
  ).body.messages.map((m: any) => m.id);

/** the bridge on B comes up asynchronously; the host typing is relayed once it is */
async function bridgeUp(host: TestUser, hostId: string, rt: Awaited<ReturnType<typeof connect>>) {
  const shadowId = fedChannelId(hostA, hostId);
  await eventually(
    async () => {
      await call(host, 'POST', `/channel/${hostId}/typing`);
      return rt.events.some((e) => e.type === 'channel.typing' && e.data.channelId === shadowId);
    },
    { timeout: 15_000, interval: 300, message: 'bridge up on b' }
  );
}

describe('pins in a remote guild', () => {
  test('the host owner pins; a B member sees it live and in the list but cannot pin', async () => {
    const owner = await signup('a');
    const { guild, channel } = await createGuild(owner, 'pins');
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    const joiner = await signup('b');
    expect(
      (await call(joiner, 'POST', '/invite/accept', { code: body.invite.code, homeserver: hostA }))
        .status
    ).toBe(200);
    const shadowChannel = fedChannelId(hostA, channel.id);
    const rt = await connect(joiner);
    await bridgeUp(owner, channel.id, rt);

    const msg = (await send(joiner, shadowChannel, 'pin me')).body.message;
    expect((await pin(joiner, shadowChannel, msg.id)).status).toBe(403);

    expect((await pin(owner, channel.id, msg.id)).status).toBe(200);
    const event = await rt.waitFor('message.pinned', (e) => e.data.id === msg.id);
    expect(event.data).toMatchObject({ channelId: shadowChannel, pinned: true });
    expect(await pinIds(joiner, shadowChannel)).toEqual([msg.id]);

    // deleting it on the host removes the pin
    await call(joiner, 'POST', '/message/delete', { channelId: shadowChannel, messageId: msg.id });
    expect(await pinIds(joiner, shadowChannel)).toEqual([]);
    expect(await pinIds(owner, channel.id)).toEqual([]);
  });
});

describe('pins in a remote DM', () => {
  test('the B participant pins and unpins through B; both sides see it', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    await makeFriends(a, b);
    const hostId = (await call(a, 'POST', '/dm', { userId: await idOf(a, b) })).body.id;
    const shadowId = fedChannelId(hostA, hostId);
    const rtA = await connect(a);
    const msg = (await send(a, hostId, 'remember this')).body.message;
    await eventually(
      async () => (await call(b, 'GET', `/dm/homeserver/${hostA}`)).body.dms?.length > 0,
      { message: 'shadow dm on b' }
    );

    const pinned = await pin(b, shadowId, msg.id);
    expect(pinned.status).toBe(200);
    expect(pinned.body.message).toMatchObject({ id: msg.id, channelId: shadowId, pinned: true });
    await rtA.waitFor('message.pinned', (e) => e.data.id === msg.id);
    expect(await pinIds(a, hostId)).toEqual([msg.id]);
    expect(await pinIds(b, shadowId)).toEqual([msg.id]);

    expect((await pin(b, shadowId, msg.id, false)).status).toBe(200);
    await rtA.waitFor('message.unpinned', (e) => e.data.id === msg.id);
    expect(await pinIds(a, hostId)).toEqual([]);
    expect((await pin(b, shadowId, 'nope')).status).toBe(404);
  });
});
