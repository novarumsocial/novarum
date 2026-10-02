import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { canary, fake, resetHarness, signup } from '../harness/federation';
import { editHeader, ensurePingUser, ready, fakeUser, restartAnchor, pingBody, pingPath, sendFrom, sendSigned, signed, withDb } from '../harness/fedVerify';
import { eventually } from '../harness/wait';

setDefaultTimeout(120_000); // hooks restart anchors and wait on canaries; a multi-file run resets bun's timeout

// TESTING_PLAN 5.2: discovery and request verification, driven against anchor-a with the fake identities.
// anchor-a's discovery cache (5 min / 30 s on failure) is process-wide, so tests that depend on a cold cache call `fresh()`.
const hsOf = (id: 1 | 2) => fake.identityInfo(id).homeserver;
const ping = (id: 1 | 2 = 1, sign = {}) => sendFrom(id, 'a', pingPath, pingBody(hsOf(id)), sign);
const infoPath = '/.well-known/anchor/info';
const discoveryHits = async (id: 1 | 2 = 1) => (await fake.requests(id, { path: infoPath })).length;
const fresh = async () => {
  await resetHarness();
  await restartAnchor('a');
};
const landing = 'http://172.30.0.99/landed';

let ownerId: string;
const guildIds: string[] = [];
/** a shadow guild of `homeserver` on anchor-a, as `fed:guild:<homeserver>:*` rows are; extAnchorDown starts false */
async function shadowGuild(homeserver: string) {
  const id = `fed:guild:${encodeURIComponent(homeserver)}:${crypto.randomUUID()}`;
  await withDb('a', (sql) => sql`insert into guild (id, name, "ownerId", "extAnchorDown") values (${id}, 'shadow', ${ownerId}, false)`);
  guildIds.push(id);
  return id;
}
const isDown = (id: string) => withDb('a', async (sql) => ((await sql`select "extAnchorDown" as down from guild where id = ${id}`) as { down: boolean }[])[0]!.down);

beforeAll(async () => {
  await ready();
  await fresh();
  ownerId = (await signup('a')).user.id;
  await ensurePingUser('a', 1);
  await ensurePingUser('a', 2);
  await resetHarness();
});
afterEach(async () => {
  await resetHarness();
  if (guildIds.length) await withDb('a', (sql) => sql`delete from guild where id in ${sql(guildIds.splice(0))}`);
});

