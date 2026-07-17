import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';
import { parseFederatedGuildId } from '../../utils/federationIds';
import { isMessageAfter } from '../../utils/messageCursor';
import { ensureFederatedGuildRealtimeBridge } from '../../utils/federationRealtime';
import { storage } from '../../utils/services/storage';
import { getConfig } from '../../utils/config';
import { randomInt } from 'node:crypto';

const maxAvatarSize = getConfig().files.max_avatar_size * 1024 * 1024;

export const guilds = new Elysia({ prefix: '/guilds' })
  .get('/avatar/:id', async ({ params, query, status }) => {
    const guild = await db.orm.public.Guild.where({ id: params.id }).first();
    if (!guild?.avatarUrl) return status(404, { error: 'Guild picture not found' });

    const format = query.format === 'gif' ? 'gif' : 'png';
    const type = format === 'gif' ? 'image/gif' : 'image/png';
    const url = storage.presign(`guild-avatars/${guild.id}.${format}`, {
      method: 'GET',
      expiresIn: 5 * 60,
      type,
      contentDisposition: 'inline',
    });

    return Response.redirect(url);
  })
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

      const guild = await db.orm.public.Guild.where({ id: params.id }).first();
      if (!guild) return status(404, { error: 'Guild not found' });
      if (guild.ownerId !== session.userId) return status(403, { error: 'Forbidden' });
      if (body.avatar.type !== 'image/png' && body.avatar.type !== 'image/gif') {
        return status(415, { error: 'Guild picture must be a PNG or GIF image' });
      }
      if (body.avatar.size > maxAvatarSize) {
        return status(413, { error: 'Guild picture is too large' });
      }

      const format = body.avatar.type === 'image/gif' ? 'gif' : 'png';
      await storage.write(`guild-avatars/${guild.id}.${format}`, body.avatar, {
        type: body.avatar.type,
      });

      const avatarUrl = new URL(
        `/guilds/avatar/${encodeURIComponent(guild.id)}?format=${format}&v=${Date.now()}`,
        getConfig().server.baseUrl
      ).toString();
      await db.orm.public.Guild.where({ id: guild.id }).update({ avatarUrl });

      return { avatarUrl };
    },
    {
      body: t.Object({
        avatar: t.File({ maxSize: maxAvatarSize }),
      }),
    }
  )
  .post(
    '/create',
    async ({ body, server, session }) => {
      const { name } = body;

      const transaction = await db.transaction(async (tx) => {
        const guild = await tx.orm.public.Guild.create({
          id: randomString(),
          name,
          ownerId: session.userId,
          extAnchorDown: false,
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
    const readStates = await db.orm.public.ChannelReadState.where({ userId: session.userId }).all();
    const readStateByChannel = new Map(readStates.map((state) => [state.channelId, state]));
    const pings = await db.orm.public.MessagePing.where({ userId: session.userId }).all();
    const unreadPingsByChannel = new Map<string, number>();

    for (const ping of pings) {
      const message = await db.orm.public.Message.where({ id: ping.messageId }).first();
      if (!message) continue;

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

    const guilds = [];

    for (const { guild } of memberships) {
      const id = guild.id as string;
      const channels = await db.orm.public.Channel.where({ guildId: id })
        .orderBy((channel) => channel.position.asc())
        .all();

      guilds.push({
        id,
        name: guild.name as string,
        down: guild.extAnchorDown as boolean,
        avatarUrl: guild.avatarUrl as string | null,
        description: guild.description as string | null,
        channels: await Promise.all(
          channels.map(async (channel) => {
            const latestMessage = await db.orm.public.Message.where({ channelId: channel.id })
              .orderBy([(message) => message.createdAt.desc(), (message) => message.id.desc()])
              .first();
            const readState = readStateByChannel.get(channel.id);

            if (latestMessage && !readState) {
              await db.orm.public.ChannelReadState.upsert({
                create: {
                  userId: session.userId,
                  channelId: channel.id,
                  lastReadCreatedAt: latestMessage.createdAt,
                  lastReadMessageId: latestMessage.id,
                },
                update: {},
              });
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
      if (guild.ownerId !== session.userId) {
        return { error: 'Cannot manage invites for this guild' };
      }

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
