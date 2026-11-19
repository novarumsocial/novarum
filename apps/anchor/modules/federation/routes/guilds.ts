import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import { getConfig } from '../../../utils/config';
import { makeFederatedGuildId } from '../../../utils/federationIds';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { isMessageAfter } from '../../../utils/messageCursor';
import { hostRemoveMember, removeMember } from '../../guilds/membership';
import { getFederatedGuildAccess } from '../access';
import { federationAuth } from '../plugin';
import { federationErrors, successResponseSchema } from '../schemas';

// for each channel: where the user stopped reading (null = never read anything)
const unreadMentionsBodySchema = z.object({
  channels: z
    .array(
      z.object({
        id: z.string().min(1),
        cursor: z.object({ createdAt: z.iso.datetime(), id: z.string().min(1) }).nullable(),
      })
    )
    .max(1000),
});

const removedBodySchema = z.object({
  guildId: z.string().min(1),
  reason: z.enum(['kicked', 'banned']).optional(),
});

export const guilds = new Elysia()
  .use(federationAuth)
  // a user of the remote homeserver leaves one of our guilds
  .post(
    '/guilds/:id/leave',
    async ({ params, remoteUser, server, status }) => {
      const access = await getFederatedGuildAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      // owners are always local, but don't take that on trust
      if (access.guild.ownerId === access.user.id) {
        return status(400, { error: "The owner can't leave the guild" });
      }

      await hostRemoveMember(server, params.id, access.user, undefined, false);
      return { success: true };
    },
    {
      federatedUser: true,
      response: {
        200: successResponseSchema,
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  // the host of a guild kicked or banned one of our users: we drop our copy of it for them.
  // The origin can only do that for guilds it hosts itself.
  .post(
    '/members/:username/removed',
    async ({ params, origin, payload, server, status }) => {
      const body = removedBodySchema.safeParse(payload);
      if (!body.success) return status(400, { error: 'Invalid guild' });
      const user = await db.query.users.findFirst({
        where: { username: params.username, homeserver: getConfig().server.homeserver },
      });
      if (!user) return status(404, { error: 'User not found' });

      const guildId = makeFederatedGuildId(origin.homeserver, body.data.guildId);
      if (await db.query.guildMembers.findFirst({ where: { guildId, userId: user.id } })) {
        await removeMember(server, guildId, user, body.data.reason);
      }
      return { success: true };
    },
    {
      federated: true,
      response: {
        200: successResponseSchema,
        ...federationErrors,
        404: genericResponseErrorSchema,
      },
    }
  )
  // how many unread mentions the user has in channels of our guilds
  .post(
    '/unread-mentions',
    async ({ payload, remoteUser, status }) => {
      const input = unreadMentionsBodySchema.safeParse(payload);
      if (!input.success) return status(400, { error: 'Invalid channels' });

      const user = await db.query.users.findFirst({
        where: { username: remoteUser.username, homeserver: remoteUser.homeserver.toLowerCase() },
      });
      if (!user) return status(403, { error: 'Forbidden' });

      const channelIds = [...new Set(input.data.channels.map((channel) => channel.id))];
      const [memberships, channels] = await Promise.all([
        db.query.guildMembers.findMany({ where: { userId: user.id } }),
        db.query.channels.findMany({ where: { id: { in: channelIds } } }),
      ]);

      // every channel has to exist and belong to a guild the user is in
      const guildIds = new Set(memberships.map((membership) => membership.guildId));
      if (
        channels.length !== channelIds.length ||
        channels.some((channel) => !channel.guildId || !guildIds.has(channel.guildId))
      ) {
        return status(403, { error: 'Forbidden' });
      }

      const pings = await db.query.messagePings.findMany({
        where: { userId: user.id, message: { channelId: { in: channelIds } } },
        with: { message: true },
      });

      // a mention counts as unread when it is newer than the last message the user read there
      const cursors = new Map(input.data.channels.map((channel) => [channel.id, channel.cursor]));
      const mentions = new Map(channelIds.map((id) => [id, 0]));
      for (const { message } of pings) {
        if (isMessageAfter(message, cursors.get(message.channelId) ?? undefined)) {
          mentions.set(message.channelId, mentions.get(message.channelId)! + 1);
        }
      }

      return { channels: channelIds.map((id) => ({ id, mention: mentions.get(id)! })) };
    },
    {
      federatedUser: true,
      response: {
        200: z.object({
          channels: z.array(z.object({ id: z.string(), mention: z.number().int().nonnegative() })),
        }),
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  );
