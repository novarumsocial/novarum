// TESTING_PLAN.md 5.4 G: what the triggers let a stranger do. Discovery runs before the signature check, so unauthenticated
// requests can make anchor-p call out; this pins that, measures the amplification and checks how user-supplied path pieces are encoded.
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { canary, dns, fake, stackIsUp } from '../harness/federation';
import { call, clean, dropShadows, freshAnchor, garbageFederationHeaders, logsSince, makeActor, noStray, pgFor, pool, publicDiscovery, rssMb, runTriggers, strayTraffic, bridgeSocket, seedShadow, type Actor } from '../harness/ssrf';
import { eventually } from '../harness/wait';

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

const t1 = (hs: string) => call('p', '/federation/friends/command', { method: 'POST', body: '{}', headers: { ...garbageFederationHeaders(hs, '{}'), 'content-type': 'application/json' } });

describe('G. pre-auth discovery', () => {
  test('T1 with a garbage signature still makes the anchor fetch discovery from the named homeserver (pin)', async () => {
    await publicDiscovery();
    const res = await t1('evil.test');
    expect(res.status).toBe(401); // the discovery succeeded, the key id and signature did not
    expect((await fake.requests(1, { path: '/.well-known' })).map((r) => `${r.scheme} ${r.host} ${r.path}`)).toContain('https evil.test /.well-known/anchor/info');
  });

  test('T2 (unauthenticated bridge WebSocket) does the same (pin)', async () => {
    await freshAnchor('p');
    await publicDiscovery();
    expect(await bridgeSocket('p', 'evil.test')).toMatchObject({ status: 1008 });
    expect((await fake.requests(1, { path: '/.well-known' })).length).toBeGreaterThan(0);
  });

  // 500 distinct homeservers = 500 outbound discoveries and 500 discoveryCache entries today. The plan expects a rate limit or a cache cap.
  // Outbound attempts are counted from the resolver's log (each r<n>.evil.test must be resolved before anything can be fetched), the
  // cache growth is only visible as RSS, which is logged.
  test.failing('known gap: 500 T1 requests for distinct homeservers cause at most ~100 outbound discoveries', async () => {
    await freshAnchor('p');
    await dns.set('*.evil.test', '203.0.113.66');
    const before = await rssMb('p');
    const responses = await pool(500, 25, (i) => t1(`r${i}.evil.test`));
    expect(responses.filter((r) => r.status === 500)).toEqual([]);
    await Bun.sleep(1000);
    const resolved = new Set((await dns.queries()).filter((q) => /^r\d+\.evil\.test$/.test(q.name)).map((q) => q.name));
    const after = await rssMb('p');
    console.log(`[G amplification] ${resolved.size} of 500 distinct homeservers resolved; anchor-p RSS ${before.toFixed(0)} MB -> ${after.toFixed(0)} MB`);
    expect(resolved.size).toBeLessThanOrEqual(100);
    expect(await canary.allHits()).toEqual([]);
  });

  test('500 T1 requests for the same unreachable homeserver cause one outbound attempt (failure cache)', async () => {
    await freshAnchor('p');
    await dns.nxdomain('down.test');
    const since = new Date();
    const responses = await pool(500, 25, () => t1('down.test'));
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([400]));
    const attempts = async () => (await logsSince('p', since)).split('\n').filter((l) => l.includes('https://down.test/.well-known/anchor/info')).length;
    await eventually(async () => (await attempts()) >= 1, { message: 'one attempt logged' });
    await Bun.sleep(500);
    expect(await attempts()).toBe(1);
    expect(await canary.allHits()).toEqual([]);
  });
});

describe('G. user-supplied values in the request path', () => {
  const values = ['../x', '//canary/x', 'a?b', 'a#b', '%2f', '%00', 'a b', 'ü/ß'];

  beforeAll(() => freshAnchor('p'), 60_000);

  test.each(values)('T3 username %j stays one percent-encoded path segment on evil.test', async (username) => {
    await publicDiscovery();
    const res = await ctx.actor.as('/friends/request', { method: 'POST', json: { username, homeserver: 'evil.test' } });
    expect(res.status).toBeLessThan(500);
    const lookups = await fake.requests(1, { path: '/federation/users' });
    expect(lookups.map((r) => `${r.host} ${r.path}`)).toEqual([`evil.test /federation/users/${encodeURIComponent(username)}`]);
    expect(await strayTraffic(/^\/(\.well-known|federation)\//)).toEqual(noStray);
  });

  test.each([...values, 'a'.repeat(10 * 1024)])('T4 invite code %j stays one percent-encoded path segment on evil.test', async (code) => {
    await publicDiscovery();
    const res = await ctx.actor.as('/invite/accept', { method: 'POST', json: { code, homeserver: 'evil.test' } });
    expect(res.status).toBeLessThan(500);
    const posts = await fake.requests(1, { path: '/federation/invites' });
    expect(posts.map((r) => `${r.method} ${r.host} ${r.path}`)).toEqual([`POST evil.test /federation/invites/${encodeURIComponent(code)}/accept`]);
    expect(await strayTraffic(/^\/(\.well-known|federation)\//)).toEqual(noStray);
  });

  test('a 10 KB username is rejected by validation before any request is made', async () => {
    const res = await ctx.actor.as('/friends/request', { method: 'POST', json: { username: 'a'.repeat(10 * 1024), homeserver: 'evil.test' } });
    expect(res.status).toBe(422);
    expect(await fake.requests(1)).toEqual([]);
  });

  // shadow channel ids come from the database, but the same encoding applies when they carry hostile pieces
  test('T6 channel ids with path characters stay one segment', async () => {
    await publicDiscovery();
    const { channelId } = await seedShadow(pg, ctx.actor, 'evil.test');
    const hostile = `fed:channel:evil.test:${encodeURIComponent('../x?y#z')}`;
    await pg`insert into channel (id, "guildId", name) select ${hostile}, "guildId", 'hostile' from channel where id = ${channelId}`;
    await ctx.actor.as('/message/send', { method: 'POST', json: { channelId: hostile, content: 'hi', nonce: 'n1' } });
    expect((await fake.requests(1, { path: '/federation/channels' })).map((r) => r.path)).toEqual([`/federation/channels/${encodeURIComponent('../x?y#z')}/messages/send`]);
  });
});
