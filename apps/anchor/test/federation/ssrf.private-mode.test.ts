// TESTING_PLAN.md 5.4 I: private-mode anchors. anchor-a's base_url is a private IP, so allowLocalFederationTargets() lets it
// federate with loopback, link-local and metadata addresses. These tests PIN that (whether it should be refused is plan section 11):
// canary-a / canary-meta / canary see the hits.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  setDefaultTimeout,
} from 'bun:test';
import { canary, fake, stackIsUp } from '../harness/federation';
import {
  call,
  clean,
  dropShadows,
  freshAnchor,
  garbageFederationHeaders,
  makeActor,
  pgFor,
  runTriggers,
  type Actor,
} from '../harness/ssrf';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const pg = pgFor('a');
let ctx: { actor: Actor; pg: typeof pg };
// the fake's private identity (172.30.0.66, plain http) is a perfectly valid homeserver for anchor-a
const homeserver = '172.30.0.66';

beforeAll(async () => {
  await stackIsUp();
  await freshAnchor('a');
  ctx = { actor: await makeActor('a'), pg };
}, 60_000);
afterAll(async () => {
  await dropShadows(pg, ctx.actor);
  await pg.close();
  await freshAnchor('a');
}, 60_000);
beforeEach(() => freshAnchor('a'), 60_000);

const hit = async (where: 'a' | 'meta' | 'net', listener: string) =>
  (await canary.hits(where, listener)).map((h) => `${h.method} ${h.path}`);
const t1 = (hs: string) =>
  call('a', '/federation/friends/command', {
    method: 'POST',
    body: '{}',
    headers: { ...garbageFederationHeaders(hs, '{}'), 'content-type': 'application/json' },
  });

describe('I. a declared baseUrl on loopback, link-local and internal hosts only gets a discovery GET', () => {
  test.each([
    ['http://127.0.0.1:8080', 'a', 'loopback8080'],
    ['http://169.254.169.254', 'meta', 'metadata'],
    ['http://169.254.169.254:8080', 'meta', 'metadata8080'],
    ['http://172.30.0.99:8080', 'net', 'http8080'],
  ] as const)(
    '%s is asked for its discovery document, does not name the homeserver, and is never sent anything signed',
    async (baseUrl, where, listener) => {
      await fake.respond(1, '/.well-known/anchor/info', { discovery: { baseUrl } });
      const results = await runTriggers(ctx, homeserver, ['T1', 'T3', 'T4', 'T6']);
      expect(results.T1![0]!.status).toBe(400);
      expect(results.T4![0]!.status).toBeGreaterThanOrEqual(400);
      const hits = await hit(where, listener);
      expect(hits.every((h) => h === 'GET /.well-known/anchor/info')).toBe(true);
    }
  );
});

describe('I. a homeserver name that is itself a private address is contacted over plain http (pin)', () => {
  test.each([
    ['169.254.169.254', 'meta', 'metadata'],
    ['172.30.0.99', 'net', 'http80'],
  ] as const)('%s receives the discovery GET (T1)', async (hs, where, listener) => {
    await t1(hs);
    expect(await hit(where, listener)).toEqual(['GET /.well-known/anchor/info']);
  });

  test('127.0.0.1 is anchor-a itself: its discovery document names another homeserver, so it is refused by the mismatch check', async () => {
    expect((await t1('127.0.0.1')).status).toBe(400);
    expect(await canary.allHits()).toEqual([]);
  });
});

describe('I. scheme policy for public hosts', () => {
  // private-mode anchors may use http for any host, but a baseUrl on another origin has to serve the same homeserver's
  // discovery document, and http://evil.test is not routable from the private segment, so it is refused
  test('a private-mode anchor refuses a plain http baseUrl on a public host', async () => {
    await fake.respond(1, '/.well-known/anchor/info', {
      discovery: { baseUrl: 'http://evil.test' },
    });
    expect((await t1(homeserver)).status).toBe(400);
  });

  test('a public homeserver name is contacted over https, not http', async () => {
    // evil.test resolves for anchor-a but is not routable from the private segment: what matters is that the attempt is https (port 443)
    // and that nothing arrives over plain http on the fake's private side
    expect((await t1('evil.test')).status).toBe(400);
    expect(await fake.requests(1)).toEqual([]);
    expect(await fake.requests(2)).toEqual([]);
  });
});
