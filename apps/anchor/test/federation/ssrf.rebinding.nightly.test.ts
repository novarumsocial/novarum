// TESTING_PLAN.md 5.4 E: DNS rebinding / time-of-check vs time-of-use. `dns.rebind(name, [public, private])` (TTL 0) answers the
// safety check with the public address and the next lookup (the one fetch does) with the private one.
//  - anchor-p resolves in-process, so the request lands on the canary: known gap, written as test.failing.
//  - anchor-q goes through smokescreen, which resolves again and denies the private answer: the same rows pass.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { canary, dns, proxy, stackIsUp } from '../harness/federation';
import { call, clean, dropShadows, freshAnchor, garbageFederationHeaders, makeActor, pgFor, publicDiscovery, runTriggers, type Actor } from '../harness/ssrf';
import { eventually } from '../harness/wait';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const pub = '203.0.113.66';
const pgs = { p: pgFor('p'), q: pgFor('q') };
const ctxs = {} as Record<'p' | 'q', { actor: Actor; pg: (typeof pgs)['p'] }>;

const t1 = (name: 'p' | 'q', hs: string) => call(name, '/federation/friends/command', { method: 'POST', body: '{}', headers: { ...garbageFederationHeaders(hs, '{}'), 'content-type': 'application/json' } });
const deniedFor = async (host: string) => (await proxy.denies()).filter((l) => l.includes(`"requested_host":"${host}:443"`));

beforeAll(async () => {
  await stackIsUp();
  for (const name of ['p', 'q'] as const) ctxs[name] = { actor: await makeActor(name), pg: pgs[name] };
}, 120_000);
afterAll(async () => {
  for (const name of ['p', 'q'] as const) {
    await dropShadows(pgs[name], ctxs[name].actor);
    await pgs[name].close();
    await freshAnchor(name);
  }
}, 120_000);
beforeEach(async () => {
  await freshAnchor('p');
  await freshAnchor('q');
}, 120_000);

/** evil.test is discovered normally and declares `baseUrl`; the first request warms the discovery cache */
async function warmWithBaseUrl(name: 'p' | 'q', baseUrl: string) {
  await publicDiscovery({ baseUrl });
  expect((await t1(name, 'evil.test')).status).toBe(401); // discovery accepted, key unknown
}

// what each row asserts: nothing reached the canary
const noCanaryHits = async () => expect(await canary.allHits()).toEqual([]);

describe('E1. discovery: the check sees the public answer, fetch the private one', () => {
  test.failing('anchor-p: known gap, the discovery request reaches the canary', async () => {
    await dns.rebind('rb1.test', [pub, '172.30.0.99']);
    await t1('p', 'rb1.test');
    await noCanaryHits();
  });

  test('anchor-q: smokescreen denies the second answer', async () => {
    await dns.rebind('rb1.test', [pub, '172.30.0.99']);
    expect((await t1('q', 'rb1.test')).status).toBe(400);
    await noCanaryHits();
    expect(await eventually(() => deniedFor('rb1.test'), { message: 'proxy deny log for rb1.test' })).not.toEqual([]);
  });
});

describe('E2. baseUrl rebinds to a private address inside the 5 minute cache, then a signed POST (T4)', () => {
  const rebindAfterDiscovery = async (name: 'p' | 'q') => {
    await dns.set('rb2.test', pub);
    await warmWithBaseUrl(name, 'https://rb2.test');
    // postSignedFederationJson checks again, but Bun caches the lookup of the discovery check for ~30s, so only fetch's own
    // resolution sees the new (private) answer
    await dns.set('rb2.test', '172.30.0.99');
    await runTriggers(ctxs[name], 'evil.test', ['T4']);
  };

  test.failing('anchor-p: known gap, the signed POST reaches the canary', async () => {
    await rebindAfterDiscovery('p');
    await noCanaryHits();
  });

  test('anchor-q: smokescreen denies it', async () => {
    await rebindAfterDiscovery('q');
    await noCanaryHits();
    expect(await eventually(() => deniedFor('rb2.test'), { message: 'proxy deny log for rb2.test' })).not.toEqual([]);
  });
});

describe('E3. same rebind, then the paths that never re-check the address', () => {
  // fetchFederatedUser and the bridge reuse the cached baseUrl without calling assertSafeFederationUrl
  const warm = async (name: 'p' | 'q') => {
    await dns.set('rb3.test', pub);
    await warmWithBaseUrl(name, 'https://rb3.test');
    await dns.set('rb3.test', '172.30.0.99');
  };

  test.failing('anchor-p: known gap, the user lookup (T3) reaches the canary', async () => {
    await warm('p');
    await runTriggers(ctxs.p, 'evil.test', ['T3']);
    await noCanaryHits();
  });

  test.failing('anchor-p: known gap, the bridge WebSocket (T5) reaches the canary', async () => {
    await warm('p');
    await runTriggers(ctxs.p, 'evil.test', ['T5']);
    await Bun.sleep(1500);
    await noCanaryHits();
  });

  test('anchor-q: the user lookup (T3) is denied by smokescreen', async () => {
    await warm('q');
    await runTriggers(ctxs.q, 'evil.test', ['T3']);
    await noCanaryHits();
    expect(await eventually(() => deniedFor('rb3.test'), { message: 'proxy deny log for rb3.test' })).not.toEqual([]);
  });
});

describe('E4. rebind to the anchor itself (127.0.0.1)', () => {
  // https://127.0.0.1 is anchor-p's own loopback:443, where canary-p listens; a successful attack could call its own unauthenticated routes
  test.failing('anchor-p: known gap, the request reaches its own loopback', async () => {
    await dns.rebind('rb4.test', [pub, '127.0.0.1']);
    await t1('p', 'rb4.test');
    expect(await canary.hits('p')).toEqual([]);
  });

  test('anchor-q: smokescreen denies loopback', async () => {
    await dns.rebind('rb4.test', [pub, '127.0.0.1']);
    await t1('q', 'rb4.test');
    expect(await eventually(() => deniedFor('rb4.test'), { message: 'proxy deny log for rb4.test' })).not.toEqual([]);
  });
});
