import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resetHarness, signup, start, stackIsUp, stop } from '../harness/federation';
import { call } from '../harness/chat';
import { closePg, friendList, idOf, listHas, relationOn, requestFriend } from '../harness/fedflows';
import { eventually } from '../harness/wait';

// TESTING_PLAN §5.3 flow 2: B is down while A (authority) accepts. syncPending stays set; once B is back the 30s retry loop
// converges it with no client action, and a GET /friends on A triggers the retry immediately.
let bStopped = false;
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(async () => {
  if (bStopped) await start('b');
  await closePg();
});

test('B down during accept on A: converges via GET /friends and via the 30s retry loop', async () => {
  const bUsers = [await signup('b'), await signup('b')];
  const aUsers = [await signup('a'), await signup('a')];
  // B users request A users (command on A, then sync back), so A holds a PENDING request to accept
  for (const i of [0, 1]) {
    expect((await requestFriend(bUsers[i]!, aUsers[i]!)).status).toBe(200);
    await eventually(async () => listHas((await friendList(aUsers[i]!)).incoming, bUsers[i]!), { message: `a${i} incoming` });
  }
  const ids = await Promise.all([0, 1].map((i) => idOf(aUsers[i]!, bUsers[i]!)));

  await stop('b');
  bStopped = true;
  for (const i of [0, 1]) {
    // A is the authority: it accepts locally even though the sync to B fails
    expect((await call(aUsers[i]!, 'POST', `/friends/requests/${ids[i]}/accept`)).status).toBe(200);
    expect(await relationOn('a', aUsers[i]!.user.username, bUsers[i]!.user.username)).toMatchObject({ status: 'ACCEPTED', syncPending: true });
  }
  // while B is down, nothing converges
  await Bun.sleep(1000);
  expect((await relationOn('a', aUsers[0]!.user.username, bUsers[0]!.user.username))!.syncPending).toBe(true);

  await start('b');
  bStopped = false;
  expect((await relationOn('b', aUsers[0]!.user.username, bUsers[0]!.user.username))!.status).toBe('PENDING');

  // path 1: a client GET /friends on A retries immediately (poll it; the first attempts may hit a cached failed discovery)
  const startedAt = Date.now();
  await eventually(
    async () => {
      await friendList(aUsers[0]!);
      return (await relationOn('b', aUsers[0]!.user.username, bUsers[0]!.user.username))?.status === 'ACCEPTED';
    },
    { timeout: 40_000, interval: 1000, message: 'GET /friends on A converged B' }
  );
  expect((await relationOn('a', aUsers[0]!.user.username, bUsers[0]!.user.username))!.syncPending).toBe(false);
  expect(listHas((await friendList(bUsers[0]!)).accepted, aUsers[0]!)).toBe(true);

  // path 2: no client action at all on pair 1; the 30s timer on A does it (about 40s at most, plus the failure-cache window)
  await eventually(async () => (await relationOn('b', aUsers[1]!.user.username, bUsers[1]!.user.username))?.status === 'ACCEPTED', {
    timeout: 70_000 - (Date.now() - startedAt),
    interval: 1000,
    message: 'retry loop converged B with no client action',
  });
  expect((await relationOn('a', aUsers[1]!.user.username, bUsers[1]!.user.username))!.syncPending).toBe(false);
}, 150_000);
