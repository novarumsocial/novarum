import Elysia, { t } from 'elysia';
import { storage, publicPresign, noStoreRedirect } from '../../utils/services/storage';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { getConfig } from '../../utils/config';
import { userResponse, userResponseSchema } from '../auth/services';
import { db, users } from '../../src/db';
import { eq } from 'drizzle-orm';
import { getAverageColor } from 'fast-average-color-node';
import { z } from 'zod';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { publicUser } from '../../utils/publicUser';
import { publishRealtime } from '../../utils/publishRealtime';
import type { RealtimeEvent } from '../../src';

const maxAvatarSize = getConfig().files.max_avatar_size * 1024 * 1024;
const userPayloadResponseSchema = z.object({ user: userResponseSchema });

export const user = new Elysia({ prefix: '/user', tags: ['User'] })
  .get(
    '/avatar/:userId',
    async ({ params, query, status }) => {
      const user = await db.query.users.findFirst({
        where: { id: params.userId },
      });
      if (!user?.avatarUrl) return status(404, { error: 'Avatar not found' });

      const format = query.format === 'gif' ? 'gif' : 'png';
      const type = format === 'gif' ? 'image/gif' : 'image/png';
      const url = publicPresign(`avatars/${user.id}${format === 'gif' ? '.gif' : ''}`, {
        method: 'GET',
        expiresIn: 5 * 60,
        type,
        contentDisposition: 'inline',
      });

      return noStoreRedirect(url);
    },
    {
      response: {
        302: t.Void(),
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/avatar',
    async ({ body, cookie, status, server }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) return status(401, { error: 'Unauthorized' });
      if (body.avatar.type !== 'image/png' && body.avatar.type !== 'image/gif') {
        return status(415, { error: 'Avatar must be a PNG or GIF image' });
      }
      if (body.avatar.size > maxAvatarSize) {
        return status(413, { error: 'Avatar must be smaller than 2 MB' });
      }

      const format = body.avatar.type === 'image/gif' ? 'gif' : 'png';
      await storage.write(
        `avatars/${session.userId}${format === 'gif' ? '.gif' : ''}`,
        body.avatar,
        {
          type: body.avatar.type,
        }
      );

      const color = await getAverageColor(Buffer.from(await body.avatar.arrayBuffer()));

      const version = Date.now();
      const avatarUrl = new URL(
        `/user/avatar/${encodeURIComponent(session.userId)}?format=${format}&v=${version}`,
        getConfig().server.baseUrl
      ).toString();

      // updating but also getting the returning to prevent so many queries
      const [user] = await db
        .update(users)
        .set({
          avatarUrl,
          avatarColor: color.hex.toUpperCase(),
        })
        .where(eq(users.id, session.user.id))
        .returning();
      if (!user) return status(404, { error: 'User not found' });

      if (server) {
        const memberships = await db.query.guildMembers.findMany({
          where: { userId: session.userId },
          columns: { guildId: true },
        });
        const event: RealtimeEvent = {
          type: 'user.updated',
          data: { user: publicUser(user) },
        }

        publishRealtime(server, `userEvents:${session.userId}`, event);
        for (const memb of memberships) {
          publishRealtime(server, `guildEvents:${memb.guildId}`, event);
        }
      }

      return { user: userResponse(user) };
    },
    {
      body: t.Object({
        avatar: t.File({ maxSize: maxAvatarSize }),
      }),
      response: {
        200: userPayloadResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        413: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/avatar/color',
    async ({ body, cookie, status, server }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) return status(401, { error: 'Unauthorized' });

      const [user] = await db
        .update(users)
        .set({
          avatarColor: body.avatarColor.toUpperCase(),
          speakingRingColor: body.speakingRingColor.toUpperCase(),
        })
        .where(eq(users.id, session.user.id))
        .returning();

      if (!user) return status(404, { error: 'User not found' });

      if (server) {
        const memberships = await db.query.guildMembers.findMany({
          where: { userId: session.userId },
          columns: { guildId: true },
        });
        const event: RealtimeEvent = {
          type: 'user.updated',
          data: { user: publicUser(user) },
        }

        publishRealtime(server, `userEvents:${session.userId}`, event);
        for (const memb of memberships) {
          publishRealtime(server, `guildEvents:${memb.guildId}`, event);
        }
      }

      return {
        avatarColor: user.avatarColor!,
        speakingRingColor: user.speakingRingColor!,
      };
    },
    {
      // should make one of these optional if the api starts getting used by clients outside of the web
      body: t.Object({
        avatarColor: t.String({
          pattern: '^#[0-9A-Fa-f]{6}$',
        }),
        speakingRingColor: t.String({
          pattern: '^#[0-9A-Fa-f]{6}$',
        }),
      }),
      response: {
        200: z.object({ avatarColor: z.string().regex(/^#[0-9A-F]{6}$/), speakingRingColor: z.string().regex(/^#[0-9A-F]{6}$/) }),
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/banner/:userId',
    async ({ params, query, status }) => {
      const user = await db.query.users.findFirst({ where: { id: params.userId } });
      if (!user?.bannerUrl) return status(404, { error: 'Banner not found' });

      const format = query.format === 'gif' ? 'gif' : 'png';
      const type = format === 'gif' ? 'image/gif' : 'image/png';
      return noStoreRedirect(
        publicPresign(`banners/${user.id}.${format}`, {
          method: 'GET',
          expiresIn: 5 * 60,
          type,
          contentDisposition: 'inline',
        })
      );
    },
    {
      response: {
        302: t.Void(),
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/banner',
    async ({ body, cookie, status, server }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) return status(401, { error: 'Unauthorized' });
      if (body.banner.type !== 'image/png' && body.banner.type !== 'image/gif') {
        return status(415, { error: 'Banner must be a PNG or GIF image' });
      }
      if (body.banner.size > maxAvatarSize) {
        return status(413, { error: 'Banner is too large' });
      }

      const format = body.banner.type === 'image/gif' ? 'gif' : 'png';
      await storage.write(`banners/${session.userId}.${format}`, body.banner, {
        type: body.banner.type,
      });

      const bannerUrl = new URL(
        `/user/banner/${encodeURIComponent(session.userId)}?format=${format}&v=${Date.now()}`,
        getConfig().server.baseUrl
      ).toString();
      await db
        .update(users)
        .set({ bannerUrl, updatedAt: new Date() })
        .where(eq(users.id, session.userId));
      const user = await db.query.users.findFirst({ where: { id: session.userId } });
      if (!user) return status(404, { error: 'User not found' });

      if (server) {
        const memberships = await db.query.guildMembers.findMany({
          where: { userId: session.userId },
          columns: { guildId: true },
        });
        const event: RealtimeEvent = {
          type: 'user.updated',
          data: { user: publicUser(user) },
        }

        publishRealtime(server, `userEvents:${session.userId}`, event);
        for (const memb of memberships) {
          publishRealtime(server, `guildEvents:${memb.guildId}`, event);
        }
      }

      return { user: userResponse(user) };
    },
    {
      body: t.Object({ banner: t.File({ maxSize: maxAvatarSize }) }),
      response: {
        200: userPayloadResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        413: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/about/:userId',
    async ({ params, status }) => {
      const user = await db.query.users.findFirst({ where: { id: params.userId } });
      if (!user) return status(404, { error: 'User not found' });

      return { about: user.about };
    },
    {
      response: {
        200: z.object({ about: z.string().max(512).nullable() }),
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/about',
    async ({ body, cookie, status, server }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) return status(401, { error: 'Unauthorized' });

      await db
        .update(users)
        .set({ about: body.about, updatedAt: new Date() })
        .where(eq(users.id, session.userId));
      const user = await db.query.users.findFirst({ where: { id: session.userId } });
      if (!user) return status(404, { error: 'User not found' });

      if (server) {
        const memberships = await db.query.guildMembers.findMany({
          where: { userId: session.userId },
          columns: { guildId: true },
        });
        const event: RealtimeEvent = {
          type: 'user.updated',
          data: { user: publicUser(user) },
        }

        publishRealtime(server, `userEvents:${session.userId}`, event);
        for (const memb of memberships) {
          publishRealtime(server, `guildEvents:${memb.guildId}`, event);
        }
      }

      return { user: userResponse(user) };
    },
    {
      body: t.Object({ about: t.Nullable(t.String({ maxLength: 512 })) }),
      response: {
        200: userPayloadResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  );
