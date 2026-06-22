import Elysia, { t } from 'elysia';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { randomString } from '../../utils/randomString';
import { db } from '../../prisma/db';
import { publishRealtime } from '../../utils/publishRealtime';

export const message = new Elysia({ prefix: '/message' })
  .resolve(async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }
    return { session };
  })
  .get(
    '/list',
    async ({ query, session, status }) => {
      const { channelId } = query;

      const channel = await db.orm.public.Channel.where({ id: channelId }).first();
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      const membership = await db.orm.public.GuildMember.where({
        guildId: channel.guildId,
        userId: session.userId,
      }).first();
      if (!membership) {
        return status(403, { error: 'Forbidden' });
      }

      const messages = await db.orm.public.Message.where({ channelId })
        .include('author')
        .orderBy((message) => message.createdAt.asc())
        .all();

      return {
        messages: messages.map((message) => ({
          id: message.id,
          channelId: message.channelId,
          guildId: channel.guildId,
          content: message.content,
          nonce: message.nonce,
          createdAt:
            message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
          author: {
            id: message.authorId,
            username: message.author.displayName || message.author.username,
            avatar: message.author.avatarUrl ?? null,
          },
        })),
      };
    },
    {
      query: t.Object({
        channelId: t.String(),
      }),
    }
  )
  .post(
    '/send',
    async ({ body, session, status, server }) => {
      const { channelId, content, nonce } = body;

      const channel = await db.orm.public.Channel.where({ id: channelId }).first();
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      const membership = await db.orm.public.GuildMember.where({
        guildId: channel.guildId,
        userId: session.userId,
      }).first();
      if (!membership) {
        return status(403, { error: 'Forbidden' });
      }

      const priorMsg = await db.orm.public.Message.where({
        authorId: session.userId,
        nonce,
      }).first();
      if (priorMsg) {
        if (priorMsg.channelId !== channelId || priorMsg.content !== content) {
          return status(409, { error: 'Nonce already used for a different message' });
        }

        return { message: priorMsg };
      }

      const message = await db.orm.public.Message.create({
        id: randomString(),
        channelId,
        authorId: session.userId,
        content,
        nonce,
      });

      if (server) {
        publishRealtime(server, `guildEvents:${channel.guildId}`, {
          type: 'message.created',
          data: {
            id: message.id,
            channelId: message.channelId,
            guildId: channel.guildId,
            content: message.content,
            nonce: message.nonce,
            createdAt:
              message.createdAt instanceof Date
                ? message.createdAt.toISOString()
                : message.createdAt,
            author: {
              id: session.userId,
              username: session.user.displayName || session.user.username,
              avatar: session.user.avatarUrl ?? null,
            },
          },
        });
      }

      return { message };
    },
    {
      body: t.Object({
        channelId: t.String(),
        content: t.String(),
        nonce: t.String(),
      }),
    }
  );
