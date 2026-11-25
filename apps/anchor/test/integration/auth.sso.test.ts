import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { meStatus, post, withCookie } from '../harness/http';
import { freshIp, parseSetCookie, signup, uniqueName } from '../harness/users';
import { latestOtpFor } from '../harness/mail';
import { appRedirect, exchange, ssoRedirect, ssoSignup, startIdp } from '../harness/sso';

let anchor: RunningAnchor;
let idp: Awaited<ReturnType<typeof startIdp>>;

beforeAll(async () => {
  idp = await startIdp();
  anchor = await spawnAnchor({ name: 'sso', config: { auth: { providers: idp.providers } } });
});
afterAll(async () => {
  await anchor?.destroy();
  await idp?.stop();
});

let subjects = 0;
const person = (extra: Partial<Parameters<typeof idp.as>[0]> = {}) => {
  const username = uniqueName('sso');
  const user = {
    sub: String(1000 + subjects++),
    email: `${username}@idp.test`,
    email_verified: true,
    name: 'Single Sign',
    preferred_username: username,
    ...extra,
  };
  idp.as(user);
  return user;
};

/** signs a fresh provider account up as a new anchor user and returns its session cookie */
async function signUpVia(provider: string) {
  const who = person();
  const { code, verifier } = await ssoRedirect(anchor, provider);
  const res = await ssoSignup(anchor, { code: code!, verifier, username: who.preferred_username });
  expect(res.status).toBe(200);
  return { who, cookie: parseSetCookie(res)!, user: ((await res.json()) as any).user };
}

const identities = async (cookie: string) =>
  (
    await fetch(`${anchor.url}/auth/sso/identities`, { headers: withCookie(cookie) })
  ).json() as Promise<any>;

describe('discovery', () => {
  test('well-known info lists the providers and the signup rules', async () => {
    const info = (await (await fetch(`${anchor.url}/.well-known/anchor/info`)).json()) as any;
    expect(info.auth).toEqual({
      passwordSignup: true,
      inviteOnly: false,
      providers: [
        { id: 'idp', name: 'Fake IdP' },
        { id: 'trusting', name: 'Trusting IdP' },
        { id: 'hub', name: 'FakeHub' },
        { id: 'bare', name: 'BareHub' },
      ],
    });
  });
});

describe('authorize', () => {
  test('unknown provider is 404', async () => {
    const res = await post(anchor.url, '/auth/sso/authorize', {
      provider: 'nope',
      redirectUri: appRedirect,
    });
    expect(res.status).toBe(404);
  });

  test.each([
    'https://evil.test/sso',
    'https://app.novarum.me.evil.test/sso',
    'https://app.novarum.mex/sso',
    'javascript:alert(1)',
    'novarumx://sso',
  ])('refuses to send the result to %s', async (redirectUri) => {
    const res = await post(anchor.url, '/auth/sso/authorize', { provider: 'idp', redirectUri });
    expect(res.status).toBe(400);
  });

  test('linking needs a session', async () => {
    const res = await post(anchor.url, '/auth/sso/authorize', {
      provider: 'idp',
      redirectUri: appRedirect,
      link: true,
    });
    expect(res.status).toBe(401);
  });

  test('builds a PKCE authorization request against the provider', async () => {
    const res = await post(anchor.url, '/auth/sso/authorize', {
      provider: 'idp',
      redirectUri: 'novarum://sso',
    });
    const { url, verifier } = (await res.json()) as any;
    const request = new URL(url);
    expect(request.origin).toBe(idp.issuer);
    expect(request.searchParams.get('redirect_uri')).toBe(`${anchor.baseUrl}/auth/sso/callback`);
    expect(request.searchParams.get('code_challenge_method')).toBe('S256');
    expect(request.searchParams.get('nonce')).toBeTruthy();
    expect(url).not.toContain(verifier);
  });
});

