import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';

export const guilds = new Elysia({ prefix: '/guilds' })
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
    async ({ body, server, session }) => {
      const { name } = body;

      const transaction = await db.transaction(async (tx) => {
        const guild = await tx.orm.public.Guild.create({
          id: randomString(),
          name,
          ownerId: session.userId,
        });

        await tx.orm.public.GuildMember.create({
          guildId: guild.id,
          userId: session.userId,
          role: 'OWNER',
        });

        // default general channel for the guild
        const defChannel = await tx.orm.public.Channel.create({
          // todo: this is probably no good and need to come up with a better way to generate channel ids
          id: randomString(),
          name: 'general',
          position: 0,
          guildId: guild.id,
        });

        return { guild, channel: defChannel };
      });

      const { guild, channel } = transaction;

      if (server) {
        publishRealtime(server, `userEvents:${session.userId}`, {
          type: 'guild.created',
          data: {
            id: guild.id,
            name: guild.name,
            ownerId: guild.ownerId,
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

      return { guild };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
      }),
    }
  )
  .get('/list', async ({ session }) => {
    const memberships = await db.orm.public.GuildMember.where({ userId: session.userId })
      .include('guild')
      .all();

    const guilds = [];

    for (const { guild } of memberships) {
      const id = guild.id as string;
      const channels = await db.orm.public.Channel.where({ guildId: id })
        .orderBy((channel) => channel.position.asc())
        .all();

      guilds.push({
        id,
        name: guild.name as string,
        channels: channels.map((channel) => ({
          id: channel.id,
          guildId: channel.guildId,
          name: channel.name,
          position: channel.position,
          type: channel.type as 'TEXT' | 'VOICE',
        })),
      });
    }

    return { guilds };
  })
  .post(
    '/:id/invite',
    async ({ params, body, session }) => {
      const { id: guildId } = params;

      const guild = await db.orm.public.Guild.where({ id: guildId }).first();
      if (!guild) {
        return { error: 'Guild not found' };
      }
      if (guild.ownerId !== session.userId) {
        return { error: 'Unauthorized' };
      }

      const invite = await db.orm.public.GuildInvite.create({
        id: randomString(),
        code: randomAlphanumericString(8),
        guildId,
        creatorId: session.userId,
        expiresAt: body?.expiresAt ? new Date(body.expiresAt) : null,
      });

      return { invite };
    },
    {
      body: t.Optional(
        t.Object({
          expiresAt: t.Optional(t.String()),
        })
      ),
    }
  );

function randomAlphanumericString(length: number) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }
  return result;
}