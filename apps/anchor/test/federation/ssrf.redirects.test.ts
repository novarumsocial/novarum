// TESTING_PLAN.md 5.4 D: redirects. Whatever the remote answers with a 3xx must not be followed: not for discovery, not for signed
// POSTs, not for the user lookup, and not for the bridge WebSocket handshake.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { fake, stackIsUp } from '../harness/federation';
import { bunIn, clean, dropShadows, expectRefused, freshAnchor, makeActor, noStray, pgFor, publicDiscovery, runTriggers, strayTraffic, type Actor } from '../harness/ssrf';
import { eventually } from '../harness/wait';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const pg = pgFor('p');
let ctx: { actor: Actor; pg: typeof pg };

const statuses = [301, 302, 303, 307, 308];
const locations = {
  canary: 'http://172.30.0.99/hit',
  loopback: 'http://127.0.0.1:8080/hit',
  'another public host': 'https://evil2.test/hit',
  'relative path': '/elsewhere',
};
// requests to evil.test's own federation routes are expected; a request to /hit or /elsewhere (or anything on evil2.test) means a redirect was followed
const expected = /^\/(\.well-known|federation)\//;
const nothingFollowed = async () => {
  expect(await strayTraffic(expected)).toEqual(noStray);
  expect((await fake.requests(1)).map((r) => r.path)).not.toContain('/elsewhere');
};

beforeAll(async () => {
  await stackIsUp();
  await freshAnchor('p');
  ctx = { actor: await makeActor('p'), pg };
}, 60_000);
afterAll(async () => {
  await dropShadows(pg, ctx.actor);
  await pg.close();
  await freshAnchor('p'); // stops the bridges' reconnect timers
}, 60_000);
beforeEach(clean);

describe('D. discovery', () => {
  const discover = `
    import { discoverRemoteAnchor } from './utils/discovery';
    const out = await discoverRemoteAnchor('evil.test').then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.message ?? e) }));
    console.log(JSON.stringify(out));
    process.exit(0);`;

  // a fresh bun process in anchor-p's container runs the anchor's own discoverRemoteAnchor (own cache, so every combination really fetches)
  test.each(statuses)('%d, every location (fresh process)', async (status) => {
    for (const [name, redirect] of Object.entries(locations)) {
      await clean();
      await fake.respond(1, '/.well-known/anchor/info', { redirect, status });
      const out = await bunIn('p', discover);
      expect({ name, ok: out.ok, error: out.error }).toMatchObject({ name, ok: false, error: expect.stringMatching(/redirect/i) });
      expect((await fake.requests(1)).map((r) => r.path)).toEqual(['/.well-known/anchor/info']);
      expect(await strayTraffic(expected)).toEqual(noStray);
    }
  });

  // and once per status through the running anchor (T1 .. T6 against a target whose discovery redirects)
  test.each(statuses)('%d through every trigger on the running anchor', async (status) => {
    await freshAnchor('p');
    await fake.respond(1, '/.well-known/anchor/info', { redirect: locations.canary, status });
    await expectRefused(ctx, 'evil.test', { reason: /redirect/i, ignoreFake: expected });
  });
});

describe('D. after a successful discovery', () => {
  beforeAll(() => freshAnchor('p'), 60_000);


  test.each(statuses)('signed POST (T4, T6) answered with %d: the call fails and nothing is followed', async (status) => {
    for (const [name, redirect] of Object.entries(locations)) {
      await clean();
      await publicDiscovery();
      await fake.respond(1, 'POST /federation/*', { redirect, status });
      const results = await runTriggers(ctx, 'evil.test', ['T4', 'T6']);
      expect({ name, T4: results.T4!.map((p) => p.status), T6: results.T6!.map((p) => p.status) }).toEqual({ name, T4: [502], T6: [502, 502, 502, 502] });
      expect((await fake.requests(1)).filter((r) => r.method === 'POST').length).toBeGreaterThan(0);
      await nothingFollowed();
    }
  });

  test.each(statuses)('user lookup (T3) answered with %d: refused (redirect: error)', async (status) => {
    for (const [name, redirect] of Object.entries(locations)) {
      await clean();
      await publicDiscovery();
      await fake.respond(1, 'GET /federation/users/*', { redirect, status });
      const [probe] = (await runTriggers(ctx, 'evil.test', ['T3'])).T3!;
      expect({ name, status: probe!.status }).toEqual({ name, status: 502 });
      expect((await fake.requests(1, { path: '/federation/users' })).length).toBe(1);
      await nothingFollowed();
    }
  });

  test.each(statuses)('bridge handshake (T5) answered with %d: the bridge does not connect anywhere else', async (status) => {
    for (const [name, redirect] of Object.entries(locations)) {
      await clean();
      await publicDiscovery();
      await fake.respond(1, 'GET /federation/realtime/*', { redirect, status });
      await runTriggers(ctx, 'evil.test', ['T5']);
      // the handshake did reach the fake ...
      await eventually(async () => (await fake.requests(1, { path: '/federation/realtime' })).length > 0, { message: `${name}: bridge handshake` });
      // ... and a followed redirect would have shown up by now
      await Bun.sleep(300);
      await nothingFollowed();
    }
  });
});
