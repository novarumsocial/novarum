import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { post, withCookie } from '../harness/http';
import { parseSetCookie, signup, uniqueName } from '../harness/users';

// base_url is https (clients still connect over http to 127.0.0.1) so the cookie must be cross-site capable
let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'authcookie', baseUrl: 'https://anchor.example.test' });
});
afterAll(() => anchor?.destroy());

const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('session_token='))!;

test('signup and login cookies are Secure, SameSite=None and Partitioned when base_url is https', async () => {
  const u = await signup(anchor.url);
  const username = uniqueName();
  const res = await post(anchor.url, '/auth/signup', {
    username,
    email: `${username}@example.test`,
    password: 'correct-horse-battery',
  });
  const login = await post(anchor.url, '/auth/login', { username: u.user.username, password: u.password });
  for (const raw of [sessionCookie(res), sessionCookie(login)]) {
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=None');
    expect(raw).toContain('Partitioned');
    expect(raw).toContain('Path=/');
  }
  expect(parseSetCookie(login)).toBeTruthy();
});

test('the clearing cookie on logout carries the same attributes', async () => {
  const u = await signup(anchor.url);
  const raw = sessionCookie(await post(anchor.url, '/auth/logout', {}, withCookie(u.cookie)));
  expect(raw).toContain('Max-Age=0');
  expect(raw).toContain('Secure');
  expect(raw).toContain('SameSite=None');
  expect(raw).toContain('Partitioned');
});
