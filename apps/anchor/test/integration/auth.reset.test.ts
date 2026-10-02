import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { clearMail, latestOtpFor, messagesFor } from '../harness/mail';
import { meStatus, post } from '../harness/http';
import { parseSetCookie, signup } from '../harness/users';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'authreset' });
  await clearMail();
});
afterAll(() => anchor?.destroy());

const request = (email: string) => post(anchor.url, '/auth/password-reset/request', { email });
const reset = (email: string, code: string, newPassword = 'a-brand-new-password') =>
  post(anchor.url, '/auth/reset-password', { email, newPassword, verificationCode: Number(code) });
const login = (username: string, password: string) => post(anchor.url, '/auth/login', { username, password });

async function requestCode(email: string) {
  const since = Date.now() - 1000;
  expect((await request(email)).status).toBe(200);
  return latestOtpFor(email, { since });
}

describe('password reset', () => {
  test('request -> mailed OTP -> reset changes the password', async () => {
    const u = await signup(anchor.url);
    const code = await requestCode(u.email);
    const res = await reset(u.email, code);
    expect(res.status).toBe(200);
    expect((await login(u.user.username, u.password)).status).toBe(401);
    expect((await login(u.user.username, 'a-brand-new-password')).status).toBe(200);
  });

  test('requesting for an unknown email answers the same and sends nothing', async () => {
    const u = await signup(anchor.url);
    const known = await request(u.email);
    const email = 'nobody-here@example.test';
    const unknown = await request(email);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    await Bun.sleep(500);
    expect(await messagesFor(email)).toHaveLength(0);
  });

  test('a wrong code is 400 and leaves the password alone', async () => {
    const u = await signup(anchor.url);
    const code = await requestCode(u.email);
    const wrong = code === '123456' ? '654321' : '123456';
    expect((await reset(u.email, wrong)).status).toBe(400);
    expect((await login(u.user.username, u.password)).status).toBe(200);
  });

  test('a code for one account does not work for another', async () => {
    const a = await signup(anchor.url);
    const b = await signup(anchor.url);
    const code = await requestCode(a.email);
    expect((await reset(b.email, code)).status).toBe(400);
    expect((await login(b.user.username, b.password)).status).toBe(200);
  });

  test('an expired code is rejected', async () => {
    const u = await signup(anchor.url);
    const code = await requestCode(u.email);
    const sql = connect(anchor.databaseUrl);
    try {
      await sql`UPDATE email_otps SET "expiresAt" = now() - interval '1 minute' WHERE email = ${u.email}`;
    } finally {
      await sql.close();
    }
    expect((await reset(u.email, code)).status).toBe(400);
    expect((await login(u.user.username, u.password)).status).toBe(200);
  });

  // gap: reset-password never deletes the email_otps row, so the code works again until it expires
  test.failing('the OTP is single use', async () => {
    const u = await signup(anchor.url);
    const code = await requestCode(u.email);
    expect((await reset(u.email, code, 'first-new-password')).status).toBe(200);
    expect((await reset(u.email, code, 'second-new-password')).status).toBe(400);
  });

  // gap: reset-password only updates the hash; sessions created before the reset stay valid
  test.failing('every session created before the reset is revoked', async () => {
    const u = await signup(anchor.url);
    const other = parseSetCookie(await login(u.user.username, u.password))!;
    const code = await requestCode(u.email);
    expect((await reset(u.email, code)).status).toBe(200);
    expect(await meStatus(anchor.url, u.cookie)).toBe(401);
    expect(await meStatus(anchor.url, other)).toBe(401);
  });

  // gap: signup stores the email as typed but the reset request lower-cases it
  test.failing('an account whose email has capitals can reset its password', async () => {
    const u = await signup(anchor.url, { email: `Mixed.${Date.now().toString(36)}@Example.test` });
    const since = Date.now() - 1000;
    await request(u.email);
    const code = await latestOtpFor(u.email.toLowerCase(), { since, timeout: 3000 });
    expect((await reset(u.email, code)).status).toBe(200);
  });
});
