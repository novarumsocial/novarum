import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, pause, resetHarness, signup, stackIsUp, unpause } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { closePg, fedChannelId, fedGuildId, pg } from '../harness/fedflows';
import { eventually } from '../harness/wait';

// TESTING_PLAN §5.3 flow 8: `docker pause` as a network partition. Federation calls fail after the 10s timeout with 502, the
// request does not hang beyond that, local features keep working, and the next call after the unpause recovers.
const paused = new Set<'a' | 'b'>();
const hold = async (name: 'a' | 'b') => {
  await pause(name);
  paused.add(name);
};
const release = async (name: 'a' | 'b') => {
  if (paused.delete(name)) await unpause(name);
};

beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(async () => {
  await release('a');
  await release('b');
  await closePg();
});

const timed = async <T>(fn: () => Promise<T>) => {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
};

describe('B paused', () => {
  test('A fails fast with 502, marks B\'s shadow guilds down, keeps local features, and recovers after the unpause', async () => {
    // a guild hosted on B with an A member, and a purely local A guild
    const bOwner = await signup('b');
    const { guild: bGuild, channel: bChannel } = await createGuild(bOwner, 'on-b');
    const invite = (await call(bOwner, 'POST', `/guilds/${bGuild.id}/invites`, {})).body.invite.code as string;
    const aUser = await signup('a');
    expect((await call(aUser, 'POST', '/invite/accept', { code: invite, homeserver: anchors.b.homeserver })).status).toBe(200);
    const shadowGuild = fedGuildId(anchors.b.homeserver, bGuild.id);
    const shadowChannel = fedChannelId(anchors.b.homeserver, bChannel.id);
    const { channel: localChannel } = await createGuild(aUser, 'local');
    const bUser = await signup('b');

    await hold('b');
    // a remote call fails with 502 after about the federation timeout, not later
    const remote = await timed(() => call(aUser, 'GET', `/message/list?channelId=${encodeURIComponent(shadowChannel)}&cursor=0&amount=50`));
    expect(remote.value.status).toBe(502);
    expect(remote.ms).toBeGreaterThan(8000);
    expect(remote.ms).toBeLessThan(14_000);

    // the failure marked the shadow guild down
    const [row] = await pg('a')`SELECT "extAnchorDown" AS down FROM guild WHERE id = ${shadowGuild}`;
    expect(row!.down).toBe(true);

    // local features are unaffected, also while a remote call is hanging
    const hanging = call(aUser, 'POST', '/friends/request', { username: bUser.user.username, homeserver: anchors.b.homeserver });
    const local = await timed(async () => {
      const sent = await send(aUser, localChannel.id, 'local during the partition');
      const list = await call(aUser, 'GET', `/message/list?channelId=${localChannel.id}&cursor=0&amount=50`);
      return [sent.status, list.status, list.body.messages.length];
    });
    expect(local.value).toEqual([200, 200, 1]);
    expect(local.ms).toBeLessThan(1500);
    expect((await hanging).status).toBe(502);

    // the guild list reports the shadow guild as down (the remote unread-mentions call times out, it still answers)
    const listed = await timed(() => call(aUser, 'GET', '/guilds/list'));
    expect(listed.value.status).toBe(200);
    expect(listed.value.body.guilds.find((g: any) => g.id === shadowGuild).down).toBe(true);
    expect(listed.ms).toBeLessThan(14_000);

    await release('b');
    // a discovery that failed during the outage is cached for 30s, so recovery takes up to that long; the next call that
    // gets through re-discovers B and flips extAnchorDown back
    const recovered = await eventually(
      async () => {
        const res = await call(aUser, 'GET', `/message/list?channelId=${encodeURIComponent(shadowChannel)}&cursor=0&amount=50`);
        return res.status === 200 ? res : null;
      },
      { timeout: 45_000, interval: 1000, message: 'message list recovers after unpause' }
    );
    expect(recovered.body.messages).toEqual([]);
    const [after] = await pg('a')`SELECT "extAnchorDown" AS down FROM guild WHERE id = ${shadowGuild}`;
    expect(after!.down).toBe(false);
    expect((await call(aUser, 'GET', '/guilds/list')).body.guilds.find((g: any) => g.id === shadowGuild).down).toBe(false);
  }, 120_000);
});

describe('A paused', () => {
  test('a B user accepting an invite or sending a message to A gets 502 within the timeout', async () => {
    const aOwner = await signup('a');
    const { guild, channel } = await createGuild(aOwner, 'on-a');
    const invite = (await call(aOwner, 'POST', `/guilds/${guild.id}/invites`, {})).body.invite.code as string;
    const bUser = await signup('b');
    const bMember = await signup('b');
    expect((await call(bMember, 'POST', '/invite/accept', { code: invite, homeserver: anchors.a.homeserver })).status).toBe(200);

    await hold('a');
    const accept = await timed(() => call(bUser, 'POST', '/invite/accept', { code: invite, homeserver: anchors.a.homeserver }));
    expect(accept.value.status).toBe(502);
    expect(accept.ms).toBeLessThan(14_000);
    const msg = await timed(() => send(bMember, fedChannelId(anchors.a.homeserver, channel.id), 'into the void'));
    expect(msg.value.status).toBe(502);
    expect(msg.ms).toBeLessThan(14_000);
    // B's local features are unaffected
    const { channel: bLocal } = await createGuild(bUser, 'b-local');
    const local = await timed(() => send(bUser, bLocal.id, 'still here'));
    expect(local.value.status).toBe(200);
    expect(local.ms).toBeLessThan(1500);
    await release('a');

    const joined = await eventually(
      async () => {
        const res = await call(bUser, 'POST', '/invite/accept', { code: invite, homeserver: anchors.a.homeserver });
        return res.status === 200 ? res : null;
      },
      { timeout: 45_000, interval: 1000, message: 'invite accept recovers after unpause' }
    );
    expect(joined.body.guildId).toBe(fedGuildId(anchors.a.homeserver, guild.id));
  }, 120_000);
});
