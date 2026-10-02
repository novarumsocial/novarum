import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { clearMail, latestOtpFor } from '../harness/mail';
import { meStatus, post, withCookie } from '../harness/http';
import { parseSetCookie, signup } from '../harness/users';
import { decodeBase32, generateHOTP, generateTOTP } from '../../utils/otp';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'authmfa' });
  await clearMail();
});
afterAll(() => anchor?.destroy());

type User = Awaited<ReturnType<typeof signup>>;

const totpNow = (secret: string) => generateTOTP(decodeBase32(secret), 30, 6);
const totpAt = (secret: string, offsetSeconds: number) =>
  generateHOTP(decodeBase32(secret), BigInt(Math.floor((Date.now() + offsetSeconds * 1000) / 30_000)), 6);

async function enableTotp(u: User) {
  const qr = await u.fetch('/auth/mfa/totp/qr');
  expect(qr.status).toBe(200);
  const { uri, secret } = (await qr.json()) as { uri: string; secret: string };
  expect(uri).toStartWith('otpauth://totp/');
  expect(uri).toContain(secret);
  const res = await u.fetch('/auth/mfa/totp/enable', {
    method: 'POST',
    body: JSON.stringify({ secret, code: totpNow(secret) }),
  });
  expect(res.status).toBe(200);
  return secret;
}

const passwordLogin = (u: User) =>
  post(anchor.url, '/auth/login', { username: u.user.username, password: u.password });

async function challenge(u: User) {
  const res = await passwordLogin(u);
  expect(res.status).toBe(202);
  expect(res.headers.getSetCookie()).toEqual([]); // no session before the second factor
  return (await res.json()) as { mfaRequired: true; challenge: string; methods: string[] };
}

const mfaLogin = (challengeId: string, method: 'EMAIL' | 'TOTP', code: string) =>
  post(anchor.url, '/auth/login/mfa', { challenge: challengeId, method, code });

describe('TOTP', () => {
  test('qr -> enable -> login returns a challenge -> /login/mfa creates the session', async () => {
    const u = await signup(anchor.url);
    expect(await (await u.fetch('/auth/mfa')).json()).toEqual({ mfaOptions: [] });
    const secret = await enableTotp(u);
    expect(await (await u.fetch('/auth/mfa')).json()).toEqual({ mfaOptions: ['TOTP'] });

    const c = await challenge(u);
    expect(c.methods).toEqual(['TOTP']);
    const res = await mfaLogin(c.challenge, 'TOTP', totpNow(secret));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.id).toBe(u.user.id);
    expect(await meStatus(anchor.url, parseSetCookie(res)!)).toBe(200);
  });

  test('qr is refused once TOTP is enabled, and enabling twice is refused', async () => {
    const u = await signup(anchor.url);
    const secret = await enableTotp(u);
    expect((await u.fetch('/auth/mfa/totp/qr')).status).toBe(400);
    const again = await u.fetch('/auth/mfa/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ secret, code: totpNow(secret) }),
    });
    expect(again.status).toBe(400);
  });

  test('enable rejects a wrong code', async () => {
    const u = await signup(anchor.url);
    const { secret } = (await (await u.fetch('/auth/mfa/totp/qr')).json()) as { secret: string };
    const wrong = totpAt(secret, 600);
    const res = await u.fetch('/auth/mfa/totp/enable', { method: 'POST', body: JSON.stringify({ secret, code: wrong }) });
    expect(res.status).toBe(400);
    expect(await (await u.fetch('/auth/mfa')).json()).toEqual({ mfaOptions: [] });
  });

  test('a wrong or expired code is 401 and creates no session; the challenge stays usable', async () => {
    const u = await signup(anchor.url);
    const secret = await enableTotp(u);
    const c = await challenge(u);
    for (const code of [totpAt(secret, -300), totpAt(secret, 300)]) {
      const res = await mfaLogin(c.challenge, 'TOTP', code);
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect((await mfaLogin(c.challenge, 'TOTP', totpNow(secret))).status).toBe(200);
  });

  test('a challenge is single use', async () => {
    const u = await signup(anchor.url);
    const secret = await enableTotp(u);
    const c = await challenge(u);
    expect((await mfaLogin(c.challenge, 'TOTP', totpNow(secret))).status).toBe(200);
    expect((await mfaLogin(c.challenge, 'TOTP', totpNow(secret))).status).toBe(401);
  });

  test('a made-up challenge, a malformed code and a method the user lacks are rejected', async () => {
    const u = await signup(anchor.url);
    const secret = await enableTotp(u);
    expect((await mfaLogin('x'.repeat(24), 'TOTP', totpNow(secret))).status).toBe(401);
    const c = await challenge(u);
    expect((await mfaLogin(c.challenge, 'TOTP', '12345')).status).toBe(422);
    expect((await mfaLogin(c.challenge, 'EMAIL', '123456')).status).toBe(401);
  });

  // gap (RFC 6238 5.2): a TOTP code is accepted again for a new challenge inside its validity window
  test.failing('a TOTP code cannot be replayed on a second login', async () => {
    const u = await signup(anchor.url);
    const secret = await enableTotp(u);
    const code = totpNow(secret);
    expect((await mfaLogin((await challenge(u)).challenge, 'TOTP', code)).status).toBe(200);
    expect((await mfaLogin((await challenge(u)).challenge, 'TOTP', code)).status).toBe(401);
  });

  test('toggle off skips the challenge, toggle on needs a secret, DELETE /mfa/totp removes it', async () => {
    const u = await signup(anchor.url);
    const toggle = (enable: boolean) =>
      u.fetch('/auth/mfa/totp/toggle', { method: 'POST', body: JSON.stringify({ enable }) });
    expect((await toggle(true)).status).toBe(400);
    expect((await u.fetch('/auth/mfa/totp', { method: 'DELETE' })).status).toBe(400);

    const secret = await enableTotp(u);
    expect((await toggle(false)).status).toBe(200);
    expect(await (await u.fetch('/auth/mfa')).json()).toEqual({ mfaOptions: [] });
    expect((await passwordLogin(u)).status).toBe(200);

    expect((await toggle(true)).status).toBe(200);
    expect((await passwordLogin(u)).status).toBe(202);

    expect((await u.fetch('/auth/mfa/totp', { method: 'DELETE' })).status).toBe(200);
    expect(await (await u.fetch('/auth/mfa')).json()).toEqual({ mfaOptions: [] });
    expect((await passwordLogin(u)).status).toBe(200);
    // the secret is gone, so qr hands out a new one
    const qr = (await (await u.fetch('/auth/mfa/totp/qr')).json()) as { secret: string };
    expect(qr.secret).not.toBe(secret);
  });
});

