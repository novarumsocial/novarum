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

function userResponse(user: {
  id: string;
  username: string;
  homeserverName: string;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}, email: string | null = null) {
  return {
    id: user.id,
    username: user.username,
    homeserverName: user.homeserverName,
    handle: `@${user.username}:${user.homeserverName}`,
    displayName: user.displayName,
    email,
    avatarUrl: user.avatarUrl,
    isBot: user.isBot,
  };
}

export const auth = new Elysia({ prefix: '/auth' })
  .post(
    '/signup',
    async ({ body, cookie, request, status }) => {
      const { username, displayName, email, password, homeserver } = body;
      const now = new Date();

      const existingCredential = await db.orm.public.LocalCredential.where({ email }).first();
      if (existingCredential) {
        status(409);
        return { error: 'User already exists' };
      }

      const existingUsername = await db.orm.public.User.where({ username, homeserverName: homeserver }).first();
      if (existingUsername) {
        status(409);
        return { error: 'Username is already taken' };
      }

      const user = await db.orm.public.User.create({
        id: randomString(),
        username,
        homeserverName: homeserver,
        displayName: displayName || null,
        avatarUrl: null,
        isBot: false,
        createdAt: now,
        updatedAt: now,
      });

      await db.orm.public.LocalCredential.create({
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
        homeserver: t.String({ minLength: 1, maxLength: 255 }),
        email: t.String({ type: 'email' }),
        password: t.String({ minLength: 8 }),
      }),
    }
  )
  .post(
    '/login',
    async ({ body, cookie, request, status }) => {
      const { username, homeserver, password } = body;

      const user = await db.orm.public.User.where({ username, homeserverName: homeserver }).first();
      if (!user) {
        status(401);
        return { error: 'Invalid username or password' };
      }

      const credential = await db.orm.public.LocalCredential.where({ userId: user.id }).first();
      if (!credential) {
        status(401);
        return { error: 'Invalid username or password' };
      }

      const validPassword = await Bun.password.verify(password, credential.passwordHash);
      if (!validPassword) {
        status(401);
        return { error: 'Invalid username or password' };
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
        homeserver: t.String({ minLength: 1, maxLength: 255 }),
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

    const user = await db.orm.public.User.where({ id: session.userId }).first();
    if (!user) {
      return status(401, { user: null });
    }

    const credential = await db.orm.public.LocalCredential.where({ userId: user.id }).first();

    return {
      user: userResponse(user, credential?.email ?? null),
    };
  });
