// TESTING_PLAN.md 5.4 B: scheme and TLS. anchor-p must validate certificates and refuse plain http for public targets.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { dns, fake, stackIsUp } from '../harness/federation';
import { bunIn, clean, dropShadows, expectRefused, freshAnchor, makeActor, pgFor, publicDiscovery, type Actor } from '../harness/ssrf';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const pg = pgFor('p');
let ctx: { actor: Actor; pg: typeof pg };

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
beforeEach(clean);

describe('B. scheme', () => {
  // plain.test resolves to the fake's public IP, which also answers plain http on :80 with a perfectly valid discovery document,
  // while https there presents evil.test's certificate. Falling back to http would therefore succeed: the fake must see nothing.
  test('a target that serves discovery over plain http is not used', async () => {
    await dns.set('plain.test', '203.0.113.66');
    await publicDiscovery({ homeserver: 'plain.test', baseUrl: 'https://plain.test' });
    await expectRefused(ctx, 'plain.test', { reason: /ERR_TLS|certificate/i });
    expect(await fake.requests(1)).toEqual([]);
  });
});

describe('B. certificate validation', () => {
  test.each([
    ['wrongcert.test', /ERR_TLS_CERT_ALTNAME_INVALID/],
    ['selfsigned.test', /self.signed|SELF_SIGNED|UNABLE_TO_VERIFY|CERT/i],
    ['expired.test', /expired|CERT_HAS_EXPIRED/i],
  ])('%s is refused', async (hs, reason) => {
    // a valid-looking document is waiting behind each bad certificate, so a disabled check would let it through
    await publicDiscovery({ homeserver: hs, baseUrl: `https://${hs}` });
    await expectRefused(ctx, hs, { reason });
    expect(await fake.requests(1)).toEqual([]);
  });
});

describe('B. the test CA is what makes evil.test reachable', () => {
  const discover = `
    import { discoverRemoteAnchor } from './utils/discovery';
    const out = await discoverRemoteAnchor('evil.test').then((v) => ({ ok: true, homeserver: v.homeserver }), (e) => ({ ok: false, error: String(e.message ?? e) }));
    console.log(JSON.stringify(out));
    process.exit(0);`;

  // a second bun process in anchor-p's container runs the anchor's own discoverRemoteAnchor with its config, resolver and network
  test('discovery of evil.test works with the CA and is refused without NODE_EXTRA_CA_CERTS', async () => {
    await publicDiscovery();
    expect(await bunIn('p', discover)).toEqual({ ok: true, homeserver: 'evil.test' });
    expect((await fake.requests(1, { path: '/.well-known' })).length).toBe(1);

    await fake.clearRequests(1);
    const without = await bunIn('p', discover, null, { NODE_EXTRA_CA_CERTS: null });
    expect(without.ok).toBe(false);
    expect(without.error).toMatch(/certificate|CERT|TLS|verify/i);
    expect(await fake.requests(1)).toEqual([]);
  });
});
