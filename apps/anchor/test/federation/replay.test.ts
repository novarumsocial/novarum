import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { fetchIn, resetHarness } from '../harness/federation';
import { ready, ensurePingUser, pingBody, pingPath, restartAnchor, sendSigned, signed, withDb } from '../harness/fedVerify';

setDefaultTimeout(120_000); // hooks restart anchors and wait on canaries; a multi-file run resets bun's timeout

// TESTING_PLAN 7: replay across restart, concurrent replay, Host-header handling behind Caddy (b-proxy).
beforeAll(async () => {
  await ready();
  await ensurePingUser('a', 1);
  await ensurePingUser('b', 1);
  await resetHarness();
});
afterAll(resetHarness);

describe('replay', () => {
  test('a replay after an anchor restart is still rejected (nonces persist in the database)', async () => {
    const s = await signed(1, 'a', pingPath, pingBody('172.30.0.66'));
    expect((await sendSigned(s)).status).toBe(200);
    await restartAnchor('a');
    const replay = await sendSigned(s);
    expect(replay.status).toBe(401);
    expect(replay.json?.error).toContain('nonce');
    const nonce = s.headers['X-Novarum-Nonce']!;
    const rows = await withDb('a', (sql) => sql`select 1 from federation_nonce where nonce = ${nonce}`);
    expect(rows.length).toBe(1);
  });

  test('20 parallel copies of one signed request -> exactly one 2xx, the rest 401 (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await signed(1, 'a', pingPath, pingBody('172.30.0.66'));
      const statuses = (await Promise.all(Array.from({ length: 20 }, () => sendSigned(s)))).map((r) => r.status);
      expect(statuses.filter((c) => c >= 200 && c < 300)).toHaveLength(1);
      expect(statuses.filter((c) => c === 401)).toHaveLength(19);
      const nonce = s.headers['X-Novarum-Nonce']!;
      const rows = await withDb('a', (sql) => sql`select 1 from federation_nonce where nonce = ${nonce}`);
      expect(rows).toHaveLength(1);
    }
  });
});

// anchor-b sits behind Caddy at https://b.test (203.0.113.12 -> 172.30.0.12:80). The signature host must be the Host the
// proxy forwarded (b.test); X-Forwarded-* and a spoofed Host must not change the outcome. Requests to the proxy are made
// from inside anchor-p (it resolves b.test and trusts the test CA).
describe('Host header handling behind Caddy (b-proxy)', () => {
  const body = pingBody('172.30.0.66');
  const viaProxy = async (signedHost: string, extra: Record<string, string> = {}) => {
    const s = await signed(1, 'b', pingPath, body, { host: signedHost });
    const res = await fetchIn('p', `https://b.test${pingPath}`, { method: 'POST', headers: { ...s.headers, ...extra }, body: s.text });
    if (!res.ok) throw new Error(res.error);
    return res.status;
  };
  const direct = async (signedHost: string, extra: Record<string, string> = {}) => {
    const s = await signed(1, 'b', pingPath, body, { host: signedHost });
    return (await sendSigned(s, undefined, extra)).status;
  };

  test('signed for b.test and sent through the proxy -> accepted', async () => {
    expect(await viaProxy('b.test')).toBe(200);
  });

  test("signed for the backend's own address but sent through the proxy -> 401 (the host is b.test)", async () => {
    expect(await viaProxy('172.30.0.12')).toBe(401);
  });

  test('a spoofed X-Forwarded-Host / Forwarded cannot make a signature for another host verify', async () => {
    expect(await viaProxy('172.30.0.12', { 'x-forwarded-host': '172.30.0.12', forwarded: 'host=172.30.0.12' })).toBe(401);
    expect(await viaProxy('evil.example', { 'x-forwarded-host': 'evil.example' })).toBe(401);
  });

  test('sent directly, X-Forwarded-Host does not turn a b.test signature into a valid one', async () => {
    expect(await direct('b.test', { 'x-forwarded-host': 'b.test' })).toBe(401);
    expect(await direct('172.30.0.12', { 'x-forwarded-host': 'b.test' })).toBe(200);
  });

  test('the Host the request carries is what is checked: a b.test signature verifies with Host: b.test even on the direct address', async () => {
    expect(await direct('b.test', { host: 'b.test' })).toBe(200);
    expect(await direct('172.30.0.12', { host: 'b.test' })).toBe(401);
  });
});
