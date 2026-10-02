// TESTING_PLAN.md 5.4 A: address policy for homeserver names and DNS answers. anchor-p (public mode) is the anchor under test;
// every target is attempted through all triggers T1-T6 and must leave canaries and fakes untouched.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { canary, dns, fake, resetHarness, stackIsUp } from '../harness/federation';
import { bridgeSocket, clean, dropShadows, freshAnchor, expectRefused, logsSince, makeActor, noStray, pgFor, publicDiscovery, runTriggers, strayTraffic, type Actor } from '../harness/ssrf';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const policy = 'Federation URL cannot target local or private addresses';
const resolvesPrivate = 'Federation URL resolves to a local or private address';
const pg = pgFor('p');
let ctx: { actor: Actor; pg: typeof pg };

beforeAll(async () => {
  await stackIsUp();
  await freshAnchor('p'); // empty discovery cache, no leftover bridge timers
  ctx = { actor: await makeActor('p'), pg };
}, 60_000);
afterAll(async () => {
  await dropShadows(pg, ctx.actor);
  await pg.close();
  await freshAnchor('p');
}, 60_000);
beforeEach(clean);

describe('A. literal addresses are refused by policy', () => {
  test.each(['127.0.0.1', '10.0.0.1', '172.30.0.99', '169.254.169.254', '0.0.0.0', '100.64.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255'])('%s', async (hs) => {
    await expectRefused(ctx, hs, { reason: policy });
  });

  // URL parsing turns these into 127.0.0.1; the log line shows the normalised hostname the policy actually judged
  test.each(['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '017700000001'])('numeric loopback form %s', async (hs) => {
    expect(new URL(`https://${hs}`).hostname).toBe('127.0.0.1');
    await expectRefused(ctx, hs, { reason: policy, logHost: '127.0.0.1' });
  });

  // LOCALHOST is the same cache key as localhost (normalised), so only the first spelling logs a reason
  test.each(['localhost', 'LOCALHOST', 'foo.localhost'])('%s', async (hs) => {
    await expectRefused(ctx, hs, { reason: hs === 'LOCALHOST' ? undefined : policy, logHost: hs });
  });
});

describe('A. malformed names are rejected before any network I/O', () => {
  test.each(['localhost.', 'evil.test.', 'evil..test', 'evil_test', 'a:80.test', 'a/b.test', 'a@b.test', 'a\\b.test', 'bücher.test', 'exаmple.test', '🙂.test'])('%j', async (hs) => {
    // T2 is covered below for names that do not fit a latin1 header
    await expectRefused(ctx, hs, { names: /^[\x00-\xff]*$/.test(hs) ? undefined : ['T3', 'T4', 'T5', 'T6'] });
    // dns may log names (IDNs as punycode) from unrelated work, but never one of ours
    const asked = (await dns.queries()).map((q) => q.name);
    expect(asked.filter((n) => /evil|localhost|^a\b|xn--|bücher/.test(n))).toEqual([]);
  });
});

// found while writing this suite: open() builds the verification headers from the query string, `headers.set` throws a TypeError
// for a non-latin1 X-Novarum-Homeserver, and nothing closes the (unauthenticated) socket, so it stays open until the client leaves
test.failing('known gap: a bridge WebSocket with a non-latin1 homeserver is closed, not left open', async () => {
  expect(await bridgeSocket('p', 'ex\u0430mple.test')).toMatchObject({ status: 1008 });
});

