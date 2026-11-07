import Elysia, { t } from 'elysia';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getAverageColor } from 'fast-average-color-node';
import { bots, db, guildMembers, sessions, users } from '../../src/db';
import {
  botTokenExpiry,
  createSession,
  requestSession,
  sessionCookieName,
  validateSessionToken,
} from '../auth/provider';
import { closeSessionSockets } from '../realtime/services';
import { getConfig } from '../../utils/config';
import { randomString } from '../../utils/randomString';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { publicUser, publicUserSchema, userProfileSchema } from '../../utils/publicUser';
import { publishRealtime } from '../../utils/publishRealtime';
import { storage } from '../../utils/services/storage';
import { processImage } from '../../utils/optimizeWebp';
import { commandListSchema } from '../../utils/botSchemas';
import type { RealtimeEvent } from '../../utils/types';
import { hostRemoveBot, leaveGuild, lookupBot, requestAddBot } from './membership';
import { parseFederatedGuildId } from '../../utils/federationIds';
import { callRemote, passThrough } from '../../utils/federationClient';

const maxAvatarSize = getConfig().files.max_avatar_size * 1024 * 1024;

const botResponseSchema = publicUserSchema.extend({
  handle: z.string(),
  public: z.boolean(),
  createdAt: z.iso.datetime(),
  commands: commandListSchema,
  guildCount: z.number().int().nonnegative(),
});
const botPayloadSchema = z.object({ bot: botResponseSchema });
const botWithTokenSchema = z.object({ bot: botResponseSchema, token: z.string() });
const successResponseSchema = z.object({ success: z.boolean() });

type BotRow = typeof bots.$inferSelect & { user: typeof users.$inferSelect };

async function botResponse(bot: BotRow) {
  const user = publicUser(bot.user);
  return {
    ...user,
    handle: `@${user.username}:${user.homeserver}`,
    public: bot.public,
    createdAt: bot.createdAt.toISOString(),
    commands: bot.commands,
    guildCount: await db.$count(guildMembers, eq(guildMembers.userId, bot.userId)),
  };
}

const findOwnBot = (id: string, ownerId: string) =>
  db.query.bots.findFirst({ where: { userId: id, ownerId }, with: { user: true } });

// replaces every token of the bot with a new one and drops the connections of the old ones
async function regenerateToken(botId: string) {
  await db.delete(sessions).where(eq(sessions.userId, botId));
  closeSessionSockets((session) => session.userId === botId);
  return (await createSession(botId, botTokenExpiry())).token;
}

// a profile change reaches the guilds the bot is in, like it does for people
async function publishProfile(
  server: Parameters<typeof publishRealtime>[0] | null,
  userId: string
) {
  const user = await db.query.users.findFirst({ where: { id: userId } });
  if (!server || !user) return;
  const event: RealtimeEvent = { type: 'user.updated', data: { user: publicUser(user) } };
  publishRealtime(server, `userEvents:${userId}`, event);
  const memberships = await db.query.guildMembers.findMany({ where: { userId } });
  for (const { guildId } of memberships) publishRealtime(server, `guildEvents:${guildId}`, event);
}

