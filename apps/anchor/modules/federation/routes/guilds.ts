import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { isMessageAfter } from '../../../utils/messageCursor';
import { federationAuth } from '../plugin';
import { federationErrors } from '../schemas';

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

export const guilds = new Elysia()
  .use(federationAuth)
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
