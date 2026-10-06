import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { anchorRoot } from '../harness/env';
import { api, resetHarness } from '../harness/federation';
import { ensurePingUser, fakeUser, ready, rowCounts, sendFrom } from '../harness/fedVerify';

setDefaultTimeout(120_000); // hooks restart anchors and wait on canaries; a multi-file run resets bun's timeout

// TESTING_PLAN 7 "federation fuzz": valid signatures, hostile payloads, every federation route. Expect 4xx (never 5xx)
// and no writes to anchor-a's database (row counts of every table except federation_nonce/session are unchanged).
const routesDir = path.join(anchorRoot, 'modules/federation/routes');
const source = readdirSync(routesDir)
  .map((file) => readFileSync(path.join(routesDir, file), 'utf8'))
  .join('\n');
const routes = [...source.matchAll(/\.(get|post)\(\s*'([^']+)'/g)].map((m) => ({ method: m[1]!.toUpperCase(), route: m[2]! }));
const concrete = (route: string, param = 'x') => `/federation${route.replace(/:[a-zA-Z]+/g, param)}`;

// small seeded PRNG (mulberry32) so a failure reproduces: FUZZ_SEED=123 bun test ...
const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 1e9);
const rand = (() => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

const deep = (n: number): unknown => (n === 0 ? 1 : { a: deep(n - 1) });
// every value is wrong for every field of every route, so a random body can never be a valid request
const junk = (): unknown =>
  pick([null, true, false, 0, -1, 1.5, 2 ** 53, '', ' ', 'x'.repeat(70_000), '\u0000', '‮😀', '../../etc/passwd', "'; drop table user;--", [], [null], [[]], {}, { a: 1 }, deep(60), -0.0, 'a'.repeat(300), 1e999]);
const fields = ['user', 'actor', 'remoteUser', 'peerUsername', 'channelId', 'channelIds', 'channels', 'participants', 'content', 'nonce', 'replyTo', 'attachmentIds', 'messageId', 'limit', 'cursor', 'connected', 'status', 'ringing', 'action', 'commandId', 'expectedVersion', 'localUsername', 'requestedBy', 'version', 'createdAt', 'filename', 'contentType', 'size', 'peer', 'username', 'homeserver', '__proto__', 'constructor'];

const bodies = (signer: string) => {
  const out: string[] = ['', 'null', '[]', '{}', '"x"', '123', 'true', '{', 'not json', '\u0000', '{"user":', '[1,2,3]', JSON.stringify(deep(5_000)), JSON.stringify({ user: 'x'.repeat(1_000_000) })];
  for (let i = 0; i < 12; i++) {
    const o: Record<string, unknown> = {};
    for (let k = 0; k < 1 + Math.floor(rand() * 6); k++) o[pick(fields)] = junk();
    if (rand() < 0.6) o.user = { ...fakeUser(signer), ...(rand() < 0.5 ? { username: pick(['a', 'x'.repeat(500), '<script>', '../x']) } : { avatarUrl: pick(['javascript:alert(1)', 'x'.repeat(5000), 5]) }) };
    try {
      out.push(JSON.stringify(o));
    } catch {
      out.push('{}');
    }
  }
  return out;
};

beforeAll(async () => {
  await ready();
  await resetHarness();
  console.log(`federation fuzz seed: ${seed}`);
});

describe('federation fuzz (valid signature, hostile payload)', () => {
  test('route table parsed', () => expect(routes.filter((r) => r.method === 'POST').length).toBeGreaterThanOrEqual(19));

  test('every signed POST route answers 4xx for every payload and writes nothing', async () => {
    const before = await rowCounts('a');
    const unexpected: string[] = [];
    let sent = 0;
    for (const { route } of routes.filter((r) => r.method === 'POST')) {
      for (const [i, body] of bodies('172.30.0.66').entries()) {
        const path = concrete(route, i % 3 === 0 ? encodeURIComponent('../%00‮') : i % 3 === 1 ? 'x'.repeat(300) : 'nope');
        const res = await sendFrom(1, 'a', path, body);
        sent++;
        if (res.status < 400 || res.status >= 500) unexpected.push(`${route} ${res.status} body=${body.slice(0, 80)}: ${res.text.slice(0, 120)}`);
      }
    }
    console.log(`federation fuzz: ${sent} requests`);
    expect(unexpected).toEqual([]);
    expect(await rowCounts('a')).toEqual(before);
  }, 300_000);

  test('anchor-a is still healthy afterwards', async () => {
    expect(await (await fetch(`${api('a')}/`)).text()).toBe('this is anchor');
  });

  test('GET routes with hostile params answer 4xx, never 5xx', async () => {
    const before = await rowCounts('a');
    for (const { route } of routes.filter((r) => r.method === 'GET')) {
      for (const param of ['x', '..%2f..%2fetc', '%E2%80%AE', 'a'.repeat(5000), encodeURIComponent("' or 1=1 --")]) {
        const res = await fetch(`${api('a')}${concrete(route, param)}`);
        expect(res.status).toBeLessThan(500);
        await res.text();
      }
    }
    expect(await rowCounts('a')).toEqual(before);
  });

  // Known gap (found by this fuzz): a NUL byte in a path parameter reaches Postgres, which rejects it, and the route answers
  // 500 with the failed SQL text instead of 404/400. Applies to every federation route with a :id/:code/:username param.
  test.failing('a NUL byte in a path parameter -> 4xx without leaking SQL (GET and signed POST routes)', async () => {
    const bad: string[] = [];
    for (const { method, route } of routes.filter((r) => /:[a-zA-Z]+/.test(r.route))) {
      const path = concrete(route, '%00');
      const res = method === 'GET' ? await fetch(`${api('a')}${path}`) : await sendFrom(1, 'a', path, { user: fakeUser('172.30.0.66', 'fkping') });
      const text = 'text' in res && typeof res.text === 'string' ? res.text : await (res as Response).text();
      if (res.status >= 500 || /Failed query/i.test(text)) bad.push(`${method} ${route} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  test('unsigned and half-signed POSTs are 400, never 5xx', async () => {
    for (const { route } of routes.filter((r) => r.method === 'POST')) {
      for (const headers of [{}, { 'x-novarum-homeserver': '172.30.0.66' }, { 'x-novarum-homeserver': 'a/b', 'x-novarum-key-id': 'k', 'x-novarum-date': 'd', 'x-novarum-nonce': 'n', 'x-novarum-signature': 's', 'x-novarum-body-sha256': 'h' }] as Record<string, string>[]) {
        const res = await fetch(`${api('a')}${concrete(route)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        await res.text();
      }
    }
  });
});