describe('signed request checks', () => {
  test('valid signed request -> 2xx', async () => {
    const res = await ping();
    expect(res.status).toBe(200);
  });

  test.each(['X-Novarum-Homeserver', 'X-Novarum-Key-Id', 'X-Novarum-Date', 'X-Novarum-Nonce', 'X-Novarum-Signature', 'X-Novarum-Body-SHA256'])(
    'missing %s -> 400',
    async (header) => {
      const s = await signed(1, 'a', pingPath, pingBody(hsOf(1)));
      const res = await sendSigned(s, (h) => editHeader(h, header));
      expect(res.status).toBe(400);
    }
  );

  test.each([-330, 330])('Date %is from now (max age 300s) -> 401 Stale', async (dateOffsetSeconds) => {
    const res = await ping(1, { dateOffsetSeconds });
    expect(res.status).toBe(401);
    expect(res.json?.error).toContain('Stale');
  });

  test('unparseable Date -> 401', async () => {
    expect((await ping(1, { date: 'not a date' })).status).toBe(401);
  });

  test('same nonce twice -> second 401', async () => {
    const s = await signed(1, 'a', pingPath, pingBody(hsOf(1)));
    expect((await sendSigned(s)).status).toBe(200);
    const again = await sendSigned(s);
    expect(again.status).toBe(401);
    expect(again.json?.error).toContain('nonce');
  });

  test('a bad signature does not consume the nonce', async () => {
    const nonce = crypto.randomUUID();
    const bad = await ping(1, { nonce, tamper: true });
    expect(bad.status).toBe(401);
    expect(bad.json?.error).toBe('Invalid signature');
    expect((await ping(1, { nonce })).status).toBe(200);
  });

  test('same nonce sent concurrently -> exactly one 2xx, the other 401, never 500', async () => {
    for (let i = 0; i < 5; i++) {
      const s = await signed(1, 'a', pingPath, pingBody(hsOf(1)));
      const statuses = (await Promise.all([sendSigned(s), sendSigned(s)])).map((r) => r.status).sort();
      expect(statuses).toEqual([200, 401]);
    }
  });

  test('the same nonce from fake .66 and .67 is accepted for both (scoped by homeserver)', async () => {
    const nonce = crypto.randomUUID();
    expect((await ping(1, { nonce })).status).toBe(200);
    expect((await ping(2, { nonce })).status).toBe(200);
    expect((await ping(1, { nonce })).status).toBe(401);
  });

  test('body hash mismatch -> 401', async () => {
    const res = await ping(1, { bodyHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    expect(res.status).toBe(401);
    expect(res.json?.error).toContain('body hash');
  });

  test('non-JSON body that verifies -> 400 Invalid federation JSON body', async () => {
    const res = await sendFrom(1, 'a', pingPath, 'this is not json');
    expect(res.status).toBe(400);
    expect(res.json?.error).toBe('Invalid federation JSON body');
  });

  describe('a signature over something else is rejected (401 Invalid signature)', () => {
    test('different path', async () => {
      const res = await sendSigned({ ...(await signed(1, 'a', '/federation/dms/latest', pingBody(hsOf(1)))), path: pingPath });
      expect([res.status, res.json?.error]).toEqual([401, 'Invalid signature']);
    });
    test('different method', async () => {
      const res = await sendSigned({ ...(await signed(1, 'a', pingPath, pingBody(hsOf(1)), {}, 'PUT')), method: 'POST' });
      expect([res.status, res.json?.error]).toEqual([401, 'Invalid signature']);
    });
    test('different host', async () => {
      const res = await ping(1, { host: '172.30.0.12' });
      expect([res.status, res.json?.error]).toEqual([401, 'Invalid signature']);
    });
    test('different homeserver (header says .67, signed as .66 with .67 advertising .66 key)', async () => {
      await restartAnchor('a');
      const k = await fake.info(1);
      await fake.respond(2, infoPath, { discovery: { publicKey: { id: k.keyId, key: k.publicKey } } });
      const s = await signed(1, 'a', pingPath, pingBody(hsOf(2)));
      const res = await sendSigned(s, (h) => editHeader(h, 'X-Novarum-Homeserver', hsOf(2)));
      expect([res.status, res.json?.error]).toEqual([401, 'Invalid signature']);
      await restartAnchor('a'); // drop the poisoned .67 discovery
    });
  });
});

describe('discovery', () => {
  test('unknown key id triggers a refresh; a key rotated between requests is accepted afterwards', async () => {
    await fresh();
    expect((await ping()).status).toBe(200);
    expect(await discoveryHits()).toBe(1);
    await fake.rotateKey(1);
    expect((await ping()).status).toBe(200);
    expect(await discoveryHits()).toBe(2);
  });

  test('unknown key id that is still unknown after the refresh -> 401', async () => {
    await fresh();
    const res = await ping(1, { keyId: 'no-such-key' });
    expect([res.status, res.json?.error]).toEqual([401, 'Unknown federation key']);
    expect(await discoveryHits()).toBe(2); // first discovery + the refresh
  });

  test('discovery returning another homeserver -> 400 Could not discover', async () => {
    await fresh();
    await fake.respond(1, infoPath, { discovery: { homeserver: '172.30.0.99' } });
    const res = await ping();
    expect([res.status, res.json?.error]).toEqual([400, 'Could not discover remote anchor']);
  });

  test.each(['http://172.30.0.66/?x=1', 'http://user:pw@172.30.0.66', 'http://172.30.0.66/#frag'])('discovery baseUrl %s is rejected', async (baseUrl) => {
    await fresh();
    await fake.respond(1, infoPath, { discovery: { baseUrl } });
    expect((await ping()).status).toBe(400);
  });

  test('public anchor: a baseUrl pointing at a private address, or plain http, is rejected (https control passes verification)', async () => {
    await restartAnchor('p');
    const body = { user: fakeUser('evil.test'), channels: [] };
    const send = (baseUrl: string) => sendFromP(body, baseUrl);
    expect((await send('http://172.30.0.66')).status).toBe(400);
    await restartAnchor('p'); // 30 s failure cache
    expect((await send('http://evil.test')).status).toBe(400);
    await restartAnchor('p');
    expect((await send('https://evil.test')).status).toBe(403); // verified; the user is unknown on p
    await restartAnchor('p');
  });

  test('discovery answering 3xx -> rejected, nothing reaches the redirect target', async () => {
    await fresh();
    await fake.respond(1, infoPath, { redirect: landing });
    expect((await ping()).status).toBe(400);
    expect(await canary.allHits()).toEqual([]);
  });

  test('discovery hanging past 10s: rejected in about 10s, failure cached 30s, success cached', async () => {
    await fresh();
    await fake.respond(1, infoPath, { hangMs: -1 });
    const t0 = Date.now();
    expect((await ping()).status).toBe(400);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThan(9_000);
    expect(elapsed).toBeLessThan(17_000);
    expect(await discoveryHits()).toBe(1);

    // fixed on the remote, but the failure is cached for 30s: no new discovery request
    await fake.respond(1, infoPath, { discovery: {} });
    const t1 = Date.now();
    expect((await ping()).status).toBe(400);
    expect(Date.now() - t1).toBeLessThan(5_000);
    expect(await discoveryHits()).toBe(1);

    // after the 30s failure window the next request re-discovers, and the success is then cached
    await Bun.sleep(Math.max(0, t0 + elapsed + 31_000 - Date.now()));
    expect((await ping()).status).toBe(200);
    expect(await discoveryHits()).toBe(2);
    for (let i = 0; i < 3; i++) expect((await ping()).status).toBe(200);
    expect(await discoveryHits()).toBe(2);
  }, 90_000);
});

describe('extAnchorDown follows the remote', () => {
  test('discovery 5xx -> shadow guilds down; flips back on the first successful call', async () => {
    await fresh();
    const g = await shadowGuild(hsOf(1));
    const other = await shadowGuild(hsOf(2));
    await fake.respond(1, infoPath, { status: 500 });
    expect((await ping()).status).toBe(400);
    expect(await isDown(g)).toBe(true);
    expect(await isDown(other)).toBe(false);

    await fresh(); // clear the 30s failure cache
    await fake.clearRoutes(1);
    expect((await ping()).status).toBe(200);
    expect(await isDown(g)).toBe(false);
  });

  test('discovery connection refused -> shadow guilds down', async () => {
    await fresh();
    const g = await shadowGuild('172.30.0.5'); // postgres: nothing listens on :80
    const res = await sendFrom(1, 'a', pingPath, pingBody('172.30.0.5'), { homeserver: '172.30.0.5' });
    expect(res.status).toBe(400);
    expect(await isDown(g)).toBe(true);
  });

  test('discovery timeout -> shadow guilds down', async () => {
    await fresh();
    const g = await shadowGuild(hsOf(1));
    await fake.respond(1, infoPath, { hangMs: -1 });
    expect((await ping()).status).toBe(400);
    expect(await isDown(g)).toBe(true);
  });

  // anchor-a signs a friends/sync back to the fake after accepting its friend request (a is authoritative as .11 < .66)
  const triggerSync = async () => {
    const actor = fakeUser(hsOf(1));
    const peer = (await signup('a')).user.username;
    const body = { commandId: crypto.randomUUID(), actor, peerUsername: peer, action: 'REQUEST', expectedVersion: 0 };
    return sendFrom(1, 'a', '/federation/friends/command', body);
  };
  const syncAttempts = async () => (await fake.requests(1, { path: '/federation/friends/sync' })).length;

  test('signed POST answered with a 3xx fails: guilds down, redirect target untouched, next call re-discovers', async () => {
    await fresh();
    const g = await shadowGuild(hsOf(1));
    await fake.respond(1, 'POST /federation/friends/sync', { redirect: landing });
    expect((await triggerSync()).status).toBe(200);
    await eventually(async () => (await syncAttempts()) >= 1 && (await isDown(g)), { timeout: 8_000, message: 'sync attempted and guild marked down' });
    expect(await canary.allHits()).toEqual([]);

    // the failed call dropped the 5-minute discovery cache: the next call fetches discovery again
    const before = await discoveryHits();
    await fake.clearRoutes(1);
    expect((await ping()).status).toBe(200);
    expect(await discoveryHits()).toBe(before + 1);
    expect(await isDown(g)).toBe(false);
  });

  test('signed POST to a remote that times out: guilds down, next call re-discovers', async () => {
    await fresh();
    const g = await shadowGuild(hsOf(1));
    await fake.respond(1, 'POST /federation/friends/sync', { hangMs: -1 });
    expect((await triggerSync()).status).toBe(200);
    await eventually(async () => await isDown(g), { timeout: 15_000, message: 'guild marked down after the sync timeout' });
    const before = await discoveryHits();
    await fake.clearRoutes(1);
    expect((await ping()).status).toBe(200);
    expect(await discoveryHits()).toBe(before + 1);
    expect(await isDown(g)).toBe(false);
  });
});

// sends a signed request to the public anchor p (as http://172.30.0.20 with Host p.test) from fake identity 1 acting as evil.test
async function sendFromP(body: unknown, baseUrl: string) {
  await resetHarness();
  await fake.respond(1, infoPath, { discovery: { homeserver: 'evil.test', baseUrl } });
  const s = await signed(1, 'p', pingPath, body, { host: 'p.test', homeserver: 'evil.test' });
  return sendSigned(s, undefined, { host: 'p.test' });
}