describe('sign up and sign in', () => {
  test('a new provider account picks a username, then signs straight in next time', async () => {
    const who = person();
    const first = await ssoRedirect(anchor, 'idp');
    expect(first.back?.origin).toBe('https://app.novarum.me');

    const res = await exchange(anchor, first.code!, first.verifier);
    expect((await res.json()) as any).toEqual({
      status: 'signup',
      provider: 'Fake IdP',
      username: who.preferred_username,
      displayName: 'Single Sign',
      email: who.email,
    });
    expect(parseSetCookie(res)).toBeUndefined();

    const created = await ssoSignup(anchor, {
      code: first.code!,
      verifier: first.verifier,
      username: who.preferred_username,
      displayName: 'Picked',
    });
    expect(created.status).toBe(200);
    const { user } = (await created.json()) as any;
    expect(user.displayName).toBe('Picked');
    expect(user.email).toBe(who.email);
    const me = await fetch(`${anchor.url}/auth/me`, {
      headers: withCookie(parseSetCookie(created)!),
    });
    expect(((await me.json()) as any).user.email).toBe(who.email);
    expect(await meStatus(anchor.url, parseSetCookie(created)!)).toBe(200);

    const again = await ssoRedirect(anchor, 'idp');
    const login = await exchange(anchor, again.code!, again.verifier);
    expect(login.status).toBe(200);
    const body = (await login.json()) as any;
    expect(body.status).toBe('login');
    expect(body.user.id).toBe(user.id);
    expect(await meStatus(anchor.url, parseSetCookie(login)!)).toBe(200);
  });

  test('an SSO-only account has no password to log in with', async () => {
    const { who } = await signUpVia('idp');
    const res = await post(anchor.url, '/auth/login', {
      username: who.preferred_username,
      password: 'whatever-password',
    });
    expect(res.status).toBe(401);
  });

  test('plain OAuth 2 providers identify users by the configured userinfo field', async () => {
    const { who, user } = await signUpVia('hub');
    expect(user.username).toBe(who.preferred_username);

    idp.as(who);
    const again = await ssoRedirect(anchor, 'hub');
    const body = (await (await exchange(anchor, again.code!, again.verifier)).json()) as any;
    expect(body).toMatchObject({ status: 'login', user: { id: user.id } });

    // the same subject at another provider is a different person
    idp.as({ ...who, email: `other-${who.email}` });
    const other = await ssoRedirect(anchor, 'idp');
    expect(
      ((await (await exchange(anchor, other.code!, other.verifier)).json()) as any).status
    ).toBe('signup');
  });

  test('odd usernames are cleaned up into a suggestion', async () => {
    person({ preferred_username: 'a b!' });
    const { code, verifier } = await ssoRedirect(anchor, 'idp');
    const body = (await (await exchange(anchor, code!, verifier)).json()) as any;
    expect(body).toMatchObject({ status: 'signup', username: 'ab' });
  });

  test('a taken username is refused and the attempt can be retried with another', async () => {
    const taken = await signup(anchor.url);
    const who = person();
    const { code, verifier } = await ssoRedirect(anchor, 'idp');
    const clash = await ssoSignup(anchor, { code: code!, verifier, username: taken.user.username });
    expect(clash.status).toBe(409);
    const ok = await ssoSignup(anchor, { code: code!, verifier, username: who.preferred_username });
    expect(ok.status).toBe(200);
  });
});

describe('an email on file', () => {
  const tryProvider = async (provider: string) => {
    const { code, verifier } = await ssoRedirect(anchor, provider);
    return { code: code!, verifier, res: await exchange(anchor, code!, verifier) };
  };

  test('an unverified email is not enough to sign up, and the attempt is dropped', async () => {
    const who = person({ email_verified: false });
    const { code, verifier, res } = await tryProvider('idp');
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/no verified email/);
    const retry = await ssoSignup(anchor, { code, verifier, username: who.preferred_username });
    expect(retry.status).toBe(401);
  });

  test('no email at all is refused too', async () => {
    person({ email: undefined });
    expect((await tryProvider('idp')).res.status).toBe(403);
  });

  test('trust_email takes the email even when the provider does not verify it', async () => {
    const who = person({ email_verified: false });
    const { res } = await tryProvider('trusting');
    expect((await res.json()) as any).toMatchObject({ status: 'signup', email: who.email });
  });

  test('an OIDC email that is only in the userinfo response is found there', async () => {
    const who = person({ emailInUserinfoOnly: true });
    const { res } = await tryProvider('idp');
    expect((await res.json()) as any).toMatchObject({ status: 'signup', email: who.email });
  });

  test('plain OAuth 2 takes the primary verified address from the emails endpoint', async () => {
    const who = person();
    const { res } = await tryProvider('hub');
    expect((await res.json()) as any).toMatchObject({ status: 'signup', email: who.email });

    // an unverified primary falls back to another verified address
    const other = person({ email_verified: false });
    expect((await (await tryProvider('hub')).res.json()) as any).toMatchObject({
      email: `old-${other.email}`,
    });
  });

  test('without an emails endpoint, a GitHub-like provider gives no email', async () => {
    person();
    expect((await tryProvider('bare')).res.status).toBe(403);
  });

  test('an email that already has an account points to linking instead', async () => {
    const existing = await signup(anchor.url);
    person({ email: existing.email });
    const { code, verifier, res } = await tryProvider('idp');
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/link Fake IdP in Settings/);
    const retry = await ssoSignup(anchor, { code, verifier, username: uniqueName() });
    expect(retry.status).toBe(401);
  });

  test('the email check also holds at signup, for an account made in between', async () => {
    const who = person();
    const { code, verifier, res } = await tryProvider('idp');
    expect(res.status).toBe(200);
    await signup(anchor.url, { email: who.email });
    const late = await ssoSignup(anchor, { code, verifier, username: who.preferred_username });
    expect(late.status).toBe(409);
  });
});

