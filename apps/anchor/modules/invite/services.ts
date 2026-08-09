import Elysia, { t } from 'elysia';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { postSignedFederationJson } from '../../utils/discovery';
import { getConfig } from '../../utils/config';
import { makeFederatedChannelId, makeFederatedGuildId } from '../../utils/federationIds';
import { federationUserPayload } from '../../utils/federationPayload';
import { publishRealtime } from '../../utils/publishRealtime';
import { ensureFederatedGuildRealtimeBridge } from '../../utils/federationRealtime';
import { db, guildMembers, guilds, channels as dbChannels } from '../../src/db';
import { and, eq, sql } from 'drizzle-orm';
import { publicUser, publicUserSchema } from '../../utils/publicUser';
import { z } from 'zod';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import {
  channelResponseSchema,
  federatedGuildResponseSchema,
  guildInviteResponseSchema,
  guildResponseSchema,
  userSelectSchema,
} from '../../src/db/zod';

const remoteErrorSchema = z.object({ error: z.string() });
const inviteResponseSchema = z.object({
  invite: guildInviteResponseSchema.extend({
    creator: publicUserSchema.omit({ userId: true }).extend({
      id: userSelectSchema.shape.id,
      isHomeserverAdmin: userSelectSchema.shape.isHomeserverAdmin,
      createdAt: userSelectSchema.shape.createdAt,
      updatedAt: userSelectSchema.shape.updatedAt,
      status: userSelectSchema.shape.status,
    }),
  }),
  guild: guildResponseSchema
    .pick({
      id: true,
      name: true,
      description: true,
      avatarUrl: true,
    })
    .extend({
      avatarUrl: z.url().nullable(),
      memberCount: z.number().int().nonnegative(),
    }),
});
const acceptedInviteResponseSchema = z.object({
  guildId: z.string(),
  guild: federatedGuildResponseSchema.optional(),
  channels: z.array(channelResponseSchema).optional(),
});