describe('A. DNS answers', () => {
  const seq = (() => {
    let n = 0;
    return (label: string) => `${label}${n++}.test`;
  })();

  test.each([
    ['A 10.0.0.1', '10.0.0.1'],
    ['A 127.0.0.1', '127.0.0.1'],
    ['A 169.254.169.254', '169.254.169.254'],
    ['AAAA ::1', '::1'],
    ['AAAA fc00::1', 'fc00::1'],
    ['AAAA fe80::1', 'fe80::1'],
    // getaddrinfo hands ::ffff:7f00:1 back in its dotted form, so the policy sees ::ffff:127.0.0.1
    // (the harness dns encodes the dotted spelling '::ffff:127.0.0.1' wrongly, so the mapped form is sent in hex)
    ['AAAA ::ffff:7f00:1 (v4-mapped loopback)', '::ffff:7f00:1'],
  ])('%s', async (_label, ip) => {
    const hs = seq('dns');
    await dns.set(hs, ip);
    await expectRefused(ctx, hs, { reason: resolvesPrivate });
    expect((await dns.queries(hs)).length).toBeGreaterThan(0);
  });

  test('CNAME to a private name', async () => {
    const hs = seq('cname');
    await dns.set(`target-${hs}`, '10.0.0.1');
    await dns.set(hs, { type: 'CNAME', value: `target-${hs}` });
    await expectRefused(ctx, hs, { reason: resolvesPrivate });
  });

  test('two A records, one public and one private: any private answer refuses', async () => {
    const hs = seq('mixed');
    await dns.set(hs, ['203.0.113.66', '10.0.0.1']);
    await expectRefused(ctx, hs, { reason: resolvesPrivate });
  });

  // isPrivateIp misses IPv4-compatible, NAT64 and 6to4 forms of private addresses. These hosts are not routable from the
  // container, so the request still fails, but only with "Unable to connect", not with the policy's refusal.
  test.failing.each([
    ['AAAA ::127.0.0.1 (IPv4-compatible)', '::127.0.0.1'],
    ['AAAA 64:ff9b::a00:1 (NAT64 of 10.0.0.1)', '64:ff9b::a00:1'],
    ['AAAA 2002:a00:1:: (6to4 of 10.0.0.1)', '2002:a00:1::'],
  ])('known gap: %s', async (_label, ip) => {
    const hs = seq('v6gap');
    await dns.set(hs, ip);
    await expectRefused(ctx, hs, { reason: resolvesPrivate });
  });

  test('NXDOMAIN and SERVFAIL are refused', async () => {
    const nx = seq('nx');
    const sf = seq('sf');
    await dns.nxdomain(nx);
    await dns.servfail(sf);
    await expectRefused(ctx, nx, { reason: 'getaddrinfo ENOTFOUND' });
    await expectRefused(ctx, sf, { reason: 'getaddrinfo ESERVFAIL' });
  });

  test('no answer at all is refused within about 10s', async () => {
    const hs = seq('drop');
    await dns.drop(hs);
    const started = Date.now();
    await expectRefused(ctx, hs, { reason: 'getaddrinfo ETIMEOUT', names: ['T1', 'T3'] });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('A. public targets', () => {
  test('positive control: evil.test is reachable through T1, T3 and T4', async () => {
    await freshAnchor('p');
    await publicDiscovery();
    const results = await runTriggers(ctx, 'evil.test', ['T1', 'T3', 'T4']);
    // discovery worked, so the failures are the remote's answers, not ours
    expect(results.T1![0]!.status).toBe(401);
    expect(results.T3![0]!.status).toBe(404);
    expect(results.T4![0]!.status).toBe(404);
    const paths = (await fake.requests(1)).map((r) => `${r.method} ${r.scheme} ${r.host}${r.path}`);
    expect(paths).toContain('GET https evil.test/.well-known/anchor/info');
    expect(paths).toContain('GET https evil.test/federation/users/alice');
    expect(paths).toContain('POST https evil.test/federation/invites/code1/accept');
    expect((await strayTraffic()).canary).toEqual([]);
    expect(await canary.allHits()).toEqual([]);
  });

  // pinned: the CA-signed cert for evil.test has no IP SAN, so a bare public IP never validates
  test('203.0.113.66 as a bare IP homeserver is refused by the TLS check', async () => {
    await clean();
    await expectRefused(ctx, '203.0.113.66', { reason: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});
