import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { meStatus, post, withCookie } from '../harness/http';
import { parseSetCookie, signup, uniqueName } from '../harness/users';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'auth' });
});
afterAll(() => anchor?.destroy());

const signupBody = (over: Record<string, unknown> = {}) => {
  const username = uniqueName();
  return { username, email: `${username}@example.test`, password: 'correct-horse-battery', ...over };
};

describe('signup', () => {
  test('sets a session cookie (HttpOnly, SameSite=Lax, not Secure on http) and returns the user', async () => {
    const body = signupBody({ displayName: 'Shown' });
    const res = await post(anchor.url, '/auth/signup', body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.user).toMatchObject({
      username: body.username,
      handle: `@${body.username}:localhost`,
      homeserver: 'localhost',
      email: body.email,
      displayName: 'Shown',
    });
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('session_token='))!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');
    expect(raw).toContain('Max-Age=31536000');
    expect(raw).not.toContain('Secure');
    expect(raw).not.toContain('Partitioned');
    expect(await meStatus(anchor.url, parseSetCookie(res)!)).toBe(200);
  });

  test('duplicate email and duplicate username are 409', async () => {
    const first = await signup(anchor.url);
    const sameEmail = await post(anchor.url, '/auth/signup', signupBody({ email: first.email }));
    expect(sameEmail.status).toBe(409);
    expect(((await sameEmail.json()) as any).error).toMatch(/email/i);
    const sameName = await post(anchor.url, '/auth/signup', signupBody({ username: first.user.username }));
    expect(sameName.status).toBe(409);
    expect(((await sameName.json()) as any).error).toMatch(/username/i);
  });

  test.each([
    ['username too short', { username: 'a' }],
    ['username too long', { username: 'a'.repeat(33) }],
    ['username with a space', { username: 'bad name' }],
    ['username with a colon', { username: 'bad:name' }],
    ['password too short', { password: '1234567' }],
    ['display name too long', { displayName: 'x'.repeat(65) }],
  ])('rejects %s with 422', async (_name, over) => {
    expect((await post(anchor.url, '/auth/signup', signupBody(over))).status).toBe(422);
  });

  // gap: the schema uses `t.String({ type: 'email' })`, which is not a format check
  test.failing('rejects an invalid email with 422', async () => {
    expect((await post(anchor.url, '/auth/signup', signupBody({ email: 'not-an-email' }))).status).toBe(422);
  });

  test('accepts the username and password length bounds', async () => {
    for (const over of [{ username: 'a.' }, { username: uniqueName().padEnd(32, 'z') }, { password: '12345678' }]) {
      const body = signupBody(over);
      body.email = `${uniqueName()}@example.test`;
      expect((await post(anchor.url, '/auth/signup', body)).status).toBe(200);
    }
  });
});

describe('login', () => {
  test('logs in with the password and returns a working session', async () => {
    const u = await signup(anchor.url);
    const res = await post(anchor.url, '/auth/login', { username: u.user.username, password: u.password });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.id).toBe(u.user.id);
    expect(await meStatus(anchor.url, parseSetCookie(res)!)).toBe(200);
  });

  test('wrong password and unknown user give the same status and body', async () => {
    const u = await signup(anchor.url);
    const wrong = await post(anchor.url, '/auth/login', { username: u.user.username, password: 'not-the-password' });
    const unknown = await post(anchor.url, '/auth/login', { username: uniqueName('ghost'), password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect(unknown.headers.getSetCookie()).toEqual([]);
  });

  // gap: an unknown user skips the argon2 verify, so it answers in a few ms against ~50ms+ for a wrong password
  test.failing('response time does not reveal whether the user exists', async () => {
    const u = await signup(anchor.url);
    const time = async (username: string) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await post(anchor.url, '/auth/login', { username, password: 'not-the-password' });
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b)[2]!;
    };
    const known = await time(u.user.username);
    const unknown = await time(uniqueName('ghost'));
    expect(Math.abs(known - unknown) / Math.max(known, unknown)).toBeLessThan(0.5);
  });

  test('login is by username, not by email', async () => {
    const u = await signup(anchor.url);
    const res = await post(anchor.url, '/auth/login', { username: u.email, password: u.password });
    expect(res.status).toBe(422); // the '@' fails the username pattern
  });
});

describe('/me, logout and session tokens', () => {
  test('/me without a cookie is 401 with a null user', async () => {
    const res = await fetch(`${anchor.url}/auth/me`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ user: null });
  });

  test('logout deletes the session row and replaying the cookie is 401', async () => {
    const u = await signup(anchor.url);
    const token = u.cookie.split('.')[0]!;
    const sql = connect(anchor.databaseUrl);
    try {
      expect(await sql`SELECT 1 FROM session WHERE id = ${token}`).toHaveLength(1);
      const res = await post(anchor.url, '/auth/logout', {}, withCookie(u.cookie));
      expect(res.status).toBe(200);
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith('session_token='))!;
      expect(cleared).toMatch(/session_token=;/);
      expect(cleared).toContain('Max-Age=0');
      expect(await sql`SELECT 1 FROM session WHERE id = ${token}`).toHaveLength(0);
    } finally {
      await sql.close();
    }
    expect(await meStatus(anchor.url, u.cookie)).toBe(401);
  });

  test('logout only ends the current session', async () => {
    const u = await signup(anchor.url);
    const second = await post(anchor.url, '/auth/login', { username: u.user.username, password: u.password });
    const secondCookie = parseSetCookie(second)!;
    await post(anchor.url, '/auth/logout', {}, withCookie(u.cookie));
    expect(await meStatus(anchor.url, u.cookie)).toBe(401);
    expect(await meStatus(anchor.url, secondCookie)).toBe(200);
  });

  test('logout without a session still succeeds', async () => {
    expect((await post(anchor.url, '/auth/logout', {})).status).toBe(200);
  });

  test('tampered tokens are rejected', async () => {
    const u = await signup(anchor.url);
    const [id, secret] = u.cookie.split('.') as [string, string];
    for (const token of [
      `${id}.${'x'.repeat(secret.length)}`, // valid id, wrong secret
      `${id}.${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`, // one character off
      `${id}.`,
      `.${secret}`,
      id,
      `${id}.${secret}.extra`,
      `nonexistent.${secret}`,
      'garbage',
      '%00',
    ]) {
      expect(await meStatus(anchor.url, token)).toBe(401);
    }
    expect(await meStatus(anchor.url, u.cookie)).toBe(200);
  });

  test('an invalid cookie on /me is cleared in the response', async () => {
    const res = await fetch(`${anchor.url}/auth/me`, { headers: withCookie('garbage.token') });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join(';')).toContain('Max-Age=0');
  });

  test('an expired session row is deleted on access', async () => {
    const u = await signup(anchor.url);
    const id = u.cookie.split('.')[0]!;
    const sql = connect(anchor.databaseUrl);
    try {
      await sql`UPDATE session SET "expiresAt" = now() - interval '1 minute' WHERE id = ${id}`;
      expect(await meStatus(anchor.url, u.cookie)).toBe(401);
      expect(await sql`SELECT 1 FROM session WHERE id = ${id}`).toHaveLength(0);
    } finally {
      await sql.close();
    }
  });
});
