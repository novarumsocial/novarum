// TESTING_PLAN.md 5.4 F: egress-proxy variant. anchor-q sits on an internal network whose only way out is smokescreen, and has
// HTTP(S)_PROXY in its container environment (see README quirks). Requests to anchor-q go through `fetchIn`/`exec`.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { dns, fake, ips, start, stop, stackIsUp } from '../harness/federation';
import { bunIn, clean, dropShadows, expectRefused, freshAnchor, makeActor, pgFor, publicDiscovery, runTriggers, strayTraffic, type Actor } from '../harness/ssrf';
import { eventually } from '../harness/wait';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const pg = pgFor('q');
let ctx: { actor: Actor; pg: typeof pg };
const policy = 'Federation URL cannot target local or private addresses';
const resolvesPrivate = 'Federation URL resolves to a local or private address';
const proxyUrl = `http://${ips.proxy.egress}:3128`;

beforeAll(async () => {
  await stackIsUp();
  await freshAnchor('q');
  ctx = { actor: await makeActor('q'), pg };
}, 120_000);
afterAll(async () => {
  await dropShadows(pg, ctx.actor);
  await pg.close();
  await freshAnchor('q');
}, 120_000);
beforeEach(clean, 60_000);

describe('F. the A-group targets through T1-T6 on anchor-q', () => {
  // refused either by assertSafeFederationUrl or, for names that only look public, by smokescreen
  test.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.30.0.99', '0x7f000001'])('%s', async (hs) => {
    await expectRefused(ctx, hs, { reason: policy, logHost: hs === '0x7f000001' ? '127.0.0.1' : hs });
  });
  test('localhost', () => expectRefused(ctx, 'localhost', { reason: policy }));

  test.each([
    ['A 10.0.0.1', '10.0.0.1'],
    ['AAAA fc00::1', 'fc00::1'],
  ])('DNS: %s', async (_label, ip) => {
    const hs = `egress-${ip.replace(/\W/g, '')}.test`;
    await dns.set(hs, ip);
    await expectRefused(ctx, hs, { reason: resolvesPrivate });
  });

  test('DNS: two A records, one public and one private', async () => {
    await dns.set('egress-mixed.test', ['203.0.113.66', '10.0.0.1']);
    await expectRefused(ctx, 'egress-mixed.test', { reason: resolvesPrivate });
  });

  // the in-process check misses these (see the address suite); with the proxy in front they are refused anyway
  test.each(['::127.0.0.1', '64:ff9b::a00:1', '2002:a00:1::'])('DNS: AAAA %s (missed by isPrivateIp) is still refused', async (ip) => {
    const hs = `egress-v6-${ip.replace(/\W/g, '')}.test`;
    await dns.set(hs, ip);
    await expectRefused(ctx, hs);
  });
});

describe('F. positive control: evil.test through the proxy', () => {
  test('discovery, signed POST and user lookup succeed, all arriving from smokescreen', async () => {
    await freshAnchor('q');
    await publicDiscovery();
    const results = await runTriggers(ctx, 'evil.test', ['T1', 'T3', 'T4']);
    expect([results.T1![0]!.status, results.T3![0]!.status, results.T4![0]!.status]).toEqual([401, 404, 404]);
    const seen = await fake.requests(1);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['GET /.well-known/anchor/info', 'GET /federation/users/alice', 'POST /federation/invites/code1/accept']));
    expect(new Set(seen.map((r) => r.sourceIp))).toEqual(new Set([ips.proxy.pub]));
  });
});

describe('F. WebSockets bypass the proxy', () => {
  // Bun's WebSocket ignores HTTP(S)_PROXY. anchor-q has no direct route, so the bridge to a perfectly public homeserver never connects.
  test.failing('known gap: the bridge (T5) to evil.test goes through the proxy', async () => {
    await freshAnchor('q');
    await publicDiscovery();
    await runTriggers(ctx, 'evil.test', ['T5']);
    await eventually(async () => (await fake.requests(1, { path: '/federation/realtime' })).some((r) => r.host === 'evil.test'), { timeout: 15_000, message: 'bridge handshake at the fake' });
  });

  // the same without the anchor: a bare WebSocket in anchor-q's container with the proxy configured as the runtime expects
  test.failing('known gap: a bare WebSocket with HTTPS_PROXY set reaches evil.test through the proxy', async () => {
    const script = `
      const ws = new WebSocket('wss://evil.test/federation/realtime/guilds/x');
      const done = (s) => { console.log(JSON.stringify({ s })); process.exit(0); };
      ws.onclose = () => done('close'); ws.onerror = () => done('error'); setTimeout(() => done('timeout'), 8000);`;
    await bunIn('q', script, null, { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl });
    expect((await fake.requests(1, { path: '/federation/realtime' })).filter((r) => r.host === 'evil.test').length).toBeGreaterThan(0);
  });
});

describe('F. network.proxy_url only works when HTTP(S)_PROXY is set at process start', () => {
  // utils/config.ts copies proxy_url into process.env on the first getConfig(); Bun 1.3.9 reads the proxy variables only at startup,
  // so an anchor configured through config.toml alone still connects directly. A bun child without the variables stands in for it.
  const probe = `
    import { getConfig } from './utils/config';
    const { proxy_url } = getConfig().network;
    const useOption = JSON.parse(process.argv[1]);
    const out = await fetch('https://evil.test/.well-known/anchor/info', useOption ? { proxy: proxy_url } : {}).then((r) => ({ ok: true, status: r.status, proxy_url }), (e) => ({ ok: false, error: String(e.message ?? e), proxy_url }));
    console.log(JSON.stringify(out));
    process.exit(0);`;

  test('control: the configured proxy_url works when handed to fetch explicitly', async () => {
    await publicDiscovery();
    expect(await bunIn('q', probe, true)).toMatchObject({ ok: true, status: 200, proxy_url: proxyUrl });
    expect((await fake.requests(1))[0]!.sourceIp).toBe(ips.proxy.pub);
  });

  test.failing('known gap: with only config.toml and no HTTP(S)_PROXY at startup, fetch goes through the proxy_url', async () => {
    await publicDiscovery();
    expect(await bunIn('q', probe, false)).toMatchObject({ ok: true, status: 200 });
    expect((await fake.requests(1))[0]!.sourceIp).toBe(ips.proxy.pub);
  });
});

describe('F. the resolver is a dependency of the check: dns stopped', () => {
  test('every federation call fails closed and local features keep working', async () => {
    await freshAnchor('q');
    await stop('dns');
    try {
      await expectRefused(ctx, 'evil.test');
      expect((await ctx.actor.as('/guilds/create', { method: 'POST', json: { name: 'still works' } })).status).toBe(200);
      expect((await ctx.actor.as('/guilds/list')).status).toBe(200);
      expect(await strayTraffic()).toEqual({ canary: [], fake1: [], fake2: [] });
    } finally {
      await start('dns');
      await eventually(() => dns.queries().then(() => true), { timeout: 30_000, message: 'dns admin back' });
      await dns.reset();
    }
  });
});
