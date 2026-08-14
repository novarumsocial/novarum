import Elysia, { t } from 'elysia';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';
import {
  makeFederatedChannelId,
  parseFederatedChannelId,
  parseFederatedGuildId,
} from '../../utils/federationIds';
import { isMessageAfter } from '../../utils/messageCursor';
import { ensureFederatedGuildRealtimeBridge } from '../../utils/federationRealtime';
import { storage, publicPresign, noStoreRedirect } from '../../utils/services/storage';
import { getConfig } from '../../utils/config';
import { randomInt } from 'node:crypto';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload } from '../../utils/federationPayload';
import { z } from 'zod';
import {
  channelReadStates,
  channels,
  db,
  guilds as dbGuilds,
  guildInvites,
  guildMembers,
} from '../../src/db';
import { and, eq, sql } from 'drizzle-orm';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import {
  channelResponseSchema,
  guildCreateSchema,
  guildInviteResponseSchema as inviteSchema,
  guildResponseSchema as guildSchema,
} from '../../src/db/zod';
import { processImage } from '../../utils/optimizeWebp';

const maxAvatarSize = getConfig().files.max_avatar_size * 1024 * 1024;
const successResponseSchema = z.object({ success: z.boolean() });
const guildListResponseSchema = z.object({
  guilds: z.array(
    guildSchema.pick({ id: true, name: true, avatarUrl: true, description: true }).extend({
      down: z.boolean(),
      canManageChannels: z.boolean(),
      channels: z.array(
        channelResponseSchema.extend({
          lastReadMessageId: z.string().nullable(),
          unread: z.boolean(),
          mention: z.number().int().nonnegative(),
        })
      ),
    })
  ),
});
const unreadMentionsResponseSchema = z.object({
  channels: z.array(
    z.object({
      id: z.string(),
      mention: z.number().int().nonnegative(),
    })
  ),
});
type PingMessage = { id: string; channelId: string; createdAt: Date | string };

