import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resetHarness, restart, stackIsUp } from '../harness/federation';
import { call, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, joinedRoom } from '../harness/fedflows';
import { eventually } from '../harness/wait';

// TESTING_PLAN §5.3 flow 5: bridges across restarts of the host (A) and of the member server (B).
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const typingCount = (rt: { events: { type: string }[] }) => rt.events.filter((e) => e.type === 'channel.typing').length;

test('A restarts: B reconnects with backoff and the events resume', async () => {
  const { owner, channel, shadowChannel, rt } = await joinedRoom();
  const before = typingCount(rt);
  await restart('a');
  // B's bridge retries after 1s, 2s, 4s... (A needs a couple of seconds to boot); the owner's session survives in the database
  await eventually(
    async () => {
      await call(owner, 'POST', `/channel/${channel.id}/typing`);
      return typingCount(rt) > before;
    },
    { timeout: 40_000, interval: 500, message: 'bridge reconnected after the host restart' }
  );
  const sent = await send(owner, channel.id, 'after the restart');
  const evt = await rt.waitFor('message.created', (e) => e.data.content === 'after the restart');
  expect(evt.data.id).toBe(sent.body.message.id);
  expect(evt.data.channelId).toBe(shadowChannel);
  rt.close();
});

test('B restarts: the guild bridge is only re-created once a B client calls GET /guilds/list', async () => {
  const { owner, channel, member, rt } = await joinedRoom();
  rt.close();
  await restart('b');

  const rt2 = await connect(member);
  // nothing on B reconnects the guild bridge at boot (only DM bridges are restored), so A's events do not arrive
  for (let i = 0; i < 6; i++) {
    await call(owner, 'POST', `/channel/${channel.id}/typing`);
    await Bun.sleep(700);
  }
  expect(typingCount(rt2)).toBe(0);

  // pinned current behaviour (whether it is acceptable is open in the plan): the next /guilds/list starts the bridge
  expect((await call(member, 'GET', '/guilds/list')).status).toBe(200);
  await eventually(
    async () => {
      await call(owner, 'POST', `/channel/${channel.id}/typing`);
      return typingCount(rt2) > 0;
    },
    { timeout: 15_000, interval: 300, message: 'bridge re-created by /guilds/list' }
  );
  rt2.close();
});
