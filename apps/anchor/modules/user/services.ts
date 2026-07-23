import Elysia, { t } from 'elysia';
import { storage } from '../../utils/services/storage';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { getConfig } from '../../utils/config';
import { userResponse } from '../auth/services';
import { db, users } from '../../src/db';
import { eq } from 'drizzle-orm';

const maxAvatarSize = getConfig().files.max_avatar_size * 1024 * 1024;

export const user = new Elysia({ prefix: '/user' })
  .get('/avatar/:userId', async ({ params, status }) => {
    const user = await db.query.users.findFirst({
      where: { id: params.userId },
    });
    if (!user?.avatarUrl) return status(404, { error: 'Avatar not found' });

    const url = storage.presign(`avatars/${user.id}`, {
      method: 'GET',
      expiresIn: 5 * 60,
      type: 'image/png',
      contentDisposition: 'inline',
    });

    return Response.redirect(url);
  })
  .post(
    '/avatar',
    async ({ body, cookie, status }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) return status(401, { error: 'Unauthorized' });
      if (body.avatar.type !== 'image/png') {
        return status(415, { error: 'Avatar must be a PNG image' });
      }
      if (body.avatar.size > maxAvatarSize) {
        return status(413, { error: 'Avatar must be smaller than 2 MB' });
      }

      await storage.write(`avatars/${session.userId}`, body.avatar, { type: 'image/png' });

      const version = Date.now();
      const avatarUrl = new URL(
        `/user/avatar/${encodeURIComponent(session.userId)}?v=${version}`,
        getConfig().server.baseUrl
      ).toString();
      await db
        .update(users)
        .set({
          avatarUrl,
          updatedAt: new Date(),
        })
        .where(eq(users.id, session.id));
      const user = await db.query.users.findFirst({
        where: { id: session.userId },
      });
      if (!user) return status(404, { error: 'User not found' });

      return { user: userResponse(user) };
    },
    {
      body: t.Object({
        avatar: t.File({
          type: 'image/png',
          maxSize: maxAvatarSize,
        }),
      }),
    }
  );
