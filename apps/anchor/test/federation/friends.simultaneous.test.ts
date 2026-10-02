import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resetHarness, signup, stackIsUp } from '../harness/federation';
import { closePg, friendList, relationOn, requestFriend } from '../harness/fedflows';
import { eventually } from '../harness/wait';

// TESTING_PLAN §5.3 flow 2: simultaneous requests from both sides must converge, never diverge (20 iterations).
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const iterations = 20;

test(`both sides request each other at once, ${iterations} times: converge to ACCEPTED or one PENDING`, async () => {
  const outcomes: string[] = [];
  for (let batch = 0; batch < iterations / 5; batch++) {
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const [a, b] = [await signup('a'), await signup('b')];
        await Promise.all([requestFriend(a, b), requestFriend(b, a)]);
        // GET /friends re-triggers any pending sync, so poll it like a client would
        const settled = await eventually(
          async () => {
            await Promise.all([friendList(a), friendList(b)]);
            const [ra, rb] = await Promise.all([relationOn('a', a.user.username, b.user.username), relationOn('b', a.user.username, b.user.username)]);
            if (!ra || !rb || ra.syncPending || rb.syncPending) return null;
            return ra.status === rb.status && ra.version === rb.version && ra.requestedBy === rb.requestedBy ? ra : null;
          },
          { timeout: 45_000, interval: 500, message: `${a.user.username}<->${b.user.username} converged` }
        );
        expect(['ACCEPTED', 'PENDING']).toContain(settled.status);
        // the lists agree with the rows
        const [la, lb] = await Promise.all([friendList(a), friendList(b)]);
        if (settled.status === 'ACCEPTED') {
          expect([la.accepted.length, lb.accepted.length]).toEqual([1, 1]);
        } else {
          expect(la.incoming.length + la.outgoing.length).toBe(1);
          expect(lb.incoming.length + lb.outgoing.length).toBe(1);
          // exactly one side owes an answer
          expect(la.incoming.length + lb.incoming.length).toBe(1);
        }
        outcomes.push(settled.status);
      })
    );
  }
  expect(outcomes).toHaveLength(iterations);
});
