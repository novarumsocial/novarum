import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';
import type { DefaultModelRow } from '@prisma-next/sql-orm-client';
import type { Contract } from '../../prisma/contract';
import { parseFederatedChannelId, parseFederatedGuildId } from '../../utils/federationIds';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload } from '../../utils/federationPayload';

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
    async ({ body, session, server, status }) => {
      const { name, guildId, type } = body;
      if (parseFederatedGuildId(guildId)) {
        return status(400, { error: 'Cannot create channels on a federated guild' });
      }

      const guild = await db.orm.public.Guild.where({ id: guildId }).first();
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
        publishRealtime(server, `guildEvents:${guildId}`, {
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
  )
  .get(
    '/:id/users',
    async ({ params, session, status }) => {
      const channel = await db.orm.public.Channel.where({ id: params.id }).first();
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      const membership = await db.orm.public.GuildMember.where({
        guildId: channel.guildId,
        userId: session.userId,
      }).first();
      if (!membership) {
        return status(401, { error: 'Unauthorized' });
      }

      const federatedChannel = parseFederatedChannelId(params.id);
      if (federatedChannel) {
        const result = await postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/users`,
          { user: federationUserPayload(session) }
        ).catch(() => null);

        if (!result) return status(502, { error: 'Could not reach remote homeserver' });
        if (!result.response.ok) {
          return status(remoteStatus(result.response.status), result.data ?? { error: 'Remote users failed' });
        }
        if (!result.data || typeof result.data !== 'object' || !Array.isArray((result.data as any).users)) {
          return status(502, { error: 'Remote users returned an invalid response' });
        }

        return result.data;
      }

      const members = (await db.orm.public.GuildMember.where({ guildId: channel.guildId })
        .include('user')
        .all()) as ActuallyTypedMembers[];

      const users = members.map((member) => ({
        userId: member.user.id as string,
        username: member.user.username as string,
        displayName: member.user.displayName as string,
        homeserver: member.user.homeserver as string,
        avatarUrl: (member.user.avatarUrl as string | null) ?? undefined,
        isBot: member.user.isBot as boolean,
        status: member.user.status as 'ONLINE' | 'OFFLINE',
        role: member.role as 'OWNER' | 'ADMIN' | 'MEMBER',
        joinedAt: member.joinedAt as Date,
      }));

      return { users };
    },
    {
      response: {
        200: t.Object({
          users: t.Array(
            t.Object({
              userId: t.String(),
              username: t.String(),
              displayName: t.String(),
              homeserver: t.String(),
              avatarUrl: t.Optional(t.String()),
              isBot: t.Boolean(),
              status: t.Enum({ ONLINE: 'ONLINE', OFFLINE: 'OFFLINE' }),
              role: t.Enum({ OWNER: 'OWNER', ADMIN: 'ADMIN', MEMBER: 'MEMBER' }),
              joinedAt: t.Date(),
            })
          ),
        }),
        404: t.Object({
          error: t.String(),
        }),
        401: t.Object({
          error: t.String(),
        }),
        502: t.Object({
          error: t.String(),
        }),
      },
    }
  );

function remoteStatus(status: number) {
  if (status === 404) return 404;
  if (status === 401 || status === 403) return 401;
  return 502;
}

type ActuallyTypedMembers = DefaultModelRow<Contract, 'GuildMember'> & {
  user: DefaultModelRow<Contract, 'Users'>;
};
