import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';
import {
  createBlankSessionCookie,
  createSession,
  createSessionCookie,
  deleteSessionToken,
  sessionCookieName,
  validateSessionToken,
} from './provider';

const homeserverName = process.env['HOMESERVER_NAME'] ?? 'novarum.social';

function userResponse(user: {
  id: string;
  username: string;
  homeserverName: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}) {
  return {
    id: user.id,
    username: user.username,
    homeserverName: user.homeserverName,
    handle: `@${user.username}:${user.homeserverName}`,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    isBot: user.isBot,
  };
}

export const auth = new Elysia({ prefix: '/auth' })
  .post(
    '/signup',
    async ({ body, cookie, status }) => {
      const { username, displayName, email, password } = body;
      const now = new Date();

      const existingUser = await db.orm.public.User.where({ email }).first();
      if (existingUser) {
        status(409);
        return { error: 'User already exists' };
      }

      const existingUsername = await db.orm.public.User.where({ username, homeserverName }).first();
      if (existingUsername) {
        status(409);
        return { error: 'Username is already taken' };
      }

      const user = await db.orm.public.User.create({
        id: randomString(),
        username,
        homeserverName,
        displayName: displayName || null,
        email,
        passwordHash: await Bun.password.hash(password),
        avatarUrl: null,
        isBot: false,
        createdAt: now,
        updatedAt: now,
      });

      const session = await createSession(user.id);
      const sessionCookie = createSessionCookie(session.token);

      cookie[sessionCookie.name]!.set({
        value: sessionCookie.value,
        ...sessionCookie.attributes,
      });

      return {
        user: userResponse(user),
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
    async ({ body, cookie, status }) => {
      const { email, password } = body;

      const user = await db.orm.public.User.where({ email }).first();
      if (!user) {
        status(401);
        return { error: 'Invalid email or password' };
      }

      if (!user.passwordHash) {
        status(401);
        return { error: 'Invalid email or password' };
      }

      const validPassword = await Bun.password.verify(password, user.passwordHash);
      if (!validPassword) {
        status(401);
        return { error: 'Invalid email or password' };
      }

      const session = await createSession(user.id);
      const sessionCookie = createSessionCookie(session.token);

      cookie[sessionCookie.name]!.set({
        value: sessionCookie.value,
        ...sessionCookie.attributes,
      });

      return {
        user: userResponse(user),
      };
    },
    {
      body: t.Object({
        email: t.String({ type: 'email' }),
        password: t.String({ minLength: 8 }),
      }),
    }
  )
  .post('/logout', async ({ cookie }) => {
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
  })
  .get('/me', async ({ cookie, status }) => {
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

    const user = await db.orm.public.User.where({ id: session.userId }).first();
    if (!user) {
      return status(401, { user: null });
    }

    return {
      user: userResponse(user),
    };
  });
