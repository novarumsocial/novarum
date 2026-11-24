import Elysia, { t } from 'elysia';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db, ssoFlows, ssoIdentities, users } from '../../src/db';
import { getConfig } from '../../utils/config';
import { randomString } from '../../utils/randomString';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import {
  createSession,
  createSessionCookie,
  sessionCookieName,
  validateSessionToken,
} from './provider';
import { authRateLimit, userPayloadResponseSchema, userResponse } from './services';

type Provider = ReturnType<typeof getConfig>['auth']['providers'][string];

const callbackUrl = () => `${getConfig().server.base_url}/auth/sso/callback`;
const isOidc = (provider: Provider) => 'issuer' in provider;

const configurations = new Map<string, Promise<oidc.Configuration>>();

// discovery is cached per provider; a failed one is retried on the next sign-in
function configuration(id: string, provider: Provider) {
  const key = JSON.stringify([id, provider]);
  let configuration = configurations.get(key);
  if (!configuration) {
    const insecure = { execute: [oidc.allowInsecureRequests] };
    const allowHttp = (url: string) => (url.startsWith('http://') ? insecure : undefined);
    configuration =
      'issuer' in provider
        ? oidc.discovery(
            new URL(provider.issuer),
            provider.client_id,
            provider.client_secret,
            undefined,
            allowHttp(provider.issuer)
          )
        : Promise.resolve(
            new oidc.Configuration(
              {
                issuer: new URL(provider.authorization_endpoint).origin,
                authorization_endpoint: provider.authorization_endpoint,
                token_endpoint: provider.token_endpoint,
                userinfo_endpoint: provider.userinfo_endpoint,
              },
              provider.client_id,
              provider.client_secret
            )
          ).then((config) => {
            if (allowHttp(provider.token_endpoint)) oidc.allowInsecureRequests(config);
            return config;
          });
    configurations.set(key, configuration);
    configuration.catch(() => configurations.delete(key));
  }
  return configuration;
}

const profileSchema = z.looseObject({
  sub: z.union([z.string(), z.number()]).optional(),
  email: z.string().nullish(),
  email_verified: z.boolean().optional(),
  name: z.string().nullish(),
  preferred_username: z.string().nullish(),
});

/** who the provider says signed in */
async function identify(provider: Provider, config: oidc.Configuration, url: URL, flow: Flow) {
  const tokens = await oidc.authorizationCodeGrant(config, url, {
    pkceCodeVerifier: flow.pkceVerifier,
    expectedState: flow.id,
    ...(isOidc(provider) && { expectedNonce: flow.nonce, idTokenExpected: true }),
  });

  if ('issuer' in provider) {
    const claims = profileSchema.parse(tokens.claims());
    return {
      subject: String(claims.sub),
      email: claims.email_verified === false ? null : (claims.email ?? null),
      username: claims.preferred_username ?? claims.email?.split('@')[0] ?? null,
      displayName: claims.name ?? null,
    };
  }

  const response = await oidc.fetchProtectedResource(
    config,
    tokens.access_token,
    new URL(provider.userinfo_endpoint),
    'GET'
  );
  const profile = z.record(z.string(), z.unknown()).parse(await response.json());
  const field = (name: string) => z.union([z.string(), z.number()]).nullish().parse(profile[name]);
  const subject = field(provider.subject_field);
  if (subject == null || subject === '') throw new Error('the provider returned no user id');
  const { email, name } = profileSchema.parse(profile);
  return {
    subject: String(subject),
    email: email ?? null,
    username: field(provider.username_field)?.toString() ?? null,
    displayName: name ?? null,
  };
}

type Flow = typeof ssoFlows.$inferSelect;

/** a prefix of an allowed client origin, cut at a path boundary so https://a.b doesn't allow https://a.b.evil */
function allowedRedirect(redirectUri: string) {
  return getConfig().auth.client_origins.some((origin) => {
    const prefix = origin.endsWith('/') ? origin : `${origin}/`;
    return redirectUri === origin || redirectUri.startsWith(prefix);
  });
}

function redirectWith(redirectUri: string, params: Record<string, string>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url.href, 302);
}

const suggestUsername = (username: string | null) =>
  username
    ?.replace(/[^a-zA-Z0-9._]/g, '')
    .slice(0, 32)
    .padEnd(2, '_') ?? null;

const pendingFlow = (code: string, verifier: string) =>
  db.query.ssoFlows.findFirst({
    where: { code, verifier, expiresAt: { gt: new Date() } },
  });

const sessionUser = (cookie: Record<string, { value?: unknown }>) =>
  validateSessionToken(cookie[sessionCookieName]?.value as string | undefined);

async function signIn(cookie: Record<string, { set: (value: object) => unknown }>, userId: string) {
  const session = await createSession(userId);
  const sessionCookie = createSessionCookie(session.token);
  cookie[sessionCookie.name]!.set({ value: sessionCookie.value, ...sessionCookie.attributes });
}

