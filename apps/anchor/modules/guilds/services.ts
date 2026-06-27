import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';
import { parseFederatedGuildId } from '../../utils/federationIds';
import { ensureFederatedGuildRealtimeBridge } from '../../utils/federationRealtime';

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
  .get('/list', async ({ server, session }) => {
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

      if (server && parseFederatedGuildId(id)) {
        void ensureFederatedGuildRealtimeBridge(server, id);
      }
    }

    return { guilds };
  })
  // right now, invites work as follows:
  // - a user can create only one invite per guild
  // - when regenerating it, the old invite is deleted and a new one is created
  // this should probably be changed in the future but it should be fine for now
  .get('/:id/invites', async ({ params, session, status }) => {
    const { id: guildId } = params;
    if (parseFederatedGuildId(guildId)) {
      return status(400, { error: 'Cannot manage invites on a federated guild' });
    }

    const guild = await db.orm.public.Guild.where({ id: guildId }).first();
    if (!guild) {
      return status(404, { error: 'Guild not found' });
    }
    if (guild.ownerId !== session.userId) {
      return status(401, { error: 'Unauthorized' });
    }

    const invite = await db.orm.public.GuildInvite.where({ guildId })
      .where({ creatorId: session.userId })
      // there should only be one but okay
      .first();

    if (!invite) {
      return status(404, { error: 'No invite found for this guild' });
    }

    return { invite };
  })
  .post(
    '/:id/invites',
    async ({ params, body, session }) => {
      const { id: guildId } = params;
      if (parseFederatedGuildId(guildId)) {
        return { error: 'Cannot manage invites on a federated guild' };
      }

      const guild = await db.orm.public.Guild.where({ id: guildId }).first();
      if (!guild) {
        return { error: 'Guild not found' };
      }
      /* idk if i should keep this check or not, too tired
       if (guild.ownerId !== session.userId) {
        return { error: 'Unauthorized' };
      } */

      // deletes prior invite (if any)
      await db.orm.public.GuildInvite.where({ guildId })
        .where({ creatorId: session.userId })
        .delete();

      const invite = await db.orm.public.GuildInvite.create({
        id: randomString(),
        code: randomAlphanumericString(8),
        guildId,
        creatorId: session.userId,
        // expiresAt: body?.expiresAt ? new Date(body.expiresAt) : null,
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
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }
  return result;
}