export const invite = new Elysia({ prefix: '/invite', tags: ['Invite'] })
  .get(
    '/:code',
    async ({ params, status }) => {
      const { code } = params;

      const invite = await db.query.guildInvites.findFirst({
        where: { code },
        with: { creator: true },
      });
      if (!invite || isExpired(invite.expiresAt)) {
        return status(404, { error: 'Invite not found' });
      }

      const guild = await db.query.guilds.findFirst({
        where: { id: invite.guildId },
      });
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }

      const members = await db.query.guildMembers.findMany({
        where: { guildId: guild.id },
      });

      return {
        invite: {
          ...invite,
          createdAt: invite.createdAt.toISOString(),
          expiresAt: invite.expiresAt?.toISOString() ?? null,
          creator: {
            ...invite.creator,
            createdAt: invite.creator.createdAt.toISOString(),
            updatedAt: invite.creator.updatedAt.toISOString(),
          },
        },
        guild: {
          id: guild.id,
          name: guild.name,
          description: guild.description,
          avatarUrl: guild.avatarUrl,
          memberCount: members.length,
        },
      };
    },
    {
      response: {
        200: inviteResponseSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/accept',
    async ({ body, cookie, server, status }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) {
        return status(401, { error: 'Unauthorized' });
      }

      if (body.homeserver && body.homeserver !== getConfig().server.homeserver) {
        const path = `/federation/invites/${encodeURIComponent(body.code)}/accept`;
        const federationResponse = await postSignedFederationJson(body.homeserver, path, {
          user: federationUserPayload(session),
        }).catch(() => null);
        if (!federationResponse) {
          return status(502, { error: 'Could not reach remote homeserver' });
        }

        const { data, remote, response } = federationResponse;

        if (!response.ok) {
          const remoteError = remoteErrorSchema.safeParse(data);
          const remoteStatus = [400, 401, 404, 500].includes(response.status)
            ? (response.status as 400 | 401 | 404 | 500)
            : 502;
          return status(
            remoteStatus,
            remoteError.success ? remoteError.data : { error: 'Remote invite accept failed' }
          );
        }

        const federatedInvite = await persistFederatedInviteSnapshot(
          session,
          remote.homeserver,
          data
        );
        if (!federatedInvite) {
          return status(502, { error: 'Remote invite accept returned an invalid guild snapshot' });
        }

        if (server) {
          void ensureFederatedGuildRealtimeBridge(server, federatedInvite.guild.id).catch(
            () => null
          );

          publishRealtime(server, `userEvents:${session.userId}`, {
            type: 'guild.created',
            data: {
              id: federatedInvite.guild.id,
              name: federatedInvite.guild.name,
              ownerId: session.userId,
              avatarUrl: federatedInvite.guild.avatarUrl,
              description: federatedInvite.guild.description,
              channels: federatedInvite.channels,
            },
          });
        }

        return federatedInvite;
      }

      const invite = await db.query.guildInvites.findFirst({
        where: { code: body.code },
      });
      if (!invite || isExpired(invite.expiresAt)) {
        return status(404, { error: 'Invite not found' });
      }

      const guild = await db.query.guilds.findFirst({
        where: { id: invite.guildId },
      });
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }

      const membership = await db.query.guildMembers.findFirst({
        where: { guildId: invite.guildId, userId: session.userId },
      });
      if (!membership) {
        await db.transaction(async (tx) => {
          // increase by one so we can put the guild at position 0
          await tx
            .update(guildMembers)
            .set({ position: sql`${guildMembers.position} + 1` })
            .where(and(eq(guildMembers.userId, session.userId)));

          await tx.insert(guildMembers).values({
            guildId: invite.guildId,
            userId: session.userId,
            role: 'MEMBER',
            position: 0,
          });
        });

        if (server) {
          publishRealtime(server, `guildEvents:${invite.guildId}`, {
            type: 'member.joined',
            data: {
              guildId: invite.guildId,
              user: {
                ...publicUser(session.user),
                status: session.user.status as 'ONLINE' | 'OFFLINE',
              },
            },
          });

          publishRealtime(server, `userEvents:${session.userId}`, {
            type: 'guild.created',
            data: {
              id: guild.id,
              name: guild.name,
              ownerId: guild.ownerId,
              avatarUrl: guild.avatarUrl,
              description: guild.description,
              channels: await guildChannels(guild.id),
            },
          });
        }
      }

      return { guildId: invite.guildId };
    },
    {
      body: t.Object({
        code: t.String({ minLength: 1 }),
        homeserver: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
      }),
      response: {
        200: acceptedInviteResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        500: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  );

function isExpired(expiresAt: Date | string | null | undefined) {
  return expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
}

async function guildChannels(guildId: string) {
  const channels = await db.query.channels.findMany({
    where: { guildId },
    orderBy: { position: 'asc' },
  });

  return channels.map((channel) => ({
    id: channel.id,
    guildId: channel.guildId,
    name: channel.name,
    position: channel.position,
    type: channel.type as 'TEXT' | 'VOICE',
  }));
}

type Session = NonNullable<Awaited<ReturnType<typeof validateSessionToken>>>;

type RemoteInviteAccept = {
  guild: {
    id: string;
    homeserver: string;
    name: string;
    description: string | null;
    avatarUrl: string | null;
  };
  channels: Array<{
    id: string;
    guildId: string;
    name: string;
    position: number;
    type: 'TEXT' | 'VOICE';
  }>;
};

async function persistFederatedInviteSnapshot(session: Session, homeserver: string, data: unknown) {
  const snapshot = parseRemoteInviteAccept(data, homeserver);
  if (!snapshot) return null;

  const guildId = makeFederatedGuildId(homeserver, snapshot.guild.id);
  const existingGuild = await db.query.guilds.findFirst({
    where: { id: guildId },
  });

  if (existingGuild) {
    await db
      .update(guilds)
      .set({
        name: snapshot.guild.name,
        description: snapshot.guild.description,
        avatarUrl: snapshot.guild.avatarUrl,
      })
      .where(eq(guilds.id, guildId));
  } else {
    await db.insert(guilds).values({
      id: guildId,
      name: snapshot.guild.name,
      description: snapshot.guild.description,
      avatarUrl: snapshot.guild.avatarUrl,
      ownerId: session.userId,
      extAnchorDown: false,
    });
  }

  const membership = await db.query.guildMembers.findFirst({
    where: { guildId, userId: session.userId },
  });
  if (!membership) {
    await db.transaction(async (tx) => {
      // increase by one so we can put the guild at position 0
      await tx
        .update(guildMembers)
        .set({ position: sql`${guildMembers.position} + 1` })
        .where(and(eq(guildMembers.userId, session.userId)));

      await tx.insert(guildMembers).values({
        guildId,
        userId: session.userId,
        role: 'MEMBER',
        position: 0,
      });
    });
  }

  const channels = [];
  for (const channel of snapshot.channels) {
    const channelId = makeFederatedChannelId(homeserver, channel.id);
    const existingChannel = await db.query.channels.findFirst({
      where: { id: channelId },
    });

    if (existingChannel) {
      await db
        .update(dbChannels)
        .set({
          guildId,
          name: channel.name,
          position: channel.position,
          type: channel.type,
        })
        .where(eq(dbChannels.id, channelId));
    } else {
      await db.insert(dbChannels).values({
        id: channelId,
        guildId,
        name: channel.name,
        position: channel.position,
        type: channel.type,
      });
    }

    channels.push({
      ...channel,
      id: channelId,
      guildId,
    });
  }

  return {
    guildId,
    guild: {
      ...snapshot.guild,
      id: guildId,
      homeserver,
    },
    channels,
  };
}

function parseRemoteInviteAccept(
  data: unknown,
  expectedHomeserver: string
): RemoteInviteAccept | null {
  if (!data || typeof data !== 'object') return null;

  const guild = property(data, 'guild');
  const channels = property(data, 'channels');
  if (!guild || typeof guild !== 'object' || !Array.isArray(channels)) return null;

  const id = property(guild, 'id');
  const homeserver = property(guild, 'homeserver');
  const name = property(guild, 'name');
  const description = property(guild, 'description');
  const avatarUrl = property(guild, 'avatarUrl');

  if (
    typeof id !== 'string' ||
    typeof homeserver !== 'string' ||
    homeserver.toLowerCase() !== expectedHomeserver ||
    typeof name !== 'string' ||
    (description !== null && typeof description !== 'string') ||
    (avatarUrl !== null && typeof avatarUrl !== 'string')
  ) {
    return null;
  }

  const parsedChannels: RemoteInviteAccept['channels'] = [];
  for (const channel of channels) {
    if (!channel || typeof channel !== 'object') return null;

    const channelId = property(channel, 'id');
    const guildId = property(channel, 'guildId');
    const channelName = property(channel, 'name');
    const position = property(channel, 'position');
    const type = property(channel, 'type');

    if (
      typeof channelId !== 'string' ||
      typeof guildId !== 'string' ||
      guildId !== id ||
      typeof channelName !== 'string' ||
      typeof position !== 'number' ||
      (type !== 'TEXT' && type !== 'VOICE')
    ) {
      return null;
    }

    parsedChannels.push({
      id: channelId,
      guildId,
      name: channelName,
      position,
      type,
    });
  }

  return {
    guild: {
      id,
      homeserver,
      name,
      description,
      avatarUrl,
    },
    channels: parsedChannels,
  };
}

function property(value: unknown, key: string) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