const userNameSchema = t.String({ minLength: 2, maxLength: 32, pattern: '^[a-zA-Z0-9._]+$' });
const flowSecrets = {
  code: t.String({ minLength: 24, maxLength: 24 }),
  verifier: t.String({ minLength: 24, maxLength: 24 }),
};

export const sso = new Elysia({ prefix: '/auth/sso', tags: ['Auth'] })
  .use(authRateLimit('/sso/authorize', 20, 60_000))
  .use(authRateLimit('/sso/exchange', 20, 60_000))
  .use(authRateLimit('/sso/signup', 5, 60 * 60_000))
  .post(
    '/authorize',
    async ({ body, cookie, status }) => {
      const provider = getConfig().auth.providers[body.provider];
      if (!provider) return status(404, { error: 'Unknown sign-on provider' });
      if (!allowedRedirect(body.redirectUri)) {
        return status(400, { error: 'This app is not allowed to use single sign-on here' });
      }

      const session = body.link ? await sessionUser(cookie) : null;
      if (body.link && !session) return status(401, { error: 'Unauthorized' });

      const config = await configuration(body.provider, provider).catch(() => null);
      if (!config) return status(502, { error: 'Could not reach the sign-on provider' });

      await db.delete(ssoFlows).where(lt(ssoFlows.expiresAt, new Date()));
      const [flow] = await db
        .insert(ssoFlows)
        .values({
          id: randomString(),
          provider: body.provider,
          pkceVerifier: oidc.randomPKCECodeVerifier(),
          nonce: oidc.randomNonce(),
          redirectUri: body.redirectUri,
          verifier: randomString(),
          linkUserId: session?.userId ?? null,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        })
        .returning();

      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callbackUrl(),
        scope: provider.scopes.join(' '),
        state: flow!.id,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow!.pkceVerifier),
        code_challenge_method: 'S256',
        ...(isOidc(provider) && { nonce: flow!.nonce }),
      });

      // the verifier never travels through a URL: only the app that asked can redeem the result
      return { url: url.href, verifier: flow!.verifier };
    },
    {
      body: t.Object({
        provider: t.String({ maxLength: 32 }),
        redirectUri: t.String({ maxLength: 512 }),
        link: t.Optional(t.Boolean()),
      }),
      response: {
        200: z.object({ url: z.url(), verifier: z.string() }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/callback',
    async ({ query, request, status }) => {
      const flow = await db.query.ssoFlows.findFirst({
        where: { id: query.state ?? '', code: { isNull: true }, expiresAt: { gt: new Date() } },
      });
      const provider = flow && getConfig().auth.providers[flow.provider];
      if (!flow || !provider) {
        return status(400, 'This sign-in attempt has expired. Go back to the app and try again.');
      }

      const fail = async (error: string) => {
        await db.delete(ssoFlows).where(eq(ssoFlows.id, flow.id));
        return redirectWith(flow.redirectUri, { error });
      };
      if (query.error) return fail(query.error_description ?? query.error);

      const identity = await configuration(flow.provider, provider)
        .then((config) =>
          identify(provider, config, new URL(callbackUrl() + new URL(request.url).search), flow)
        )
        .catch(() => null);
      if (!identity) return fail('The sign-on provider did not confirm who you are.');

      const [claimed] = await db
        .update(ssoFlows)
        .set({
          ...identity,
          username: suggestUsername(identity.username),
          code: randomString(),
          expiresAt: new Date(Date.now() + 10 * 60_000),
        })
        .where(and(eq(ssoFlows.id, flow.id), isNull(ssoFlows.code)))
        .returning();
      if (!claimed) return status(400, 'This sign-in attempt was already used.');

      return redirectWith(flow.redirectUri, { code: claimed.code! });
    },
    {
      query: t.Object({
        state: t.Optional(t.String()),
        code: t.Optional(t.String()),
        error: t.Optional(t.String()),
        error_description: t.Optional(t.String()),
      }),
      response: { 400: z.string() },
    }
  )
  .post(
    '/exchange',
    async ({ body, cookie, status }) => {
      const flow = await pendingFlow(body.code, body.verifier);
      if (!flow?.subject) return status(401, { error: 'This sign-in attempt has expired' });
      const name = getConfig().auth.providers[flow.provider]?.name ?? flow.provider;

      if (flow.linkUserId) {
        await db.delete(ssoFlows).where(eq(ssoFlows.id, flow.id));
        const [linked] = await db
          .insert(ssoIdentities)
          .values({
            provider: flow.provider,
            subject: flow.subject,
            userId: flow.linkUserId,
            email: flow.email,
          })
          .onConflictDoNothing()
          .returning();
        if (!linked) {
          return status(409, {
            error: `That ${name} account is already linked, or this account already has one`,
          });
        }
        return { status: 'linked' as const, provider: flow.provider };
      }

      const identity = await db.query.ssoIdentities.findFirst({
        where: { provider: flow.provider, subject: flow.subject },
        with: { user: { with: { localCredential: true } } },
      });
      if (identity) {
        await db.delete(ssoFlows).where(eq(ssoFlows.id, flow.id));
        await signIn(cookie, identity.userId);
        return {
          status: 'login' as const,
          user: userResponse(identity.user, identity.user.localCredential?.email ?? null),
        };
      }

      return {
        status: 'signup' as const,
        provider: name,
        username: flow.username,
        displayName: flow.displayName,
        email: flow.email,
      };
    },
    {
      body: t.Object(flowSecrets),
      response: {
        200: z.discriminatedUnion('status', [
          z.object({ status: z.literal('linked'), provider: z.string() }),
          userPayloadResponseSchema.extend({ status: z.literal('login') }),
          z.object({
            status: z.literal('signup'),
            provider: z.string(),
            username: z.string().nullable(),
            displayName: z.string().nullable(),
            email: z.string().nullable(),
          }),
        ]),
        401: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/signup',
    async ({ body, cookie, status }) => {
      const flow = await pendingFlow(body.code, body.verifier);
      if (!flow?.subject || flow.linkUserId) {
        return status(401, { error: 'This sign-in attempt has expired' });
      }

      const homeserver = getConfig().server.homeserver;
      const taken = await db.query.users.findFirst({
        where: { username: body.username, homeserver },
      });
      if (taken) return status(409, { error: 'Username is already taken' });

      const user = await db
        .transaction(async (tx) => {
          const [consumed] = await tx
            .delete(ssoFlows)
            .where(and(eq(ssoFlows.id, flow.id), gt(ssoFlows.expiresAt, new Date())))
            .returning();
          if (!consumed) return null;

          const now = new Date();
          const [user] = await tx
            .insert(users)
            .values({
              id: randomString(),
              username: body.username,
              homeserver,
              displayName: body.displayName || null,
              isBot: false,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          const [identity] = await tx
            .insert(ssoIdentities)
            .values({
              provider: flow.provider,
              subject: flow.subject!,
              userId: user!.id,
              email: flow.email,
            })
            .onConflictDoNothing()
            .returning();
          if (!identity) tx.rollback();
          return user!;
        })
        .catch(() => null);
      if (!user)
        return status(409, { error: 'This account was already created. Sign in instead.' });

      await signIn(cookie, user.id);
      return { user: userResponse(user) };
    },
    {
      body: t.Object({
        ...flowSecrets,
        username: userNameSchema,
        displayName: t.Optional(t.String({ maxLength: 64 })),
      }),
      response: {
        200: userPayloadResponseSchema,
        401: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/identities',
    async ({ cookie, status }) => {
      const session = await sessionUser(cookie);
      if (!session) return status(401, { error: 'Unauthorized' });

      const [identities, credential] = await Promise.all([
        db.query.ssoIdentities.findMany({ where: { userId: session.userId } }),
        db.query.localCredentials.findFirst({ where: { userId: session.userId } }),
      ]);
      const providers = getConfig().auth.providers;
      return {
        hasPassword: Boolean(credential),
        identities: identities.map((identity) => ({
          provider: identity.provider,
          name: providers[identity.provider]?.name ?? identity.provider,
          email: identity.email,
          createdAt: identity.createdAt,
        })),
      };
    },
    {
      response: {
        200: z.object({
          hasPassword: z.boolean(),
          identities: z.array(
            z.object({
              provider: z.string(),
              name: z.string(),
              email: z.string().nullable(),
              createdAt: z.date(),
            })
          ),
        }),
        401: genericResponseErrorSchema,
      },
    }
  )
  .delete(
    '/identities/:provider',
    async ({ cookie, params, status }) => {
      const session = await sessionUser(cookie);
      if (!session) return status(401, { error: 'Unauthorized' });

      // the user row lock keeps two unlinks from each leaving the other as the last way in
      const error = await db.transaction(async (tx) => {
        await tx.select().from(users).where(eq(users.id, session.userId)).for('update');
        const [identities, credential] = await Promise.all([
          tx.query.ssoIdentities.findMany({ where: { userId: session.userId } }),
          tx.query.localCredentials.findFirst({ where: { userId: session.userId } }),
        ]);
        if (!identities.some((identity) => identity.provider === params.provider)) return 404;
        if (!credential && identities.length === 1) return 409;

        await tx
          .delete(ssoIdentities)
          .where(
            and(
              eq(ssoIdentities.userId, session.userId),
              eq(ssoIdentities.provider, params.provider)
            )
          );
      });
      if (error === 404) return status(404, { error: 'That provider is not linked' });
      if (error === 409) {
        return status(409, { error: 'This is the only way to sign in to this account' });
      }
      return { success: true };
    },
    {
      params: t.Object({ provider: t.String({ maxLength: 32 }) }),
      response: {
        200: z.object({ success: z.boolean() }),
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  );
