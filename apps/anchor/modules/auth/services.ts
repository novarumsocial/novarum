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
import { db, localCredentials, users } from '../../src/db';

export const auth = new Elysia({ prefix: '/auth' })
  .post(
    '/signup',
    async ({ body, cookie, request, status }) => {
      const { username, displayName, email, password } = body;
      const homeserver = getConfig().server.homeserver;
      const now = new Date();

      const existingCredential = await db.query.localCredentials.findFirst({
        where: {
          email,
        },
      });
      if (existingCredential) {
        return status(409, { error: 'User already exists' });
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
      const sessionCookie = createSessionCookie(session.token, request);

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
    }
  )
  .post(
    '/login',
    async ({ body, cookie, request, status }) => {
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

      const session = await createSession(user.id);
      const sessionCookie = createSessionCookie(session.token, request);

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
    }
  )
  .post('/logout', async ({ cookie, request }) => {
    const sessionCookie = cookie[sessionCookieName]?.value as string | undefined;
    if (sessionCookie) {
      await deleteSessionToken(sessionCookie);
    }

    const blankCookie = createBlankSessionCookie(request);
    cookie[sessionCookieName]!.set({
      value: blankCookie.value,
      ...blankCookie.attributes,
    });

    return { success: true, message: 'Logged out successfully' };
  })
  .get('/me', async ({ cookie, request, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    if (!token) {
      return status(401, { user: null });
    }

    const session = await validateSessionToken(token);
    if (!session) {
      const blankCookie = createBlankSessionCookie(request);

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
  });

export function userResponse(
  user: {
    id: string;
    username: string;
    homeserver: string;
    displayName: string | null;
    avatarUrl: string | null;
    isBot: boolean;
  },
  email: string | null = null
) {
  return {
    id: user.id,
    username: user.username,
    homeserver: user.homeserver,
    handle: `@${user.username}:${user.homeserver}`,
    displayName: user.displayName,
    email,
    avatarUrl: user.avatarUrl,
    isBot: user.isBot,
  };
}