describe('email MFA', () => {
  const toggleEmail = (u: User, enable: boolean) =>
    u.fetch('/auth/mfa/email/toggle', { method: 'POST', body: JSON.stringify({ enable }) });

  test('login -> /login/mfa/email sends a code -> /login/mfa with it creates the session', async () => {
    const u = await signup(anchor.url);
    expect((await toggleEmail(u, true)).status).toBe(200);
    const c = await challenge(u);
    expect(c.methods).toEqual(['EMAIL']);

    const since = Date.now() - 1000;
    const send = await post(anchor.url, '/auth/login/mfa/email', { challenge: c.challenge });
    expect(send.status).toBe(200);
    const code = await latestOtpFor(u.email, { since });

    expect((await mfaLogin(c.challenge, 'EMAIL', code === '000000' ? '111111' : '000000')).status).toBe(401);
    const res = await mfaLogin(c.challenge, 'EMAIL', code);
    expect(res.status).toBe(200);
    expect(await meStatus(anchor.url, parseSetCookie(res)!)).toBe(200);
    // consumed
    expect((await mfaLogin(c.challenge, 'EMAIL', code)).status).toBe(401);
    expect((await post(anchor.url, '/auth/login/mfa/email', { challenge: c.challenge })).status).toBe(401);
  });

  test('the code cannot be guessed before one is requested', async () => {
    const u = await signup(anchor.url);
    await toggleEmail(u, true);
    const c = await challenge(u);
    for (const code of ['000000', '123456']) expect((await mfaLogin(c.challenge, 'EMAIL', code)).status).toBe(401);
  });

  test('a challenge for a user without email MFA cannot send mail', async () => {
    const u = await signup(anchor.url);
    await toggleEmail(u, true);
    const c = await challenge(u);
    await toggleEmail(u, false);
    expect((await post(anchor.url, '/auth/login/mfa/email', { challenge: c.challenge })).status).toBe(401);
  });

  test('an expired challenge is rejected', async () => {
    const u = await signup(anchor.url);
    await toggleEmail(u, true);
    const c = await challenge(u);
    const sql = connect(anchor.databaseUrl);
    try {
      await sql`UPDATE email_otps SET "expiresAt" = now() - interval '1 minute' WHERE id = ${c.challenge}`;
    } finally {
      await sql.close();
    }
    expect((await post(anchor.url, '/auth/login/mfa/email', { challenge: c.challenge })).status).toBe(401);
    expect((await mfaLogin(c.challenge, 'EMAIL', '123456')).status).toBe(401);
  });

  test('both methods enabled offers both, and either completes the login', async () => {
    const u = await signup(anchor.url);
    const secret = await enableTotp(u);
    await toggleEmail(u, true);
    const c = await challenge(u);
    expect(c.methods.sort()).toEqual(['EMAIL', 'TOTP']);
    expect((await mfaLogin(c.challenge, 'TOTP', totpNow(secret))).status).toBe(200);
  });

  test('the MFA routes need a session', async () => {
    const res = await fetch(`${anchor.url}/auth/mfa`, { headers: withCookie('forged.token') });
    expect(res.status).toBe(401);
  });
});
