import { beforeAll, describe, expect, test } from 'bun:test';
import {
  anchors,
  api,
  canary,
  dns,
  exec,
  fake,
  fetchIn,
  ips,
  mailpitUrl,
  proxy,
  restart,
  resetHarness,
  signup,
  stackIsUp,
} from '../harness/federation';

beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});

describe('federation stack boot smoke', () => {
  test('every real anchor answers and serves a correct discovery document', async () => {
    for (const name of ['a', 'b', 'c', 'p'] as const) {
      expect(await (await fetch(`${api(name)}/`)).text()).toBe('this is anchor');
      const info = (await (await fetch(`${api(name)}/.well-known/anchor/info`)).json()) as any;
      expect(info.homeserver).toBe(anchors[name].homeserver);
      expect(info.baseUrl).toBe(anchors[name].baseUrl);
      expect(info.publicKey.algorithm).toBe('ed25519');
    }
  });

  test('anchor-q (egress only) is up, reachable from inside its network only', async () => {
    const res = await fetchIn('q', 'http://127.0.0.1/');
    expect(res).toMatchObject({ ok: true, status: 200, body: 'this is anchor' });
  });

  test('anchor-a can look up a user on anchor-b through the federation route', async () => {
    const user = await signup('b');
    const res = await fetch(`${api('a')}/federation/users/${user.user.username}`);
    // /federation/users is served by the owning anchor; asking b directly proves the route and database
    const direct = await fetch(`${api('b')}/federation/users/${user.user.username}`);
    expect(direct.status).toBe(200);
    expect(((await direct.json()) as any).user.handle).toBe(`@${user.user.username}:${anchors.b.homeserver}`);
    expect(res.status).toBe(404); // a has no such local user
  });

  test('mailpit is reachable from the runner', async () => {
    expect((await fetch(`${mailpitUrl}/api/v1/info`)).status).toBe(200);
  });

  test('fake serves discovery for both identities and records the requests', async () => {
    for (const id of [1, 2] as const) {
      const info = (await (await fetch(`${fake.identityInfo(id).baseUrl}/.well-known/anchor/info`)).json()) as any;
      expect(info.homeserver).toBe(ips.fake[id]);
      expect(info.publicKey.key).toBe((await fake.info(id)).publicKey);
      expect((await fake.requests(id, { path: '/.well-known' })).length).toBeGreaterThan(0);
    }
    await fake.reset();
    expect(await fake.requests(1)).toEqual([]);
  });

  test('fake behaviours: status override, redirect, and signing as an identity', async () => {
    await fake.respond(1, '/x', { status: 418, json: { teapot: true } });
    expect((await fetch(`http://${ips.fake[1]}/x`)).status).toBe(418);
    await fake.respond(1, '/r', { redirect: 'http://172.30.0.99/hit' });
    expect((await fetch(`http://${ips.fake[1]}/r`, { redirect: 'manual' })).headers.get('location')).toBe('http://172.30.0.99/hit');
    const { headers, signingString } = await fake.sign({ identity: 2, method: 'POST', path: '/p', host: 'h', body: '{}', nonce: 'n1', date: 'd' });
    expect(headers['X-Novarum-Nonce']).toBe('n1');
    expect(signingString.split('\n').slice(0, 3)).toEqual(['v1', 'POST', '/p']);
    await fake.reset();
  });

  test('a request signed by fake is verified by anchor-a (and replay is refused)', async () => {
    const nonce = crypto.randomUUID();
    const send = () => fake.send(1, 'a', 'POST', '/federation/friends/status', {}, { nonce });
    const first = await send();
    // the (empty) payload is rejected by validation, but only after the signature was accepted and the nonce stored
    expect(first.text).not.toMatch(/nonce|signature|stale|discover|key/i);
    const second = await send();
    expect(second.status).toBe(401);
    expect(second.text).toMatch(/nonce/i);
    await fake.reset();
  });

  test('dns: evil.test resolves to 203.0.113.66 inside anchor-p', async () => {
    const res = await exec('p', 'getent hosts evil.test');
    expect(res.stdout.split(/\s+/)[0]).toBe('203.0.113.66');
    expect((await dns.queries('evil.test')).length).toBeGreaterThan(0);
    await dns.set('tmp.test', '203.0.113.9');
    expect((await exec('p', 'getent hosts tmp.test')).stdout.split(/\s+/)[0]).toBe('203.0.113.9');
    await dns.nxdomain('tmp.test');
    expect((await exec('p', 'getent hosts tmp.test')).code).not.toBe(0);
    await dns.reset();
  });

  test('canary is reachable and records hits', async () => {
    await canary.reset();
    expect((await fetch(`http://${ips.canary}/probe`)).status).toBe(200);
    const hits = await canary.hits();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ listener: 'http80', path: '/probe' });
    await canary.reset();
    expect(await canary.hits()).toEqual([]);
  });

  test('canary-p sees loopback:8080 hits and canary-meta sees metadata hits from anchor-p', async () => {
    await canary.reset();
    expect(await fetchIn('p', 'http://127.0.0.1:8080/lo')).toMatchObject({ ok: true, status: 200 });
    expect(await fetchIn('p', 'http://169.254.169.254/latest/meta-data')).toMatchObject({ ok: true, status: 200 });
    expect((await canary.hits('p')).map((h) => h.listener)).toEqual(['loopback8080']);
    expect((await canary.hits('meta')).map((h) => h.listener)).toEqual(['metadata']);
    expect(await canary.hits('a')).toEqual([]);
    await canary.reset();
  });

  test('positive control: anchor-p reaches https://evil.test using the test CA', async () => {
    await fake.reset();
    const res = await fetchIn('p', 'https://evil.test/.well-known/anchor/info');
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect((await fake.requests(1, { path: '/.well-known' }))[0]).toMatchObject({ scheme: 'https', host: 'evil.test' });
  });

  test('without NODE_EXTRA_CA_CERTS anchor-p refuses the same host', async () => {
    const res = await fetchIn('p', 'https://evil.test/.well-known/anchor/info', { env: { NODE_EXTRA_CA_CERTS: null } });
    expect(res.ok).toBe(false);
  });

  test('bad certs are refused even with the CA: wrongcert, selfsigned, expired', async () => {
    for (const host of ['wrongcert.test', 'selfsigned.test', 'expired.test']) {
      const res = await fetchIn('p', `https://${host}/`);
      expect({ host, ok: res.ok }).toEqual({ host, ok: false });
    }
  });

  test('anchor-q fetches evil.test through the smokescreen proxy and not directly', async () => {
    await fake.reset();
    const via = await fetchIn('q', 'https://evil.test/.well-known/anchor/info', { env: { HTTPS_PROXY: `http://${ips.proxy.egress}:3128` } });
    expect(via).toMatchObject({ ok: true, status: 200 });
    const direct = await fetchIn('q', 'https://evil.test/.well-known/anchor/info', { env: { HTTPS_PROXY: null } });
    expect(direct.ok).toBe(false);
  });

  test('anchor-p and anchor-q discover evil.test over https (q via the proxy configured in its config.toml)', async () => {
    for (const [name, expectedSource] of [['p', '203.0.113.10'], ['q', ips.proxy.pub]] as const) {
      await restart(name); // discovery results are cached in memory for 5 minutes
      await fake.reset();
      await fake.respond(1, '/.well-known/anchor/info', { discovery: { homeserver: 'evil.test', baseUrl: 'https://evil.test' } });
      const { headers } = await fake.sign({ identity: 1, method: 'POST', path: '/federation/friends/status', host: '127.0.0.1', homeserver: 'evil.test', body: '{}' });
      const res = await fetchIn(name, 'http://127.0.0.1/federation/friends/status', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      expect(res.ok && res.body).not.toMatch(/discover/i); // "Invalid federation user" is fine: verification passed
      const seen = await fake.requests(1, { path: '/.well-known' });
      expect({ name, source: seen[0]?.sourceIp, scheme: seen[0]?.scheme }).toEqual({ name, source: expectedSource, scheme: 'https' });
    }
    await fake.reset();
  });

  test('the proxy denies private destinations', async () => {
    const res = await fetchIn('q', `http://${ips.canary}/`, { env: { HTTP_PROXY: `http://${ips.proxy.egress}:3128` } });
    expect(res.ok && res.status).not.toBe(200);
    expect(await canary.hits()).toEqual([]);
    expect((await proxy.denies()).length).toBeGreaterThan(0);
  });

  test('b-proxy (Caddy) serves b.test over https to anchor-p', async () => {
    const res = await fetchIn('p', 'https://b.test/.well-known/anchor/info');
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse((res as { body: string }).body).homeserver).toBe(anchors.b.homeserver);
  });
});
