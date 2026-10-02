// TESTING_PLAN.md 5.4 C: the `baseUrl` a remote homeserver declares in its discovery document. evil.test answers discovery
// with a hostile baseUrl; anchor-p (public mode) must refuse it before sending anything there.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { anchors, api, canary, dns, exec, fake, stackIsUp } from '../harness/federation';
import { createGuild, call as json } from '../harness/chat';
import { signup } from '../harness/federation';
import { clean, dropShadows, expectRefused, freshAnchor, logsSince, makeActor, pgFor, publicDiscovery, runTriggers, statuses, strayTraffic, type Actor } from '../harness/ssrf';
import { eventually } from '../harness/wait';

// restarts and 10s federation timeouts do not fit bun's 5s default (the harness's own call only reaches later files)
setDefaultTimeout(180_000);

const pg = pgFor('p');
let ctx: { actor: Actor; pg: typeof pg };
const policy = 'Federation URL cannot target local or private addresses';
const discoveryRequests = /^\/\.well-known\/anchor\/info/;

beforeAll(async () => {
  await stackIsUp();
  await freshAnchor('p');
  ctx = { actor: await makeActor('p'), pg };
}, 60_000);
afterAll(async () => {
  await dropShadows(pg, ctx.actor);
  await pg.close();
  await freshAnchor('p');
});
// discovery results are cached for 5 minutes, so every row starts from a restarted anchor
beforeEach(() => freshAnchor('p'), 60_000);

/** evil.test declares `baseUrl`; the discovery GET itself is the only request the fake may see */
async function refusedBaseUrl(baseUrl: string, reason: string | RegExp) {
  await publicDiscovery({ baseUrl });
  await expectRefused(ctx, 'evil.test', { reason, ignoreFake: discoveryRequests });
}

describe('C. refused baseUrls', () => {
  test('http://evil.test (no https)', () => refusedBaseUrl('http://evil.test', 'Federation URL must use HTTPS'));

  test.each([
    ['https://10.0.0.1', policy],
    ['https://127.0.0.1:8080', policy],
    ['https://169.254.169.254', policy],
    ['https://172.30.0.99', policy],
  ])('%s', (baseUrl, reason) => refusedBaseUrl(baseUrl, reason));

  test('a name that resolves to a private address', async () => {
    await dns.set('inner.test', '10.0.0.1');
    await refusedBaseUrl('https://inner.test', 'Federation URL resolves to a local or private address');
  });

  test.each(['https://user:pw@evil.test', 'https://evil.test?q=1', 'https://evil.test#x'])('%s', (baseUrl) => refusedBaseUrl(baseUrl, 'Invalid discovery base URL for evil.test'));

  // URL.hostname keeps the brackets of an IPv6 literal, so isPrivateIp says "public" and the refusal comes from
  // dns.lookup('[::1]') failing with ENOTFOUND. Pinned as refused; the second test states what it should be.
  test.each(['https://[::1]/', 'https://[::ffff:127.0.0.1]/'])('%s is refused (today by accident: ENOTFOUND)', async (baseUrl) => {
    await refusedBaseUrl(baseUrl, /ENOTFOUND/);
  });
  test.failing.each(['https://[::1]/', 'https://[::ffff:127.0.0.1]/'])('known gap: %s is refused by the address policy, not by ENOTFOUND', async (baseUrl) => {
    await refusedBaseUrl(baseUrl, policy);
  });

  test('discovery for evil.test returning homeserver b.test is refused (mismatch check)', async () => {
    await publicDiscovery({ homeserver: 'b.test' });
    await expectRefused(ctx, 'evil.test', { reason: 'Homeserver mismatch: expected evil.test, got b.test', ignoreFake: discoveryRequests });
  });
});

