import Elysia, { Cookie, t } from 'elysia';
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

export const auth = new Elysia({ prefix: '/auth' })
  .post(
    '/signup',
    async ({ body, cookie, status }) => {
      const { email, password } = body;

      const existingUser = await db.orm.public.User.where({ email }).first();
      if (existingUser) {
        status(409);
        return { error: 'User already exists' };
      }

      const user = await db.orm.public.User.create({
        id: randomString(),
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
        user: {
          id: user.id,
          email: user.email,
        },
      };
    },
    {
      body: t.Object({
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
        user: {
          id: user.id,
          email: user.email,
        },
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
      user: {
        id: user.id,
        email: user.email,
      },
    };
  });
