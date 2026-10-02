import { beforeAll, expect, test } from 'bun:test';
import { resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, nonce, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { fedGuildId } from '../harness/fedflows';
import { eventually } from '../harness/wait';

// found by the soak: several users of one anchor accepting invites to the same, not yet known remote guild at once
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});

// gap: the shadow guild row is inserted per accept without ON CONFLICT, so concurrent first joins from one anchor race on its primary key (500)
test.failing('concurrent first joins of a remote guild by several users of one anchor all succeed', async () => {
  const owner = await signup('a');
  const { guild } = await createGuild(owner);
  const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
  const joiners = await Promise.all(Array.from({ length: 6 }, () => signup('b')));
  const results = await Promise.all(joiners.map((u) => call(u, 'POST', '/invite/accept', { code: body.invite.code, homeserver: '172.30.0.11' })));
  expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
});

// gap (found by the soak): the sender's anchor publishes message.created to its own subscribers after a remote send, and the bridge from the
// host echoes the same event again, so every subscriber on the sender's anchor gets it twice
test.failing('a message sent from b into an a-hosted guild reaches b subscribers once', async () => {
  const owner = await signup('a');
  const { guild } = await createGuild(owner);
  const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
  const [sender, watcher] = [await signup('b'), await signup('b')];
  for (const u of [sender, watcher]) expect((await call(u, 'POST', '/invite/accept', { code: body.invite.code, homeserver: '172.30.0.11' })).status).toBe(200);
  const list = (await call(sender, 'GET', '/guilds/list')).body.guilds.find((g: any) => g.id === fedGuildId('172.30.0.11', guild.id));
  const rt = await connect(watcher);
  const n = nonce();
  expect((await send(sender, list.channels[0].id, 'once', { nonce: n })).status).toBe(200);
  await eventually(() => rt.events.some((e) => e.type === 'message.created' && e.data.nonce === n), { message: 'delivery' });
  await Bun.sleep(2000);
  expect(rt.events.filter((e) => e.type === 'message.created' && e.data.nonce === n)).toHaveLength(1);
  rt.close();
});