export const guilds = new Elysia({ prefix: '/guilds', tags: ['Guilds'] })
  .get(
    '/avatar/:id',
    async ({ params, query, status }) => {
      const { format } = query;
      const guild = await db.query.guilds.findFirst({
        where: { id: params.id },
      });
      if (!guild?.avatarUrl) return status(404, { error: 'Guild picture not found' });

      const url = publicPresign(`guild-avatars/${guild.id}.${format || 'webp'}`, {
        method: 'GET',
        expiresIn: 5 * 60,
        type: `image/${format || 'webp'}`,
        contentDisposition: 'inline',
      });

      return noStoreRedirect(url);
    },
    {
      response: {
        302: t.Void(),
        404: genericResponseErrorSchema,
      },
      query: t.Object({
        format: t.Optional(t.Enum({ png: 'png', gif: 'gif' })),
      }),
    }
  )
  .resolve(async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }
    return { session };
  })
  .post(
    '/:id/avatar',
    async ({ params, body, session, status }) => {
      if (parseFederatedGuildId(params.id)) {
        return status(400, { error: 'Cannot manage a federated guild' });
      }

      const guild = await db.query.guilds.findFirst({
        where: { id: params.id },
      });
      if (!guild) return status(404, { error: 'Guild not found' });
      if (guild.ownerId !== session.userId) return status(403, { error: 'Forbidden' });
      if (body.avatar.type !== 'image/png' && body.avatar.type !== 'image/gif') {
        return status(415, { error: 'Guild picture must be a PNG or GIF image' });
      }
      if (body.avatar.size > maxAvatarSize) {
        return status(413, { error: 'Guild picture is too large' });
      }

      const image = await processImage(await body.avatar.arrayBuffer());
      await storage.write(`guild-avatars/${guild.id}.webp`, image.data, {
        type: 'image/webp',
      });

      const avatarUrl = new URL(
        `/guilds/avatar/${encodeURIComponent(guild.id)}?v=${Date.now()}${image.animated ? '&animated=1' : ''}`,
        getConfig().server.baseUrl
      ).toString();
      await db.update(dbGuilds).set({ avatarUrl }).where(eq(dbGuilds.id, guild.id));

      return { avatarUrl };
    },
    {
      body: t.Object({
        avatar: t.File({ maxSize: maxAvatarSize }),
      }),
      response: {
        200: z.object({ avatarUrl: z.string().url() }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        413: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/create',
    async ({ body, server, session }) => {
      const { name } = body;

      const transaction = await db.transaction(async (tx) => {
        const [guild] = await tx
          .insert(dbGuilds)
          .values({
            id: randomString(),
            name,
            ownerId: session.userId,
            extAnchorDown: false,
          })
          .returning();
        if (!guild) throw new Error('guild creation shit the bed');

        // rise all the other members' positions by 1 so that the owner is always at the top
        await tx
          .update(guildMembers)
          .set({ position: sql`${guildMembers.position} + 1` })
          .where(and(eq(guildMembers.userId, session.userId)));

        // position 0 on the list
        await tx.insert(guildMembers).values({
          guildId: guild.id,
          userId: session.userId,
          role: 'OWNER',
          position: 0,
        });

        // default general channel for the guild
        const [defChannel] = await tx
          .insert(channels)
          .values({
            // todo: this is probably no good and need to come up with a better way to generate channel ids
            id: randomString(),
            name: 'general',
            position: 0,
            guildId: guild.id,
          })
          .returning();

        return { guild, channel: defChannel };
      });

      const { guild, channel } = transaction;
      if (!channel)
        throw new Error('channel creation failed for some reason (this should never happen????)');

      if (server) {
        publishRealtime(server, `userEvents:${session.userId}`, {
          type: 'guild.created',
          data: {
            id: guild.id,
            name: guild.name,
            ownerId: guild.ownerId,
            avatarUrl: guild.avatarUrl,
            description: guild.description,
            channels: [
              {
                id: channel.id,
                name: channel.name,
                position: channel.position,
                type: channel.type as 'TEXT' | 'VOICE',
                guildId: guild.id,
              },
            ],
          },
        });
      }

      return {
        guild: {
          ...guild,
          createdAt: guild.createdAt.toISOString(),
          updatedAt: guild.updatedAt.toISOString(),
        },
      };
    },
    {
      body: guildCreateSchema,
      response: {
        200: z.object({ guild: guildSchema }),
        401: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/list',
    async ({ server, session }) => {
      const [memberships, readStates, pings] = await Promise.all([
        db.query.guildMembers.findMany({
          where: { userId: session.userId },
          with: { guild: true },
          orderBy: { position: 'asc' },
        }),
        db.query.channelReadStates.findMany({
          where: { userId: session.userId },
        }),
        db.query.messagePings.findMany({
          where: { userId: session.userId },
          with: { message: true },
        }),
      ]);
      const readStateByChannel = new Map(readStates.map((state) => [state.channelId, state]));
      const unreadPingsByChannel = new Map<string, number>();

      for (const ping of pings) {
        const message = ping.message as PingMessage;
        const readState = readStateByChannel.get(message.channelId);
        if (
          readState &&
          isMessageAfter(
            { createdAt: message.createdAt, id: message.id },
            { createdAt: readState.lastReadCreatedAt, id: readState.lastReadMessageId }
          )
        ) {
          unreadPingsByChannel.set(
            message.channelId,
            (unreadPingsByChannel.get(message.channelId) ?? 0) + 1
          );
        }
      }

      const guildChannels = await Promise.all(
        memberships.map(async ({ guild }) => {
          const id = guild.id as string;
          return {
            id,
            guild,
            channels: await db.query.channels.findMany({
              where: { guildId: id },
              orderBy: { position: 'asc' },
            }),
          };
        })
      );
      const federatedChannelsByHomeserver = new Map<
        string,
        { id: string; cursor: { createdAt: string; id: string } | null }[]
      >();

      for (const { id, channels } of guildChannels) {
        const federatedGuild = parseFederatedGuildId(id);
        if (!federatedGuild) continue;

        const remoteChannels = federatedChannelsByHomeserver.get(federatedGuild.homeserver) ?? [];
        for (const channel of channels) {
          const remoteChannel = parseFederatedChannelId(channel.id);
          if (!remoteChannel || remoteChannel.homeserver !== federatedGuild.homeserver) continue;

          const readState = readStateByChannel.get(channel.id);
          remoteChannels.push({
            id: remoteChannel.id,
            cursor: readState
              ? {
                  createdAt: new Date(readState.lastReadCreatedAt).toISOString(),
                  id: readState.lastReadMessageId,
                }
              : null,
          });
        }
        federatedChannelsByHomeserver.set(federatedGuild.homeserver, remoteChannels);
      }

      await Promise.all(
        [...federatedChannelsByHomeserver].map(async ([homeserver, channels]) => {
          const result = await postSignedFederationJson(homeserver, '/federation/unread-mentions', {
            user: federationUserPayload(session),
            channels,
          }).catch(() => null);
          if (!result?.response.ok) return;

          const response = unreadMentionsResponseSchema.safeParse(result.data);
          if (!response.success) return;

          for (const channel of response.data.channels) {
            unreadPingsByChannel.set(
              makeFederatedChannelId(homeserver, channel.id),
              channel.mention
            );
          }
        })
      );

      const guilds = [];

      for (const { id, guild, channels } of guildChannels) {
        guilds.push({
          id,
          name: guild.name as string,
          down: guild.extAnchorDown ?? false,
          canManageChannels: !parseFederatedGuildId(id) && guild.ownerId === session.userId,
          avatarUrl: guild.avatarUrl as string | null,
          description: guild.description as string | null,
          channels: await Promise.all(
            channels.map(async (channel) => {
              const latestMessage = await db.query.messages.findFirst({
                where: { channelId: channel.id },
                orderBy: {
                  createdAt: 'desc',
                  id: 'desc',
                },
              });
              const readState = readStateByChannel.get(channel.id);

              if (latestMessage && !readState) {
                await db
                  .insert(channelReadStates)
                  .values({
                    userId: session.userId,
                    channelId: channel.id,
                    lastReadCreatedAt: latestMessage.createdAt,
                    lastReadMessageId: latestMessage.id,
                  })
                  .onConflictDoNothing();
              }

              return {
                id: channel.id,
                guildId: channel.guildId,
                name: channel.name,
                position: channel.position,
                type: channel.type as 'TEXT' | 'VOICE',
                lastReadMessageId: readState?.lastReadMessageId ?? latestMessage?.id ?? null,
                unread: Boolean(
                  latestMessage &&
                  readState &&
                  isMessageAfter(
                    { createdAt: latestMessage.createdAt, id: latestMessage.id },
                    {
                      createdAt: readState.lastReadCreatedAt,
                      id: readState.lastReadMessageId,
                    }
                  )
                ),
                mention: unreadPingsByChannel.get(channel.id) ?? 0,
              };
            })
          ),
        });

        if (server && parseFederatedGuildId(id)) {
          void ensureFederatedGuildRealtimeBridge(server, id).catch(() => null);
        }
      }

      return { guilds };
    },
    {
      response: {
        200: guildListResponseSchema,
        401: genericResponseErrorSchema,
      },
    }
  )
  // right now, invites work as follows:
  // - a user can create only one invite per guild
  // - when regenerating it, the old invite is deleted and a new one is created
  // this should probably be changed in the future but it should be fine for now
  .get(
    '/:id/invites',
    async ({ params, session, status }) => {
      const { id: guildId } = params;
      if (parseFederatedGuildId(guildId)) {
        return status(400, { error: 'Cannot manage invites on a federated guild' });
      }

      const guild = await db.query.guilds.findFirst({
        where: { id: guildId },
      });
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }
      if (guild.ownerId !== session.userId) {
        return status(401, { error: 'Unauthorized' });
      }

      const invite = await db.query.guildInvites.findFirst({
        where: { creatorId: session.userId, guildId },
      });

      if (!invite) {
        return status(404, { error: 'No invite found for this guild' });
      }

      return { invite: serializeInvite(invite) };
    },
    {
      response: {
        200: z.object({ invite: inviteSchema }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/:id/invites',
    async ({ params, body, session, status }) => {
      const { id: guildId } = params;
      if (parseFederatedGuildId(guildId)) {
        return status(400, { error: 'Cannot manage invites on a federated guild' });
      }

      const guild = await db.query.guilds.findFirst({
        where: { id: guildId },
      });
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }
      if (guild.ownerId !== session.userId) {
        return status(403, { error: 'Cannot manage invites for this guild' });
      }

      // deletes prior invite (if any)
      await db
        .delete(guildInvites)
        .where(and(eq(guildInvites.guildId, guildId), eq(guildInvites.creatorId, session.userId)));
      const [invite] = await db
        .insert(guildInvites)
        .values({
          id: randomString(),
          code: randomAlphanumericString(8),
          guildId,
          creatorId: session.userId,
        })
        .returning();
      if (!invite) {
        return status(500, { error: 'Failed to create invite' });
      }

      return { invite: serializeInvite(invite) };
    },
    {
      body: t.Optional(
        t.Object({
          expiresAt: t.Optional(t.String()),
        })
      ),
      response: {
        200: z.object({ invite: inviteSchema }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        500: genericResponseErrorSchema,
      },
    }
  )
  .patch(
    '/order',
    async ({ body, session, status }) => {
      const { guildIds } = body;

      const userMemberships = await db.query.guildMembers.findMany({
        where: { userId: session.userId },
      });

      // not using a difference in case of duplicates and stuff, code by 5.6 sol
      const membershipIds = new Set(userMemberships.map(({ guildId }) => guildId));
      const requestedIds = new Set(guildIds);
      if (
        guildIds.length !== membershipIds.size ||
        requestedIds.size !== guildIds.length ||
        guildIds.some((id) => !membershipIds.has(id))
      ) {
        return status(400, { error: 'Guild list must contain every membership exactly once' });
      }

      await db.transaction(async (tx) => {
        for (const [position, guildId] of guildIds.entries()) {
          await tx
            .update(guildMembers)
            .set({ position })
            .where(and(eq(guildMembers.userId, session.userId), eq(guildMembers.guildId, guildId)));
        }
      });

      return { success: true };
    },
    {
      body: t.Object({
        guildIds: t.Array(t.String()),
      }),
      response: {
        200: successResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
      },
    }
  );

function randomAlphanumericString(length: number): string {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('length must be a non-negative safe integer');
  }

  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += characters[randomInt(characters.length)];
  }

  return result;
}

function serializeInvite(invite: typeof guildInvites.$inferSelect) {
  return {
    ...invite,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt?.toISOString() ?? null,
  };
}