describe('C. pinned behaviour of accepted baseUrls', () => {
  // The discovered baseUrl may carry any public port. A throwaway https listener on the fake's public IP stands in for a
  // redis-like service there; its log is read back through docker exec.
  test('https://evil.test:6379 (non-default public port) is used as is', async () => {
    const log = '/tmp/ssrf-6379.log';
    const server = `
      Bun.serve({ hostname: '203.0.113.66', port: 6379, tls: { cert: Bun.file('/certs/evil.test.crt'), key: Bun.file('/certs/evil.test.key') },
        fetch: (req) => { require('node:fs').appendFileSync('${log}', req.method + ' ' + new URL(req.url).host + new URL(req.url).pathname + '\\n'); return Response.json({ error: 'nope' }, { status: 404 }); } });
      setTimeout(() => process.exit(0), 120000);`;
    await exec('fake', `rm -f ${log}; nohup bun -e "${server.replaceAll('"', '\\"')}" >/dev/null 2>&1 & echo $! >/tmp/ssrf-6379.pid`);
    try {
      await publicDiscovery({ baseUrl: 'https://evil.test:6379' });
      await eventually(async () => (await exec('fake', 'ss -ltn | grep -c :6379')).stdout.trim() !== '0', { message: 'listener up' });
      await runTriggers(ctx, 'evil.test', ['T4']);
      const seen = await eventually(async () => (await exec('fake', `cat ${log}`)).stdout.trim(), { message: 'request on :6379' });
      expect(seen).toBe('POST evil.test:6379/federation/invites/code1/accept');
      // and nothing at all on the standard port besides discovery
      expect((await fake.requests(1)).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /.well-known/anchor/info']);
    } finally {
      await exec('fake', 'kill $(cat /tmp/ssrf-6379.pid) 2>/dev/null; rm -f /tmp/ssrf-6379.pid');
    }
  });

  test('https://evil.test/prefix/ : requests go to /federation/... at the root, the prefix is dropped', async () => {
    await publicDiscovery({ baseUrl: 'https://evil.test/prefix/' });
    await runTriggers(ctx, 'evil.test', ['T4']);
    expect((await fake.requests(1)).map((r) => r.path)).toEqual(['/.well-known/anchor/info', '/federation/invites/code1/accept']);
  });
});

describe('C. confused deputy: baseUrl pointing at another real anchor', () => {
  const invite = async () => {
    const owner = await signup('b');
    const { guild } = await createGuild(owner, 'deputy target');
    const res = await json(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    return { code: res.body.invite.code as string, guildId: guild.id, owner };
  };
  const membersOf = async (guildId: string) => (await pgFor('b')`select "userId" from guild_member where "guildId" = ${guildId}`).length;

  // Today anchor-p signs a request for host b.test and sends it to b.test although the user asked for evil.test. b-proxy forwards it
  // to anchor-b, which tries to verify it: b has to discover p.test first, and its own log says so. Nothing should have been sent.
  test.failing('known gap (confused deputy): p sends the signed invite accept to b.test when evil.test declares it as baseUrl', async () => {
    const { code } = await invite();
    await publicDiscovery({ baseUrl: 'https://b.test' });
    const since = new Date();
    const res = await ctx.actor.as('/invite/accept', { method: 'POST', json: { code, homeserver: 'evil.test' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await Bun.sleep(1000);
    expect(await logsSince('b', since)).not.toContain('p.test');
  });

  // The same attack where the deputy and the victim can reach each other: anchor-a (private mode) with the fake's private identity
  // declaring anchor-b's real URL. a signs for host 172.30.0.12, b verifies the signature and adds the user to its guild.
  test.failing('known gap (confused deputy): a user of A joins B`s guild through a homeserver that declares B as its baseUrl', async () => {
    const { code, guildId } = await invite();
    await freshAnchor('a'); // a caches discovery of 172.30.0.66 for 5 minutes, other suites use it
    await fake.respond(1, '/.well-known/anchor/info', { discovery: { baseUrl: anchors.b.baseUrl } });
    const victim = await signup('a');
    const res = await victim.fetch('/invite/accept', { method: 'POST', body: JSON.stringify({ code, homeserver: '172.30.0.66' }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await membersOf(guildId)).toBe(1); // only the owner
  });

  afterAll(() => freshAnchor('a'), 60_000);
});