// The developer panel: people managing the bots they own. Cookie sessions only.
export const developers = new Elysia({ prefix: '/developers/bots', tags: ['Bots'] })
  .resolve(async ({ cookie, status }) => {
    const session = await validateSessionToken(
      cookie[sessionCookieName]?.value as string | undefined
    );
    if (!session) return status(401, { error: 'Unauthorized' });
    return { session };
  })
  .get(
    '/',
    async ({ session }) => {
      const owned = await db.query.bots.findMany({
        where: { ownerId: session.userId },
        with: { user: true },
        orderBy: { createdAt: 'asc' },
      });
      return { bots: await Promise.all(owned.map(botResponse)) };
    },
    {
      response: {
        200: z.object({ bots: z.array(botResponseSchema) }),
        401: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/',
    async ({ body, session, status }) => {
      const { enabled, max_per_user } = getConfig().bots;
      if (!enabled) return status(403, { error: 'Bot creation is disabled on this homeserver' });
      if ((await db.$count(bots, eq(bots.ownerId, session.userId))) >= max_per_user) {
        return status(403, { error: `You can have at most ${max_per_user} bots` });
      }

      const homeserver = getConfig().server.homeserver;
      const taken = await db.query.users.findFirst({
        where: { username: body.username, homeserver },
      });
      if (taken) return status(409, { error: 'Username is already taken' });

      const now = new Date();
      const bot = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            id: randomString(),
            username: body.username,
            homeserver,
            displayName: body.displayName || null,
            isBot: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const [bot] = await tx
          .insert(bots)
          .values({ userId: user!.id, ownerId: session.userId })
          .returning();
        return { ...bot!, user: user! };
      });

      return { bot: await botResponse(bot), token: await regenerateToken(bot.userId) };
    },
    {
      body: z.object({
        username: publicUserSchema.shape.username,
        displayName: userProfileSchema.shape.displayName.optional(),
      }),
      response: {
        200: botWithTokenSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/:id',
    async ({ params, session, status }) => {
      const bot = await findOwnBot(params.id, session.userId);
      if (!bot) return status(404, { error: 'Bot not found' });
      return { bot: await botResponse(bot) };
    },
    {
      response: {
        200: botPayloadSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .patch(
    '/:id',
    async ({ params, body, session, server, status }) => {
      const bot = await findOwnBot(params.id, session.userId);
      if (!bot) return status(404, { error: 'Bot not found' });

      const { public: isPublic, ...profile } = body;
      if (isPublic !== undefined) {
        await db.update(bots).set({ public: isPublic }).where(eq(bots.userId, bot.userId));
      }
      if (Object.keys(profile).length) {
        await db.update(users).set(profile).where(eq(users.id, bot.userId));
        await publishProfile(server, bot.userId);
      }

      return { bot: await botResponse((await findOwnBot(params.id, session.userId))!) };
    },
    {
      body: z.object({
        displayName: userProfileSchema.shape.displayName.optional(),
        about: z.string().max(512).nullable().optional(),
        public: z.boolean().optional(),
      }),
      response: {
        200: botPayloadSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/:id/avatar',
    async ({ params, body, session, server, status }) => {
      const bot = await findOwnBot(params.id, session.userId);
      if (!bot) return status(404, { error: 'Bot not found' });
      if (body.avatar.type !== 'image/png' && body.avatar.type !== 'image/gif') {
        return status(415, { error: 'Avatar must be a PNG or GIF image' });
      }

      const buffer = await body.avatar.arrayBuffer();
      const image = await processImage(buffer);
      await storage.write(`avatars/${bot.userId}.webp`, image.data, { type: 'image/webp' });
      const color = await getAverageColor(Buffer.from(buffer));
      const avatarUrl = new URL(
        `/user/avatar/${encodeURIComponent(bot.userId)}?v=${Date.now()}${image.animated ? '&animated=1' : ''}`,
        getConfig().server.base_url
      ).toString();
      await db
        .update(users)
        .set({ avatarUrl, avatarColor: color.hex.toUpperCase() })
        .where(eq(users.id, bot.userId));
      await publishProfile(server, bot.userId);

      return { bot: await botResponse((await findOwnBot(params.id, session.userId))!) };
    },
    {
      body: t.Object({ avatar: t.File({ maxSize: maxAvatarSize }) }),
      response: {
        200: botPayloadSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        413: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/:id/token',
    async ({ params, session, status }) => {
      const bot = await findOwnBot(params.id, session.userId);
      if (!bot) return status(404, { error: 'Bot not found' });
      return { bot: await botResponse(bot), token: await regenerateToken(bot.userId) };
    },
    {
      response: {
        200: botWithTokenSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  // The bot user stays behind (its messages reference it) under a freed-up username, but it
  // leaves every guild, loses its tokens and can never be used again.
  .delete(
    '/:id',
    async ({ params, session, server, status }) => {
      const bot = await findOwnBot(params.id, session.userId);
      if (!bot) return status(404, { error: 'Bot not found' });

      const memberships = await db.query.guildMembers.findMany({ where: { userId: bot.userId } });
      await Promise.all(
        memberships.map((m) => leaveGuild(server, bot.user, m.guildId).catch(() => null))
      );
      await db.delete(sessions).where(eq(sessions.userId, bot.userId));
      closeSessionSockets((s) => s.userId === bot.userId);
      await db.transaction(async (tx) => {
        await tx.delete(bots).where(eq(bots.userId, bot.userId));
        await tx.delete(guildMembers).where(eq(guildMembers.userId, bot.userId));
        await tx
          .update(users)
          .set({
            username: `deleted_${randomString()
              .slice(0, 16)
              .replace(/[^a-zA-Z0-9]/g, '_')}`,
            displayName: 'Deleted bot',
            avatarUrl: null,
            bannerUrl: null,
            about: null,
            status: 'OFFLINE',
          })
          .where(eq(users.id, bot.userId));
      });

      return { success: true };
    },
    {
      response: {
        200: successResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  );

// What a bot can do about itself, with its token.
export const botSelf = new Elysia({ prefix: '/bots/@me', tags: ['Bots'] })
  .resolve(async ({ cookie, request, status }) => {
    const session = await requestSession(cookie, request);
    if (!session?.user.isBot) return status(401, { error: 'Unauthorized' });
    const bot = await db.query.bots.findFirst({
      where: { userId: session.userId },
      with: { user: true },
    });
    if (!bot) return status(401, { error: 'Unauthorized' });
    return { session, bot };
  })
  .get('/', async ({ bot }) => ({ bot: await botResponse(bot) }), {
    response: { 200: botPayloadSchema, 401: genericResponseErrorSchema },
  })
  .get('/commands', ({ bot }) => ({ commands: bot.commands }), {
    response: { 200: z.object({ commands: commandListSchema }), 401: genericResponseErrorSchema },
  })
  // replaces every global command of the bot at once
  .put(
    '/commands',
    async ({ body, bot }) => {
      const [updated] = await db
        .update(bots)
        .set({ commands: body.commands })
        .where(eq(bots.userId, bot.userId))
        .returning();
      return { commands: updated!.commands };
    },
    {
      body: z.object({ commands: commandListSchema }),
      response: { 200: z.object({ commands: commandListSchema }), 401: genericResponseErrorSchema },
    }
  )
  .post(
    '/guilds/:id/leave',
    async ({ params, bot, server, status }) => {
      const membership = await db.query.guildMembers.findFirst({
        where: { guildId: params.id, userId: bot.userId },
      });
      if (!membership) return status(404, { error: 'Guild not found' });
      await leaveGuild(server, bot.user, params.id);
      return { success: true };
    },
    {
      response: {
        200: successResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  );

const botRefSchema = z.object({
  username: publicUserSchema.shape.username,
  homeserver: publicUserSchema.shape.homeserver,
});

// People adding bots to guilds and looking them up. Cookie sessions only: bots can't add bots.
export const botGuilds = new Elysia({ tags: ['Bots'] })
  .resolve(async ({ cookie, status }) => {
    const session = await validateSessionToken(
      cookie[sessionCookieName]?.value as string | undefined
    );
    if (!session) return status(401, { error: 'Unauthorized' });
    return { session };
  })
  .get(
    '/bots/lookup',
    async ({ query, status }) => {
      const bot = await lookupBot(query);
      if (!bot) return status(404, { error: 'Bot not found' });
      return bot;
    },
    {
      query: botRefSchema,
      response: {
        200: z.object({ user: publicUserSchema, public: z.boolean() }),
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/guilds/:id/bots',
    async ({ params, body, session, server, status }) => {
      const { role, ...bot } = body;
      const added = await requestAddBot(server, session, params.id, bot, role);
      if (!added.ok) return status(added.status, { error: added.error });
      return { success: true };
    },
    {
      body: botRefSchema.extend({ role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER') }),
      response: {
        200: successResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .delete(
    '/guilds/:id/bots/:userId',
    async ({ params, session, server, status }) => {
      const membership = await db.query.guildMembers.findFirst({
        where: { guildId: params.id, userId: session.userId },
        with: { guild: true },
      });
      if (!membership) return status(404, { error: 'Guild not found' });

      const federatedGuild = parseFederatedGuildId(params.id);
      if (!federatedGuild) {
        const removed = await hostRemoveBot(
          server,
          membership.guild,
          session.userId,
          params.userId
        );
        if (!removed.ok) return status(removed.status, { error: removed.error });
        return { success: true };
      }
      const removed = await callRemote(
        federatedGuild.homeserver,
        `/federation/guilds/${encodeURIComponent(federatedGuild.id)}/bots/remove`,
        session,
        { userId: params.userId },
        {
          response: z.unknown(),
          forward: passThrough(400, 403, 404),
          errors: { failed: 'Remote removal failed', invalid: 'Remote removal failed' },
        }
      );
      if (!removed.ok) return status(removed.status, removed.error);
      return { success: true };
    },
    {
      response: {
        200: successResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  );