describe('the result can only be redeemed by the app that asked, once', () => {
  test('a wrong verifier is refused', async () => {
    person();
    const { code } = await ssoRedirect(anchor, 'idp');
    expect((await exchange(anchor, code!, 'a'.repeat(24))).status).toBe(401);
    expect(
      (await ssoSignup(anchor, { code: code!, verifier: 'a'.repeat(24), username: 'x_y' })).status
    ).toBe(401);
  });

  test('a login code works once', async () => {
    const { who } = await signUpVia('idp');
    idp.as(who);
    const { code, verifier } = await ssoRedirect(anchor, 'idp');
    expect((await exchange(anchor, code!, verifier)).status).toBe(200);
    expect((await exchange(anchor, code!, verifier)).status).toBe(401);
  });

  test('a signup code works once', async () => {
    const who = person();
    const { code, verifier } = await ssoRedirect(anchor, 'idp');
    const body = { code: code!, verifier, username: who.preferred_username };
    expect((await ssoSignup(anchor, body)).status).toBe(200);
    expect((await ssoSignup(anchor, { ...body, username: uniqueName() })).status).toBe(401);
  });

  test('the callback cannot be replayed, and unknown states are refused', async () => {
    person();
    const { callbackUrl } = await ssoRedirect(anchor, 'idp');
    expect((await fetch(callbackUrl, { redirect: 'manual' })).status).toBe(400);
    const forged = await fetch(`${anchor.url}/auth/sso/callback?state=nope&code=x`, {
      redirect: 'manual',
    });
    expect(forged.status).toBe(400);
  });

  test('a provider refusal goes back to the app as an error', async () => {
    idp.deny();
    const { back, code } = await ssoRedirect(anchor, 'idp');
    expect(code).toBeNull();
    expect(back?.searchParams.get('error')).toBe('The user said no');
  });
});

describe('linking', () => {
  test('a password account links a provider and can then sign in with it', async () => {
    const account = await signup(anchor.url);
    const who = person();
    const { code, verifier } = await ssoRedirect(anchor, 'idp', {
      cookie: account.cookie,
      link: true,
    });
    expect((await (await exchange(anchor, code!, verifier)).json()) as any).toEqual({
      status: 'linked',
      provider: 'idp',
    });

    const listed = await identities(account.cookie);
    expect(listed).toMatchObject({
      hasPassword: true,
      identities: [{ provider: 'idp', name: 'Fake IdP', email: who.email }],
    });

    idp.as(who);
    const login = await ssoRedirect(anchor, 'idp');
    const body = (await (await exchange(anchor, login.code!, login.verifier)).json()) as any;
    expect(body).toMatchObject({ status: 'login', user: { id: account.user.id } });
  });

  test('a provider account already used by someone else cannot be linked', async () => {
    const { who } = await signUpVia('idp');
    const other = await signup(anchor.url);
    idp.as(who);
    const { code, verifier } = await ssoRedirect(anchor, 'idp', {
      cookie: other.cookie,
      link: true,
    });
    expect((await exchange(anchor, code!, verifier)).status).toBe(409);
    expect((await identities(other.cookie)).identities).toEqual([]);
  });

  test('one account per provider', async () => {
    const { cookie } = await signUpVia('idp');
    person();
    const { code, verifier } = await ssoRedirect(anchor, 'idp', { cookie, link: true });
    expect((await exchange(anchor, code!, verifier)).status).toBe(409);
  });

  test('a link result cannot be used to sign up', async () => {
    const account = await signup(anchor.url);
    person();
    const { code, verifier } = await ssoRedirect(anchor, 'idp', {
      cookie: account.cookie,
      link: true,
    });
    const res = await ssoSignup(anchor, { code: code!, verifier, username: uniqueName() });
    expect(res.status).toBe(401);
  });
});

