import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { post, withCookie } from './http';
import type { RunningAnchor } from './anchor';

export type IdpUser = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
};

/**
 * A fake identity provider on 127.0.0.1: OpenID Connect (discovery, id tokens) plus a GitHub-like
 * plain OAuth 2 userinfo endpoint. `as(user)` picks who the next sign-in is; `deny()` makes it refuse.
 */
export async function startIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { user: IdpUser; nonce?: string; challenge: string }>();
  const tokens = new Map<string, IdpUser>();
  let next: IdpUser = { sub: 'nobody' };
  let refuse = false;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const issuer: string = `http://127.0.0.1:${server.port}`;
      switch (url.pathname) {
        case '/.well-known/openid-configuration':
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/user`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
          });
        case '/jwks':
          return Response.json({ keys: [jwk] });
        case '/authorize': {
          const back = new URL(url.searchParams.get('redirect_uri')!);
          back.searchParams.set('state', url.searchParams.get('state')!);
          if (refuse) {
            back.searchParams.set('error', 'access_denied');
            back.searchParams.set('error_description', 'The user said no');
          } else {
            const code = crypto.randomUUID();
            codes.set(code, {
              user: next,
              nonce: url.searchParams.get('nonce') ?? undefined,
              challenge: url.searchParams.get('code_challenge')!,
            });
            back.searchParams.set('code', code);
          }
          return Response.redirect(back.href, 302);
        }
        case '/token': {
          const form = await request.formData();
          const grant = codes.get(String(form.get('code')));
          codes.delete(String(form.get('code')));
          const verifier = new TextEncoder().encode(String(form.get('code_verifier')));
          const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', verifier)).toString(
            'base64url'
          );
          const basic = request.headers.get('authorization')?.split(' ')[1];
          const secret = form.get('client_secret') ?? atob(basic ?? '').split(':')[1];
          if (!grant || grant.challenge !== challenge || secret !== 'secret') {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          const accessToken = crypto.randomUUID();
          tokens.set(accessToken, grant.user);
          const idToken = await new SignJWT({ ...grant.user, nonce: grant.nonce })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(issuer)
            .setAudience(String(form.get('client_id')))
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          return Response.json({
            access_token: accessToken,
            token_type: 'bearer',
            ...(grant.nonce && { id_token: idToken }),
          });
        }
        case '/user': {
          const user = tokens.get(request.headers.get('authorization')?.split(' ')[1] ?? '');
          if (!user) return new Response(null, { status: 401 });
          // shaped like GitHub's GET /user: a numeric id and a login instead of sub/preferred_username
          return Response.json({
            id: Number(user.sub),
            login: user.preferred_username,
            name: user.name ?? null,
            email: user.email ?? null,
          });
        }
      }
      return new Response(null, { status: 404 });
    },
  });

  const issuer = `http://127.0.0.1:${server.port}`;
  return {
    issuer,
    /** anchor config.toml providers: an OpenID Connect one and a plain OAuth 2 one */
    providers: {
      idp: { name: 'Fake IdP', issuer, client_id: 'anchor', client_secret: 'secret' },
      hub: {
        name: 'FakeHub',
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/user`,
        client_id: 'anchor',
        client_secret: 'secret',
      },
    },
    as(user: IdpUser) {
      next = user;
      refuse = false;
    },
    deny() {
      refuse = true;
    },
    stop: () => server.stop(true),
  };
}

export const appRedirect = 'https://app.novarum.me/sso';

/**
 * Runs a sign-on through the browser part: authorize, the provider, anchor's callback.
 * Returns where anchor sent the browser back to, plus the verifier only the app knows.
 */
export async function ssoRedirect(
  anchor: RunningAnchor,
  provider: string,
  options: { cookie?: string; link?: boolean; redirectUri?: string } = {}
) {
  const authorize = await post(
    anchor.url,
    '/auth/sso/authorize',
    { provider, redirectUri: options.redirectUri ?? appRedirect, link: options.link },
    options.cookie ? withCookie(options.cookie) : {}
  );
  if (!authorize.ok) throw new Error(`authorize: ${authorize.status} ${await authorize.text()}`);
  const { url, verifier } = (await authorize.json()) as { url: string; verifier: string };

  const atIdp = await fetch(url, { redirect: 'manual' });
  const callback = new URL(atIdp.headers.get('location')!);
  const callbackUrl = `${anchor.url}${callback.pathname}${callback.search}`;
  const atAnchor = await fetch(callbackUrl, { redirect: 'manual' });
  const location = atAnchor.headers.get('location');
  return {
    status: atAnchor.status,
    back: location ? new URL(location) : null,
    code: location ? new URL(location).searchParams.get('code') : null,
    verifier,
    callbackUrl,
  };
}

export const exchange = (anchor: RunningAnchor, code: string, verifier: string) =>
  post(anchor.url, '/auth/sso/exchange', { code, verifier });

export const ssoSignup = (
  anchor: RunningAnchor,
  body: { code: string; verifier: string; username: string; displayName?: string }
) => post(anchor.url, '/auth/sso/signup', body);
