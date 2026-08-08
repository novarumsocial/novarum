import Elysia, { t } from 'elysia';
import { randomString } from '../../utils/randomString';
import {
  createBlankSessionCookie,
  createSession,
  createSessionCookie,
  deleteSessionToken,
  sessionCookieName,
  validateSessionToken,
} from './provider';
import { getConfig } from '../../utils/config';
import { db, emailOtps, localCredentials, users } from '../../src/db';
import { publicUser, publicUserSchema } from '../../utils/publicUser';
import { z } from 'zod';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import OTPEmail from '../../src/emails/otp';
import { transporter } from '../../utils/services/email';
import { createHmac, randomInt } from 'node:crypto';
import { render } from 'react-email';
import { rateLimit } from 'elysia-rate-limit';
import { createTOTPKeyURI, decodeBase32, encodeBase32, generateRandomKey, verifyTOTPWithGracePeriod } from '../../utils/otp';

const authRateLimit = (path: string, max: number, duration: number) =>
  rateLimit({
    scoping: 'scoped',
    max,
    duration,
    countFailedRequest: true,
    skip: (request) =>
      request.method !== 'POST' || new URL(request.url).pathname !== `/auth${path}`,
    errorResponse: new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }),
    generator: (_req, _serv, { ip }) => ip,
  });

export const userResponseSchema = publicUserSchema.omit({ userId: true }).extend({
  id: publicUserSchema.shape.userId,
  handle: z.string(),
  email: z.string().nullable(),
});
const userPayloadResponseSchema = z.object({ user: userResponseSchema });
const mfaMethodSchema = z.enum(['EMAIL', 'TOTP']);
const mfaChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  challenge: z.string(),
  methods: z.array(mfaMethodSchema),
});

