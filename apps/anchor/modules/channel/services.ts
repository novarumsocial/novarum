import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';

export const channel = new Elysia({ prefix: '/channel' })
  .resolve(async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }
    return { session };
  })
  .post(
    '/create',
    async ({ body, session, server }) => {
      const { name, guildId, type } = body;

      const guild = await db.orm.public.Guild.where({ id: guildId })
        .include('members', (member) => member.where({ userId: session.userId }))
        .first();
      if (!guild) {
        return { error: 'Guild not found' };
      }
      if (guild.ownerId !== session.userId) {
        return { error: 'Unauthorized' };
      }

      const channel = await db.orm.public.Channel.create({
        id: randomString(),
        name,
        type,
        position: 0,
        guildId,
      });

			if (server) {
				publishRealtime(server, `channelEvents:${session.userId}`, {
					type: 'channel.created',
					data: {
						id: channel.id,
						name: channel.name,
						position: channel.position,
						type: channel.type as 'TEXT' | 'VOICE',
						guildId: channel.guildId,
					},
				});
			}

      return channel;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        type: t.Enum({ TEXT: 'TEXT', VOICE: 'VOICE' }),
        guildId: t.String(),
      }),
    }
  );
