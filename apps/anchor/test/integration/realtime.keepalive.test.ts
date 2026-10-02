import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/realtime';
import { signup } from '../harness/users';

// misc.ping is a hardcoded 30s interval, so this is a wall-clock test (~35s).
// Skip it locally with ANCHOR_TEST_SLOW=0.
const slow = process.env.ANCHOR_TEST_SLOW !== '0';

describe.skipIf(!slow)('keepalive (slow)', () => {
  let anchor: RunningAnchor;
  beforeAll(async () => {
    anchor = await spawnAnchor({ name: 'keepalive' });
  });
  afterAll(() => anchor.destroy());

  test(
    'every socket, including a second tab, gets misc.ping at 30s; closed sockets get nothing and break nothing',
    async () => {
      const a = await signup(anchor.url);
      const b = await signup(anchor.url);
      const tab1 = await connect(a);
      const tab2 = await connect(a);
      const other = await connect(b);
      const closing = await connect(a);
      const closed = await connect(b);

      const pings = (rt: { events: { type: string }[] }) => rt.events.filter((e) => e.type === 'misc.ping').length;
      expect([tab1, tab2, other].map(pings)).toEqual([0, 0, 0]);

      // close well before the first interval fires
      closing.close();
      closed.close();
      await Promise.all([closing.waitClosed(), closed.waitClosed()]);

      await Promise.all([tab1, tab2, other].map((rt) => rt.waitFor('misc.ping', () => true, 35_000)));
      expect([tab1, tab2, other].map(pings)).toEqual([1, 1, 1]);
      expect([closing, closed].map(pings)).toEqual([0, 0]);

      // the closed sockets' timers were cleared: server is up and sockets still work
      expect((await fetch(`${anchor.url}/`)).ok).toBe(true);
      tab1.send({ type: 'emoji.search', query: 'x' });
      await tab1.waitFor('emoji.search.results');
      expect(anchor.logs()).not.toMatch(/error/i);
      for (const rt of [tab1, tab2, other]) rt.close();
    },
    50_000
  );
});