export const auth = new Elysia({ prefix: '/auth', tags: ['Auth'] })
  .use(authRateLimit('/login', 10, 60_000)) // 10 requests per minute
  .use(authRateLimit('/login/mfa', 10, 60_000))
  .use(authRateLimit('/login/mfa/email', 3, 15 * 60_000))
  .use(authRateLimit('/signup', 5, 60 * 60_000)) // 3 requests per hour
  .use(authRateLimit('/reset-password', 5, 15 * 60_000)) // 5 requests per 15 minutes
  .use(authRateLimit('/password-reset/request', 3, 15 * 60_000)) // 3 requests per 15 minutes
  .post(
    '/signup',
    async ({ body, cookie, status }) => {
      const { username, displayName, email, password } = body;
      const homeserver = getConfig().server.homeserver;
      const now = new Date();

      const existingCredential = await db.query.localCredentials.findFirst({
        where: {
          email,
        },
      });
      if (existingCredential) {
        return status(409, { error: 'User with this email already exists' });
      }

      const existingUsername = await db.query.users.findFirst({
        where: {
          username,
          homeserver,
        },
      });
      if (existingUsername) {
        return status(409, { error: 'Username is already taken' });
      }

      const [user] = await db
        .insert(users)
        .values({
          id: randomString(),
          username,
          homeserver,
          displayName: displayName || null,
          avatarUrl: null,
          isBot: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!user) {
        return status(500, { error: 'Failed to create user' });
      }

      await db.insert(localCredentials).values({
        userId: user.id,
        email,
        passwordHash: await Bun.password.hash(password),
      });

      const session = await createSession(user.id);
      const sessionCookie = createSessionCookie(session.token);

      cookie[sessionCookie.name]!.set({
        value: sessionCookie.value,
        ...sessionCookie.attributes,
      });

      return {
        user: userResponse(user, email),
      };
    },
    {
      body: t.Object({
        username: t.String({ minLength: 2, maxLength: 32, pattern: '^[a-zA-Z0-9._]+$' }),
        displayName: t.Optional(t.String({ maxLength: 64 })),
        email: t.String({ type: 'email' }),
        password: t.String({ minLength: 8 }),
      }),
      response: {
        200: userPayloadResponseSchema,
        409: genericResponseErrorSchema,
        500: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/login',
    async ({ body, cookie, status }) => {
      const { username, password } = body;
      const homeserver = getConfig().server.homeserver;

      const user = await db.query.users.findFirst({
        where: {
          username,
          homeserver,
        },
      });
      if (!user) {
        return status(401, { error: 'Invalid username or password' });
      }

      const credential = await db.query.localCredentials.findFirst({
        where: {
          userId: user.id,
        },
      });
      if (!credential) {
        return status(401, { error: 'Invalid username or password' });
      }

      const validPassword = await Bun.password.verify(password, credential.passwordHash);
      if (!validPassword) {
        return status(401, { error: 'Invalid username or password' });
      }

      const methods = (['EMAIL', 'TOTP'] as const).filter((method) =>
        credential.mfaOptions.includes(method)
      );
      if (methods.length) {
        const challenge = randomString();

        await db.insert(emailOtps).values({
          id: challenge,
          email: credential.email,
          otp: randomString(),
          intent: 'MFA_LOGIN',
          expiresAt: new Date(Date.now() + 10 * 60_000),
        });

        return status(202, { mfaRequired: true, challenge, methods });
      }

      const session = await createSession(user.id);
      const sessionCookie = createSessionCookie(session.token);

      cookie[sessionCookie.name]!.set({
        value: sessionCookie.value,
        ...sessionCookie.attributes,
      });

      return {
        user: userResponse(user, credential.email),
      };
    },
    {
      body: t.Object({
        username: t.String({ minLength: 2, maxLength: 32, pattern: '^[a-zA-Z0-9._]+$' }),
        password: t.String({ minLength: 8 }),
      }),
      response: {
        200: userPayloadResponseSchema,
        202: mfaChallengeResponseSchema,
        401: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/login/mfa/email',
    async ({ body, status }) => {
      const pendingChallenge = await db.query.emailOtps.findFirst({
        where: {
          id: body.challenge,
          intent: 'MFA_LOGIN',
          expiresAt: { gte: new Date() },
        },
      });
      if (!pendingChallenge) {
        return status(401, { error: 'This verification request has expired. Sign in again.' });
      }

      const credential = await db.query.localCredentials.findFirst({
        where: { email: pendingChallenge.email },
      });
      if (!credential?.mfaOptions.includes('EMAIL')) {
        return status(401, { error: 'Invalid verification request' });
      }

      const otp = randomInt(100000, 1000000);
      const [updated] = await db
        .update(emailOtps)
        .set({ otp: hashOtp(otp), expiresAt: new Date(Date.now() + 10 * 60_000) })
        .where(
          and(
            eq(emailOtps.id, body.challenge),
            eq(emailOtps.intent, 'MFA_LOGIN'),
            gt(emailOtps.expiresAt, new Date())
          )
        )
        .returning({ id: emailOtps.id });
      if (!updated) {
        return status(401, { error: 'This verification request has expired. Sign in again.' });
      }

      const html = await render(<OTPEmail otp={otp} intent="login" />);
      await transporter.sendMail({
        from: getConfig().email.from_email,
        to: credential.email,
        subject: '(novarum) sign-in verification code',
        html,
      });

      return { success: true, message: 'Verification code sent' };
    },
    {
      body: t.Object({
        challenge: t.String({ minLength: 24, maxLength: 24 }),
      }),
      response: {
        200: z.object({ success: z.boolean(), message: z.string() }),
        401: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/login/mfa',
    async ({ body, cookie, status }) => {
      const pendingChallenge = await db.query.emailOtps.findFirst({
        where: {
          id: body.challenge,
          intent: 'MFA_LOGIN',
          expiresAt: { gte: new Date() },
        },
      });
      if (!pendingChallenge) {
        return status(401, { error: 'This verification request has expired. Sign in again.' });
      }

      const credential = await db.query.localCredentials.findFirst({
        where: { email: pendingChallenge.email },
      });
      if (!credential || !credential.mfaOptions.includes(body.method)) {
        return status(401, { error: 'Invalid verification request' });
      }

      const validCode =
        body.method === 'EMAIL'
          ? hashOtp(Number(body.code)) === pendingChallenge.otp
          : Boolean(
              credential.totpSecret &&
              verifyTOTPWithGracePeriod(
                decodeBase32(Buffer.from(credential.totpSecret).toString()),
                30,
                6,
                body.code,
                30
              )
            );
      if (!validCode) {
        return status(401, { error: 'Invalid verification code' });
      }

      const [consumed] = await db
        .delete(emailOtps)
        .where(
          and(
            eq(emailOtps.id, body.challenge),
            eq(emailOtps.intent, 'MFA_LOGIN'),
            gt(emailOtps.expiresAt, new Date())
          )
        )
        .returning({ id: emailOtps.id });
      if (!consumed) {
        return status(401, { error: 'This verification request has expired. Sign in again.' });
      }

      const user = await db.query.users.findFirst({ where: { id: credential.userId } });
      if (!user) {
        return status(401, { error: 'Invalid verification request' });
      }

      const session = await createSession(user.id);
      const sessionCookie = createSessionCookie(session.token);
      cookie[sessionCookie.name]!.set({
        value: sessionCookie.value,
        ...sessionCookie.attributes,
      });

      return { user: userResponse(user, credential.email) };
    },
    {
      body: t.Object({
        challenge: t.String({ minLength: 24, maxLength: 24 }),
        method: t.Union([t.Literal('EMAIL'), t.Literal('TOTP')]),
        code: t.String({ pattern: '^[0-9]{6}$' }),
      }),
      response: {
        200: userPayloadResponseSchema,
        401: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/logout',
    async ({ cookie }) => {
      const sessionCookie = cookie[sessionCookieName]?.value as string | undefined;
      if (sessionCookie) {
        await deleteSessionToken(sessionCookie);
      }

      const blankCookie = createBlankSessionCookie();
      cookie[sessionCookieName]!.set({
        value: blankCookie.value,
        ...blankCookie.attributes,
      });

      return { success: true, message: 'Logged out successfully' };
    },
    {
      response: {
        200: z.object({
          success: z.boolean(),
          message: z.string(),
        }),
      },
    }
  )
  .get(
    '/me',
    async ({ cookie, status }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      if (!token) {
        return status(401, { user: null });
      }

      const session = await validateSessionToken(token);
      if (!session) {
        const blankCookie = createBlankSessionCookie();

        cookie[blankCookie.name]!.set({
          value: blankCookie.value,
          ...blankCookie.attributes,
        });

        return status(401, { user: null });
      }

      const user = await db.query.users.findFirst({
        where: {
          id: session.userId,
        },
      });
      if (!user) {
        return status(401, { user: null });
      }

      const credential = await db.query.localCredentials.findFirst({
        where: {
          userId: user.id,
        },
      });

      return {
        user: userResponse(user, credential?.email ?? null),
      };
    },
    {
      response: {
        200: userPayloadResponseSchema,
        401: z.object({ user: z.null() }),
      },
    }
  )
  .post(
    '/reset-password',
    async ({ body, status }) => {
      const { email, newPassword, verificationCode } = body;

      const hashedCode = hashOtp(verificationCode);
      const otp = await db.query.emailOtps.findFirst({
        where: {
          email,
          intent: 'PASSWORD_RESET',
          otp: hashedCode,
          expiresAt: { gte: new Date() },
        },
      });
      if (!otp) {
        return status(400, { error: 'Invalid or expired verification code' });
      }

      const credential = await db.query.localCredentials.findFirst({
        where: {
          email,
        },
      });
      if (!credential) {
        return status(404, { error: 'User not found' });
      }

      const passwordHash = await Bun.password.hash(newPassword);

      await db
        .update(localCredentials)
        .set({ passwordHash })
        .where(eq(localCredentials.userId, credential.userId));

      return { success: true, message: 'Password reset successfully' };
    },
    {
      body: t.Object({
        email: t.String({ type: 'email' }),
        newPassword: t.String({ minLength: 8 }),
        verificationCode: t.Number({ minLength: 6, maxLength: 6 }),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          message: z.string(),
        }),
        400: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/password-reset/request',
    async ({ body }) => {
      const startedAt = Date.now();
      const email = body.email.trim().toLowerCase();

      const userCredential = await db.query.localCredentials.findFirst({
        where: { email },
      });

      if (userCredential) {
        const otp = randomInt(100000, 1000000);
        const hashedOtp = hashOtp(otp);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await db.insert(emailOtps).values({
          id: randomString(),
          email,
          expiresAt,
          otp: hashedOtp,
          intent: 'PASSWORD_RESET',
        });

        const html = await render(<OTPEmail otp={otp} intent="reset-password" />);

        await transporter.sendMail({
          from: getConfig().email.from_email,
          to: email,
          subject: '(novarum) password reset request',
          html,
        });
      }

      // prevents timing attacks by waiting a bit
      const minimumDuration = 500;
      const remaining = minimumDuration - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }

      return {
        success: true,
        message: 'Sent successfully if a user exists',
      };
    },
    {
      body: t.Object({
        email: t.String({ type: 'email' }),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          message: z.string(),
        }),
      },
    }
  ).get('/mfa/totp/qr', async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }

    const localCredentials = await db.query.localCredentials.findFirst({
      where: {
        userId: session.userId,
      },
    });
    if (!localCredentials) {
      return status(404, { error: 'User not found' });
    }

    if (localCredentials.totpSecret) {
      return status(400, { error: 'TOTP is already enabled for this user' });
    }

    const key = generateRandomKey(20);
    const gen = createTOTPKeyURI('Novarum', localCredentials.email, key, 30, 6)
    return {
      uri: gen,
      secret: encodeBase32(key),
    }
  }).post('/mfa/totp/enable', async ({ cookie, body, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }

    const localCreds = await db.query.localCredentials.findFirst({
      where: {
        userId: session.userId,
      },
    });
    if (!localCreds) {
      return status(404, { error: 'User not found' });
    }

    if (localCreds.totpSecret) {
      return status(400, { error: 'TOTP is already enabled for this user' });
    }

    const { secret, code } = body;

    const isValid = verifyTOTPWithGracePeriod(decodeBase32(secret), 30, 6, code, 60);

    if (!isValid) {
      return status(400, { error: 'Invalid TOTP code' });
    }

    // this is a funny query ai made for me because i dont know ball
    // sql is hard
    const [enabled] = await db
      .update(localCredentials)
      .set({
        totpSecret: Buffer.from(secret),
        mfaOptions: sql`
          array_append(${localCredentials.mfaOptions}, 'TOTP'::mfa_method)
        `,
      })
      .where(
        and(
          eq(localCredentials.userId, session.userId),
          isNull(localCredentials.totpSecret),
          sql`NOT (${localCredentials.mfaOptions} @> ARRAY['TOTP']::mfa_method[])`
        )
      )
      .returning({ userId: localCredentials.userId });
    
    if (!enabled) {
      return status(409, { error: 'TOTP is already enabled' });
    }

    return { success: true, message: 'TOTP enabled successfully' };
  }, {
    body: t.Object({
      secret: t.String(),
      code: t.String({ minLength: 6, maxLength: 6 }),
    }),
    response: {
      200: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      400: genericResponseErrorSchema,
      401: genericResponseErrorSchema,
      404: genericResponseErrorSchema,
      409: genericResponseErrorSchema,
    },
  }).post('/mfa/email/toggle', async ({ cookie, body, status }) => {
    const { enable } = body;
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }

    const localCreds = await db.query.localCredentials.findFirst({
      where: {
        userId: session.userId,
      },
    });
    if (!localCreds) {
      return status(404, { error: 'User not found' });
    }

    await db.update(localCredentials).set({
      mfaOptions: enable
        ? sql`array_append(${localCredentials.mfaOptions}, 'EMAIL'::mfa_method)`
        : sql`array_remove(${localCredentials.mfaOptions}, 'EMAIL'::mfa_method)`,
    }).where(eq(localCredentials.userId, session.userId));

    return { success: true, message: `Email MFA ${enable ? 'enabled' : 'disabled'} successfully` };
  }, {
    body: t.Object({
      enable: t.Boolean(),
    }),
    response: {
      200: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      400: genericResponseErrorSchema,
      401: genericResponseErrorSchema,
      404: genericResponseErrorSchema,
    },
  }).post('/mfa/totp/toggle', async ({ cookie, body, status }) => {
    const { enable } = body;
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }

    const localCreds = await db.query.localCredentials.findFirst({
      where: {
        userId: session.userId,
      },
    });
    if (!localCreds) {
      return status(404, { error: 'User not found' });
    }

    if (enable && !localCreds.totpSecret) {
      return status(400, { error: 'TOTP is not set up for this user' });
    }

    await db.update(localCredentials).set({
      mfaOptions: enable
        ? sql`array_append(${localCredentials.mfaOptions}, 'TOTP'::mfa_method)`
        : sql`array_remove(${localCredentials.mfaOptions}, 'TOTP'::mfa_method)`,
    }).where(eq(localCredentials.userId, session.userId));

    return { success: true, message: `TOTP MFA ${enable ? 'enabled' : 'disabled'} successfully` };
  }, {
    body: t.Object({
      enable: t.Boolean(),
    }),
    response: {
      200: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      400: genericResponseErrorSchema,
      401: genericResponseErrorSchema,
      404: genericResponseErrorSchema,
    },
  }).delete('/mfa/totp', async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }

    const localCreds = await db.query.localCredentials.findFirst({
      where: {
        userId: session.userId,
      },
    });
    if (!localCreds) {
      return status(404, { error: 'User not found' });
    }
    if (!localCreds.totpSecret) {
      return status(400, { error: 'TOTP is not set up for this user' });
    }

    await db.update(localCredentials).set({
      totpSecret: null,
      mfaOptions: sql`array_remove(${localCredentials.mfaOptions}, 'TOTP'::mfa_method)`,
    }).where(eq(localCredentials.userId, session.userId));

    return { success: true, message: 'TOTP MFA disabled successfully' };
  }, {
    response: {
      200: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      400: genericResponseErrorSchema,
      401: genericResponseErrorSchema,
      404: genericResponseErrorSchema,
    },
  })
  .get('/mfa', async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }

    const localCreds = await db.query.localCredentials.findFirst({
      where: {
        userId: session.userId,
      },
    });
    if (!localCreds) {
      return status(404, { error: 'User not found' });
    }

    return { mfaOptions: localCreds.mfaOptions };
  }, {
    response: {
      200: z.object({
        mfaOptions: z.array(z.enum(['EMAIL', 'TOTP'])),
      }),
      401: genericResponseErrorSchema,
      404: genericResponseErrorSchema,
    },
  });

export function userResponse(user: Parameters<typeof publicUser>[0], email: string | null = null) {
  const { userId: id, ...profile } = publicUser(user);
  return {
    id,
    ...profile,
    handle: `@${user.username}:${user.homeserver}`,
    email,
  };
}

function hashOtp(otp: number) {
  return createHmac('sha256', getConfig().misc.otp_pepper).update(otp.toString()).digest('hex');
}
