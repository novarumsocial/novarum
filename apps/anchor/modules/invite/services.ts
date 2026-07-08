import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { postSignedFederationJson } from '../../utils/discovery';
import { getConfig } from '../../utils/config';
import { makeFederatedChannelId, makeFederatedGuildId } from '../../utils/federationIds';
import { federationUserPayload } from '../../utils/federationPayload';
import { publishRealtime } from '../../utils/publishRealtime';
import { ensureFederatedGuildRealtimeBridge } from '../../utils/federationRealtime';

export const invite = new Elysia({ prefix: '/invite' })
  .get('/:code', async ({ params, status }) => {
    const { code } = params;

    const invite = await db.orm.public.GuildInvite.where({ code }).include('creator').first();
    if (!invite || isExpired(invite.expiresAt)) {
      return status(404, { error: 'Invite not found' });
    }

    const guild = await db.orm.public.Guild.where({ id: invite.guildId }).first();
    if (!guild) {
      return status(404, { error: 'Guild not found' });
    }

    const members = await db.orm.public.GuildMember.where({ guildId: guild.id }).all();

    return {
      invite,
      guild: {
        id: guild.id,
        name: guild.name,
        description: guild.description,
        avatarUrl: guild.avatarUrl,
        memberCount: members.length,
      },
    };
  })
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
          return status(response.status, data ?? { error: 'Remote invite accept failed' });
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
              channels: federatedInvite.channels,
            },
          });
        }

        return federatedInvite;
      }

      const invite = await db.orm.public.GuildInvite.where({ code: body.code }).first();
      if (!invite || isExpired(invite.expiresAt)) {
        return status(404, { error: 'Invite not found' });
      }

      const guild = await db.orm.public.Guild.where({ id: invite.guildId }).first();
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }

      const membership = await db.orm.public.GuildMember.where({
        guildId: invite.guildId,
        userId: session.userId,
      }).first();
      if (!membership) {
        await db.orm.public.GuildMember.create({
          guildId: invite.guildId,
          userId: session.userId,
          role: 'MEMBER',
        });

        if (server) {
          publishRealtime(server, `guildEvents:${invite.guildId}`, {
            type: 'member.joined',
            data: {
              guildId: invite.guildId,
              user: {
                userId: session.userId,
                username: session.user.username,
                displayName: session.user.displayName,
                homeserver: session.user.homeserver,
                isBot: session.user.isBot,
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
    }
  );

function isExpired(expiresAt: Date | string | null | undefined) {
  return expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
}

async function guildChannels(guildId: string) {
  const channels = await db.orm.public.Channel.where({ guildId })
    .orderBy((channel) => channel.position.asc())
    .all();

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
  const existingGuild = await db.orm.public.Guild.where({ id: guildId }).first();

  if (existingGuild) {
    await db.orm.public.Guild.where({ id: guildId }).update({
      name: snapshot.guild.name,
      description: snapshot.guild.description,
      avatarUrl: snapshot.guild.avatarUrl,
    });
  } else {
    await db.orm.public.Guild.create({
      id: guildId,
      name: snapshot.guild.name,
      description: snapshot.guild.description,
      avatarUrl: snapshot.guild.avatarUrl,
      ownerId: session.userId,
      extAnchorDown: false,
    });
  }

  const membership = await db.orm.public.GuildMember.where({
    guildId,
    userId: session.userId,
  }).first();
  if (!membership) {
    await db.orm.public.GuildMember.create({
      guildId,
      userId: session.userId,
      role: 'MEMBER',
    });
  }

  const channels = [];
  for (const channel of snapshot.channels) {
    const channelId = makeFederatedChannelId(homeserver, channel.id);
    const existingChannel = await db.orm.public.Channel.where({ id: channelId }).first();

    if (existingChannel) {
      await db.orm.public.Channel.where({ id: channelId }).update({
        guildId,
        name: channel.name,
        position: channel.position,
        type: channel.type,
      });
    } else {
      await db.orm.public.Channel.create({
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
