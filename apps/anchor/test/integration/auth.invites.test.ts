import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { post } from '../harness/http';
import { uniqueName } from '../harness/users';
import { connect } from '../harness/db';
import { exchange, ssoRedirect, ssoSignup, startIdp } from '../harness/sso';

// every invite is made by spawning the cli
setDefaultTimeout(30_000);

let inviteOnly: RunningAnchor;
let ssoOnly: RunningAnchor;
let idp: Awaited<ReturnType<typeof startIdp>>;

beforeAll(async () => {
  idp = await startIdp();
  [inviteOnly, ssoOnly] = await Promise.all([
    spawnAnchor({
      name: 'inviteonly',
      config: { auth: { invite_only: true, providers: idp.providers } },
    }),
    spawnAnchor({
      name: 'ssoonly',
      config: { auth: { password_signup: false, providers: idp.providers } },
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([inviteOnly?.destroy(), ssoOnly?.destroy()]);
  await idp?.stop();
});

const signupWith = (anchor: RunningAnchor, inviteCode?: string) => {
  const username = uniqueName();
  return post(anchor.url, '/auth/signup', {
    username,
    email: `${username}@example.test`,
    password: 'correct-horse-battery',
    inviteCode,
  });
};

const createInvite = async (...args: string[]) => {
  const { code, stdout, stderr } = await inviteOnly.cli('create-signup-invite', ...args);
  expect(code, stderr).toBe(0);
  return stdout.trim();
};

describe('invite-only homeserver', () => {
  test('well-known says so', async () => {
    const info: any = await (await fetch(`${inviteOnly.url}/.well-known/anchor/info`)).json();
    expect(info.auth).toMatchObject({ inviteOnly: true, passwordSignup: true });
  });

  test('signing up without a code or with a made-up one is refused', async () => {
    expect((await signupWith(inviteOnly)).status).toBe(403);
    expect((await signupWith(inviteOnly, 'not-a-real-code')).status).toBe(403);
  });

  test('a single-use invite works exactly once', async () => {
    const code = await createInvite('--uses', '1');
    expect((await signupWith(inviteOnly, code)).status).toBe(200);
    expect((await signupWith(inviteOnly, code)).status).toBe(403);
  });

  test('a failed signup does not use up the invite', async () => {
    const code = await createInvite('--uses', '1');
    const username = uniqueName();
    const body = { username, email: `${username}@example.test`, password: 'correct-horse-battery' };
    expect((await post(inviteOnly.url, '/auth/signup', { ...body, inviteCode: code })).status).toBe(
      200
    );
    const reuse = await createInvite('--uses', '1');
    const clash = await post(inviteOnly.url, '/auth/signup', { ...body, inviteCode: reuse });
    expect(clash.status).toBe(409);
    expect((await signupWith(inviteOnly, reuse)).status).toBe(200);
  });

  test('concurrent signups cannot use an invite more often than allowed', async () => {
    const code = await createInvite('--uses', '2');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => signupWith(inviteOnly, code))
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
  });

  test('an unlimited invite keeps working, and stops once revoked', async () => {
    const code = await createInvite();
    expect((await signupWith(inviteOnly, code)).status).toBe(200);
    expect((await signupWith(inviteOnly, code)).status).toBe(200);
    expect((await inviteOnly.cli('list-signup-invites')).stdout).toContain(`${code}  2/∞ uses`);
    expect((await inviteOnly.cli('revoke-signup-invite', code)).code).toBe(0);
    expect((await signupWith(inviteOnly, code)).status).toBe(403);
    expect((await inviteOnly.cli('revoke-signup-invite', code)).code).toBe(1);
  });

  test('expired invites are refused', async () => {
    const code = await createInvite('--days', '1');
    const sql = connect(inviteOnly.databaseUrl);
    await sql`UPDATE signup_invite SET "expiresAt" = now() - interval '1 minute' WHERE code = ${code}`;
    await sql.close();
    expect((await signupWith(inviteOnly, code)).status).toBe(403);
  });

  test('the cli rejects bad numbers', async () => {
    expect((await inviteOnly.cli('create-signup-invite', '--uses', '0')).code).toBe(1);
    expect((await inviteOnly.cli('create-signup-invite', '--days', 'soon')).code).toBe(1);
  });

  // invite-only gates password signups; accounts from the configured providers are trusted
  test('single sign-on signups do not need an invite', async () => {
    const username = uniqueName('sso');
    idp.as({ sub: 'invite-free', preferred_username: username });
    const { code, verifier } = await ssoRedirect(inviteOnly, 'idp');
    expect((await ssoSignup(inviteOnly, { code: code!, verifier, username })).status).toBe(200);
  });
});

describe('password signup disabled', () => {
  test('password signups are refused even with a valid body', async () => {
    expect((await signupWith(ssoOnly)).status).toBe(403);
    const info: any = await (await fetch(`${ssoOnly.url}/.well-known/anchor/info`)).json();
    expect(info.auth.passwordSignup).toBe(false);
  });

  test('single sign-on still creates accounts', async () => {
    const username = uniqueName('sso');
    idp.as({ sub: 'sso-only', preferred_username: username });
    const { code, verifier } = await ssoRedirect(ssoOnly, 'idp');
    expect((await exchange(ssoOnly, code!, verifier)).status).toBe(200);
    expect((await ssoSignup(ssoOnly, { code: code!, verifier, username })).status).toBe(200);
  });
});
