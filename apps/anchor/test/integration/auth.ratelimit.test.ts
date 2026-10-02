import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { post } from '../harness/http';
import { freshIp, uniqueName } from '../harness/users';

// own anchor: the limits are in memory and per client IP, and a restart clears them
let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'authlimit' });
});
afterAll(() => anchor?.destroy());

const statuses = async (path: string, count: number, ip: () => string, body: () => unknown) => {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await post(anchor.url, path, body(), { 'x-forwarded-for': ip() })).status);
  return out;
};
const badLogin = () => ({ username: uniqueName('ghost'), password: 'not-the-password' });
const newSignup = () => {
  const username = uniqueName();
  return { username, email: `${username}@example.test`, password: 'correct-horse-battery' };
};

describe('login: 10 per minute per IP', () => {
  test('the 11th attempt from one IP is 429 and another IP is unaffected', async () => {
    const ip = freshIp();
    const results = await statuses('/auth/login', 11, () => ip, badLogin);
    expect(results.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(results[10]).toBe(429);
    const blocked = await post(anchor.url, '/auth/login', badLogin(), { 'x-forwarded-for': ip });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'Too many requests. Try again later.' });

    const other = await post(anchor.url, '/auth/login', badLogin(), { 'x-forwarded-for': freshIp() });
    expect(other.status).toBe(401);
  });

  test('a correct login from a blocked IP is blocked too', async () => {
    const ip = freshIp();
    await statuses('/auth/signup', 1, () => ip, newSignup);
    const body = newSignup();
    await post(anchor.url, '/auth/signup', body, { 'x-forwarded-for': freshIp() });
    await statuses('/auth/login', 10, () => ip, badLogin);
    const res = await post(anchor.url, '/auth/login', { username: body.username, password: body.password }, { 'x-forwarded-for': ip });
    expect(res.status).toBe(429);
  });

  test('limits are per route: a blocked login does not block signup from the same IP', async () => {
    const ip = freshIp();
    await statuses('/auth/login', 11, () => ip, badLogin);
    expect((await statuses('/auth/signup', 1, () => ip, newSignup))[0]).toBe(200);
  });
});

test('signup: the 6th attempt in an hour from one IP is 429', async () => {
  const ip = freshIp();
  const results = await statuses('/auth/signup', 6, () => ip, newSignup);
  expect(results).toEqual([200, 200, 200, 200, 200, 429]);
});

test('login/mfa/email: the 4th request from one IP is 429', async () => {
  const ip = freshIp();
  const results = await statuses('/auth/login/mfa/email', 4, () => ip, () => ({ challenge: 'x'.repeat(24) }));
  expect(results).toEqual([401, 401, 401, 429]);
});

// gap: authRateLimit() plugins with the same (max, duration) are deduplicated by Elysia, so the
// password-reset/request limiter (3 per 15 min, same as login/mfa/email) is never applied
test.failing('password-reset/request: the 4th request from one IP is 429', async () => {
  const ip = freshIp();
  const results = await statuses('/auth/password-reset/request', 4, () => ip, () => ({ email: `${uniqueName()}@example.test` }));
  expect(results).toEqual([200, 200, 200, 429]);
});

// gap: same dedup as above, the login/mfa limiter (10 per minute) is the same plugin instance as /login's
test.failing('login/mfa: the 11th attempt from one IP is 429', async () => {
  const ip = freshIp();
  const results = await statuses('/auth/login/mfa', 11, () => ip, () => ({ challenge: 'x'.repeat(24), method: 'TOTP', code: '123456' }));
  expect(results.slice(0, 10)).toEqual(Array(10).fill(401));
  expect(results[10]).toBe(429);
});

test('reset-password: the 6th attempt from one IP is 429', async () => {
  const ip = freshIp();
  const results = await statuses('/auth/reset-password', 6, () => ip, () => ({
    email: `${uniqueName()}@example.test`,
    newPassword: 'a-brand-new-password',
    verificationCode: 123456,
  }));
  expect(results).toEqual([400, 400, 400, 400, 400, 429]);
});

// The limiter trusts the first X-Forwarded-For value (elysia-ip headersFirst), so a client that can set the header
// picks its own bucket. Deployment requirement: a trusted reverse proxy must overwrite X-Forwarded-For.
test('a spoofed X-Forwarded-For bypasses the limit (documented: the proxy must overwrite it)', async () => {
  const results = await statuses('/auth/login', 15, freshIp, badLogin);
  expect(results).toEqual(Array(15).fill(401));
});

test('a restart clears the counters (in-memory limiter)', async () => {
  const ip = freshIp();
  const results = await statuses('/auth/login', 11, () => ip, badLogin);
  expect(results[10]).toBe(429);
  await anchor.restart();
  expect((await statuses('/auth/login', 1, () => ip, badLogin))[0]).toBe(401);
});
