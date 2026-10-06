import Elysia from 'elysia';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, guildMembers } from '../../../src/db';
import {
  channelResponseSchema,
  federatedGuildResponseSchema,
  guildInviteResponseSchema,
} from '../../../src/db/zod';
import { getConfig } from '../../../utils/config';
import { upsertFederatedUser } from '../../../utils/federationPayload';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { publicUser } from '../../../utils/publicUser';
import { publishRealtime } from '../../../utils/publishRealtime';
import { federationAuth } from '../plugin';
import { federationErrors } from '../schemas';

const isExpired = (expiresAt: Date | null) => !!expiresAt && expiresAt.getTime() <= Date.now();

// how a guild looks to the homeserver of someone joining it
const guildSummary = (guild: {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
}) => ({
  id: guild.id,
  homeserver: getConfig().server.homeserver,
  name: guild.name,
  description: guild.description,
  avatarUrl: guild.avatarUrl,
});

export const invites = new Elysia()
  .use(federationAuth)
  // a preview of the guild behind an invite, so the other homeserver can show it before joining
  .get(
    '/invites/:code',
    async ({ params, status }) => {
      const invite = await db.query.guildInvites.findFirst({ where: { code: params.code } });
      if (!invite || isExpired(invite.expiresAt)) return status(404, { error: 'Invite not found' });

      const guild = await db.query.guilds.findFirst({ where: { id: invite.guildId } });
      if (!guild) return status(404, { error: 'Guild not found' });

      return {
        invite: { code: invite.code, expiresAt: invite.expiresAt?.toISOString() ?? null },
        guild: {
          ...guildSummary(guild),
          memberCount: await db.$count(guildMembers, eq(guildMembers.guildId, guild.id)),
        },
      };
    },
    {
      response: {
        200: z.object({
          invite: guildInviteResponseSchema.pick({ code: true, expiresAt: true }),
          guild: federatedGuildResponseSchema.extend({
            memberCount: z.number().int().nonnegative(),
          }),
        }),
        404: genericResponseErrorSchema,
      },
    }
  )
  // a user of the remote homeserver joins one of our guilds
  .post(
    '/invites/:code/accept',
    async ({ params, remoteUser, server, status }) => {
      if (remoteUser.homeserver.toLowerCase() === getConfig().server.homeserver.toLowerCase()) {
        return status(400, { error: 'Use local invite accept for local users' });
      }

      const invite = await db.query.guildInvites.findFirst({ where: { code: params.code } });
      if (!invite || isExpired(invite.expiresAt)) return status(404, { error: 'Invite not found' });

      const guild = await db.query.guilds.findFirst({ where: { id: invite.guildId } });
      if (!guild) return status(404, { error: 'Guild not found' });

      const user = await upsertFederatedUser(remoteUser);
      const membership = await db.query.guildMembers.findFirst({
        where: { guildId: guild.id, userId: user.id },
      });

      if (!membership) {
        await db.transaction(async (tx) => {
          // every guild moves down one place so the new one can go to the top of their list
          await tx
            .update(guildMembers)
            .set({ position: sql`${guildMembers.position} + 1` })
            .where(eq(guildMembers.userId, user.id));
          await tx.insert(guildMembers).values({
            guildId: guild.id,
            userId: user.id,
            role: 'MEMBER',
            position: 0,
          });
        });

        if (server) {
          publishRealtime(server, `guildEvents:${guild.id}`, {
            type: 'member.joined',
            data: {
              guildId: guild.id,
              user: { ...publicUser(user), status: user.status as 'ONLINE' | 'OFFLINE' },
            },
          });
        }
      }

      const channels = await db.query.channels.findMany({
        where: { guildId: guild.id },
        orderBy: { position: 'asc' },
      });

      return {
        guild: guildSummary(guild),
        channels: channels.map((channel) => ({
          id: channel.id,
          guildId: guild.id,
          name: channel.name,
          position: channel.position,
          type: channel.type as 'TEXT' | 'VOICE',
        })),
      };
    },
    {
      federatedUser: true,
      response: {
        200: z.object({
          guild: federatedGuildResponseSchema,
          channels: z.array(channelResponseSchema),
        }),
        ...federationErrors,
        404: genericResponseErrorSchema,
      },
    }
  );
