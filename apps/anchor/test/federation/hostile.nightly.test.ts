// TESTING_PLAN.md 5.4 H: hostile response bodies from a remote homeserver (discovery and POST replies) and hostile keys.
// anchor-p must give up within the 10s federation timeout and not balloon: peak RSS growth under 100 MB (sampled from /proc inside the container).
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  setDefaultTimeout,
} from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { anchors, fake, stackIsUp } from '../harness/federation';
import {
  call,
  clean,
  dropShadows,
  freshAnchor,
  garbageFederationHeaders,
  makeActor,
  pgFor,
  publicDiscovery,
  rssMb,
  runTriggers,
  type Actor,
} from '../harness/ssrf';
import type { Behaviour } from '../harness/fakeAnchor';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const pg = pgFor('p');
let ctx: { actor: Actor; pg: typeof pg };
const GB = 2 ** 30;

beforeAll(async () => {
  await stackIsUp();
  await freshAnchor('p');
  ctx = { actor: await makeActor('p'), pg };
}, 60_000);
afterAll(async () => {
  await dropShadows(pg, ctx.actor);
  await pg.close();
  await freshAnchor('p');
}, 60_000);
beforeEach(() => freshAnchor('p'), 60_000);

const t1 = (hs: string) =>
  call('p', '/federation/friends/command', {
    method: 'POST',
    body: '{}',
    headers: { ...garbageFederationHeaders(hs, '{}'), 'content-type': 'application/json' },
  });
const alive = async () =>
  expect(await (await fetch(`${anchors.p.url}/`)).text()).toBe('this is anchor');

/** runs `fn` while sampling the anchor's RSS; returns how long it took and the peak growth over the starting value */
async function watched<T>(fn: () => Promise<T>) {
  const before = await rssMb('p');
  let peak = before;
  let running = true;
  const sampler = (async () => {
    while (running) peak = Math.max(peak, await rssMb('p'));
  })();
  const started = Date.now();
  const result = await fn();
  const elapsed = Date.now() - started;
  running = false;
  await sampler;
  peak = Math.max(peak, await rssMb('p'));
  return { result, elapsed, growthMb: peak - before };
}

type Where = 'discovery' | 'POST reply';
/** serves `behaviour` as the discovery document, or as the reply to the signed POST of T4 (after a normal discovery) */
async function serve(where: Where, behaviour: Behaviour) {
  if (where === 'discovery') return fake.respond(1, '/.well-known/anchor/info', behaviour);
  await publicDiscovery();
  expect((await t1('evil.test')).status).toBe(401); // warm the cache
  return fake.respond(1, 'POST /federation/*', behaviour);
}
const trigger = (where: Where) =>
  where === 'discovery'
    ? t1('evil.test')
    : runTriggers(ctx, 'evil.test', ['T4']).then((r) => r.T4![0]!);

const wheres: Where[] = ['discovery', 'POST reply'];

describe('H. bodies that never end or never fit', () => {
  const bodies: [string, Behaviour][] = [
    ['1 GB body', { hugeBytes: GB }],
    ['endless chunked stream', { drip: { bytes: -1, chunkBytes: 64 * 1024, intervalMs: 1 } }],
    ['1 byte per second drip', { drip: { bytes: -1, chunkBytes: 1, intervalMs: 1000 } }],
    ['gzip bomb (10 MB that inflate to 10 GB)', { gzipBombBytes: 10 * GB }],
  ];

  for (const [label, behaviour] of bodies) {
    for (const where of wheres) {
      // no size limit on remote bodies: the 1 GB body and the endless stream are buffered whole (+3 GB / +300-750 MB RSS in 10s)
      const run = /1 GB|endless/.test(label) ? test.failing : test;
      run(`${label} as ${where}: aborted within about 10s, RSS growth under 100 MB`, async () => {
        await serve(where, behaviour);
        const { result, elapsed, growthMb } = await watched(() => trigger(where));
        console.log(
          `[H] ${label} / ${where}: ${elapsed} ms, +${growthMb.toFixed(0)} MB, status ${result.status}`
        );
        expect([400, 502]).toContain(result.status);
        expect(elapsed).toBeLessThan(15_000);
        expect(growthMb).toBeLessThan(100);
        await alive();
      });
    }
  }
});

describe('H. malformed bodies', () => {
  const bodies: [string, Behaviour][] = [
    ['invalid UTF-8', { invalidUtf8: true }],
    ['non-JSON (html)', { nonJson: true }],
    ['10k-deep nested JSON', { deepJson: 10_000 }],
  ];

  for (const [label, behaviour] of bodies) {
    for (const where of wheres) {
      test(`${label} as ${where}: 400/502, no crash`, async () => {
        await serve(where, behaviour);
        const result = await trigger(where);
        expect([400, 502]).toContain(result.status);
        await alive();
      });
    }
  }
});

describe('H. hostile discovery documents', () => {
  const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');
  const keys: [string, string, boolean][] = [
    // verifyMessage throws on these and nothing catches it: 500 instead of 401
    ['not base64', '***not*base64***', true],
    ['valid base64, not a key', 'AAAA', true],
    ['an RSA SPKI instead of ed25519', rsaKey, false],
  ];

  // the request is signed by the identity with the key id the document publishes, so verification reaches verifyMessage with the hostile key
  for (const [label, key, gap] of keys) {
    (gap ? test.failing : test)(`publicKey.key ${label}: 401, never 500`, async () => {
      await publicDiscovery({ publicKey: { id: 'hostile-key', algorithm: 'ed25519', key } });
      const res = await fake.send(
        1,
        'p',
        'POST',
        '/federation/friends/command',
        {},
        { homeserver: 'evil.test', host: new URL(anchors.p.url).host, keyId: 'hostile-key' }
      );
      expect(res.status).toBe(401);
      await alive();
    });
  }

  test.each([
    ['version is a number', { version: 5 }],
    ['baseUrl is a number', { baseUrl: 123 }],
    ['baseUrl is an object', { baseUrl: { a: 1 } }],
    ['homeserver is an array', { homeserver: ['evil.test'] }],
    ['publicKey is a string', { publicKey: 'ed25519' }],
  ])('%s is refused', async (_label, discovery) => {
    await publicDiscovery(discovery);
    expect((await t1('evil.test')).status).toBe(400);
    await alive();
  });
});
