// TESTING_PLAN.md 5.4 I: private-mode anchors. anchor-a's base_url is a private IP, so allowLocalFederationTargets() lets it
// federate with loopback, link-local and metadata addresses. These tests PIN that (whether it should be refused is plan section 11):
// canary-a / canary-meta / canary see the hits.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { canary, fake, stackIsUp } from '../harness/federation';
import { call, clean, dropShadows, freshAnchor, garbageFederationHeaders, makeActor, pgFor, runTriggers, type Actor } from '../harness/ssrf';

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

const hit = async (where: 'a' | 'meta' | 'net', listener: string) => (await canary.hits(where, listener)).map((h) => `${h.method} ${h.path}`);
const t1 = (hs: string) => call('a', '/federation/friends/command', { method: 'POST', body: '{}', headers: { ...garbageFederationHeaders(hs, '{}'), 'content-type': 'application/json' } });

describe('I. a declared baseUrl may point at loopback, link-local and internal hosts (pin)', () => {
  test.each([
    ['http://127.0.0.1:8080', 'a', 'loopback8080'],
    ['http://169.254.169.254', 'meta', 'metadata'],
    ['http://169.254.169.254:8080', 'meta', 'metadata8080'],
    ['http://172.30.0.99:8080', 'net', 'http8080'],
  ] as const)('%s receives the signed POST (T4) and the user lookup (T3)', async (baseUrl, where, listener) => {
    await fake.respond(1, '/.well-known/anchor/info', { discovery: { baseUrl } });
    const results = await runTriggers(ctx, homeserver, ['T1', 'T2', 'T3', 'T4', 'T6']);
    // discovery accepted the baseUrl: only the signature/key is wrong (T1/T2), the canary's answers are not valid federation replies (T3/T4/T6)
    expect(results.T1![0]!.status).toBe(401);
    expect(results.T2![0]).toMatchObject({ status: 1008, text: 'Unknown federation key' });
    expect(results.T3![0]!.status).toBe(404);
    expect(results.T4![0]!.status).toBe(502);
    expect(await hit(where, listener)).toEqual(expect.arrayContaining(['GET /federation/users/alice', 'POST /federation/invites/code1/accept']));
    expect((await hit(where, listener)).some((h) => h.includes('/messages/send'))).toBe(true);
    // the signed request carries the sender identity and is addressed to the hostile host
    const post = (await canary.hits(where, listener)).find((h) => h.method === 'POST' && h.path?.includes('/federation/invites'))!;
    expect(post.headers?.['x-novarum-homeserver']).toBe('172.30.0.11');
  });
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
  // The plan expects "http still refused for public targets". assertSafeFederationUrl lets private-mode anchors use http for any host,
  // so a discovered baseUrl of http://evil.test passes (anchor-a cannot route to the public side, so only the acceptance is visible).
  test.failing('known gap: a private-mode anchor refuses a plain http baseUrl on a public host', async () => {
    await fake.respond(1, '/.well-known/anchor/info', { discovery: { baseUrl: 'http://evil.test' } });
    expect((await t1(homeserver)).status).toBe(400); // today: 401 "Unknown federation key", discovery accepted the baseUrl
  });

  test('a public homeserver name is contacted over https, not http', async () => {
    // evil.test resolves for anchor-a but is not routable from the private segment: what matters is that the attempt is https (port 443)
    // and that nothing arrives over plain http on the fake's private side
    expect((await t1('evil.test')).status).toBe(400);
    expect(await fake.requests(1)).toEqual([]);
    expect(await fake.requests(2)).toEqual([]);
  });
});