describe('unlinking', () => {
  const unlink = (cookie: string, provider: string) =>
    fetch(`${anchor.url}/auth/sso/identities/${provider}`, {
      method: 'DELETE',
      headers: withCookie(cookie),
    });

  test('the only way into an account cannot be removed', async () => {
    const { cookie } = await signUpVia('idp');
    expect((await unlink(cookie, 'idp')).status).toBe(409);
    expect((await unlink(cookie, 'hub')).status).toBe(404);
  });

  test('with another way in, a provider can be unlinked and stops working', async () => {
    const { who, cookie } = await signUpVia('idp');
    person();
    const link = await ssoRedirect(anchor, 'hub', { cookie, link: true });
    expect((await exchange(anchor, link.code!, link.verifier)).status).toBe(200);

    expect((await unlink(cookie, 'idp')).status).toBe(200);
    expect((await identities(cookie)).identities.map((i: any) => i.provider)).toEqual(['hub']);

    // no longer a way in; its email is this account's, so it is pointed back to linking
    idp.as(who);
    const login = await ssoRedirect(anchor, 'idp');
    expect((await exchange(anchor, login.code!, login.verifier)).status).toBe(409);
  });

  test('unlinking both providers at once leaves one of them', async () => {
    const { cookie } = await signUpVia('idp');
    person();
    const link = await ssoRedirect(anchor, 'hub', { cookie, link: true });
    expect((await exchange(anchor, link.code!, link.verifier)).status).toBe(200);

    const results = await Promise.all([unlink(cookie, 'idp'), unlink(cookie, 'hub')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await identities(cookie)).identities).toHaveLength(1);
  });

  test("one user cannot see or unlink another user's providers", async () => {
    const { cookie: victim } = await signUpVia('idp');
    const attacker = await signup(anchor.url);
    expect((await identities(attacker.cookie)).identities).toEqual([]);
    expect((await unlink(attacker.cookie, 'idp')).status).toBe(404);
    expect((await identities(victim)).identities).toHaveLength(1);
  });
});

describe('moving a password account to single sign-on', () => {
  const removePassword = (cookie: string, password: string) =>
    fetch(`${anchor.url}/auth/password`, {
      method: 'DELETE',
      headers: withCookie(cookie, {
        'content-type': 'application/json',
        'x-forwarded-for': freshIp(),
      }),
      body: JSON.stringify({ password }),
    });
  const unlink = (cookie: string, provider: string) =>
    fetch(`${anchor.url}/auth/sso/identities/${provider}`, {
      method: 'DELETE',
      headers: withCookie(cookie),
    });
  const login = (username: string, password: string) =>
    post(anchor.url, '/auth/login', { username, password });
  const linkIdp = async (cookie: string) => {
    const who = person();
    const { code, verifier } = await ssoRedirect(anchor, 'idp', { cookie, link: true });
    expect((await exchange(anchor, code!, verifier)).status).toBe(200);
    return who;
  };

  test('link, drop the password, sign in with the provider, get a password back by reset', async () => {
    const account = await signup(anchor.url);
    const who = await linkIdp(account.cookie);
    const mfa = await post(
      anchor.url,
      '/auth/mfa/email/toggle',
      { password: account.password, enable: true },
      withCookie(account.cookie)
    );
    expect(mfa.status).toBe(200);

    expect((await removePassword(account.cookie, 'not-the-password')).status).toBe(401);
    expect((await removePassword(account.cookie, account.password)).status).toBe(200);

    expect((await login(account.user.username, account.password)).status).toBe(401);
    expect(await identities(account.cookie)).toMatchObject({ hasPassword: false });
    const mfaNow = await fetch(`${anchor.url}/auth/mfa`, { headers: withCookie(account.cookie) });
    expect(((await mfaNow.json()) as any).mfaOptions).toEqual([]);
    // the provider is now the only way in, so it stays
    expect((await unlink(account.cookie, 'idp')).status).toBe(409);

    idp.as(who);
    const sso = await ssoRedirect(anchor, 'idp');
    const body = (await (await exchange(anchor, sso.code!, sso.verifier)).json()) as any;
    expect(body).toMatchObject({
      status: 'login',
      user: { id: account.user.id, email: account.email },
    });

    // the email on file still resets the password
    const since = Date.now() - 1000;
    expect(
      (await post(anchor.url, '/auth/password-reset/request', { email: account.email })).status
    ).toBe(200);
    const code = await latestOtpFor(account.email, { since });
    const reset = await post(anchor.url, '/auth/reset-password', {
      email: account.email,
      newPassword: 'a-brand-new-password',
      verificationCode: Number(code),
    });
    expect(reset.status).toBe(200);
    expect((await login(account.user.username, 'a-brand-new-password')).status).toBe(200);
  });

  test('the password stays until a provider is linked', async () => {
    const account = await signup(anchor.url);
    expect((await removePassword(account.cookie, account.password)).status).toBe(409);
    expect((await login(account.user.username, account.password)).status).toBe(200);
  });

  test('an account without a password has nothing to remove', async () => {
    const { cookie } = await signUpVia('idp');
    expect((await removePassword(cookie, 'anything-at-all')).status).toBe(401);
  });

  test('dropping the password and unlinking at once never locks the account', async () => {
    const account = await signup(anchor.url);
    await linkIdp(account.cookie);
    await Promise.all([
      removePassword(account.cookie, account.password),
      unlink(account.cookie, 'idp'),
    ]);
    const after = (await identities(account.cookie)) as any;
    expect(after.hasPassword || after.identities.length > 0).toBe(true);
  });

  test('needs a session', async () => {
    const res = await fetch(`${anchor.url}/auth/password`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});
