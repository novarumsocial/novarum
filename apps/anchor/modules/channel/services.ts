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
import { getConfig } from '../../utils/config';
import { AccessToken } from 'livekit-server-sdk';
import {
  livekitServiceClient,
  livekitWebhookReceiver,
  removeVoicePresence,
  setVoicePresence,
} from '../../utils/services/livekit';
import { z } from 'zod';
import { parseJson } from '../../utils/parseJson';

const remoteErrorSchema = z.object({ error: z.string() });
const callTokenResponseSchema = z.object({ serverUrl: z.string(), token: z.string() });
const livekitMetadataSchema = z.object({ channelId: z.string().optional() });

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
          const remoteError = remoteErrorSchema.safeParse(result.data);
          const error = remoteError.success ? remoteError.data : { error: 'Remote users failed' };

          if (result.response.status === 404) return status(404, error);
          if (result.response.status === 401 || result.response.status === 403) {
            return status(401, error);
          }

          return status(502, error);
        }
        if (
          !result.data ||
          typeof result.data !== 'object' ||
          !Array.isArray((result.data as any).users)
        ) {
          return status(502, { error: 'Remote users returned an invalid response' });
        }

        return result.data as ChannelUsersResponse;
      }

      const members = (await db.orm.public.GuildMember.where({ guildId: channel.guildId })
        .include('user')
        .all()) as ActuallyTypedMembers[];

      const users = members.map((member) => ({
        userId: member.user.id as string,
        username: member.user.username as string,
        displayName: member.user.displayName as string | null,
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
              displayName: t.Union([t.String(), t.Null()]),
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
  )
  .get('/:id/call/token', async ({ params, session, status }) => {
    const voiceConfig = getConfig().voice;
    const federatedChannel = parseFederatedChannelId(params.id);
    if (federatedChannel) {
      const result = await postSignedFederationJson(
        federatedChannel.homeserver,
        `/federation/channels/${encodeURIComponent(federatedChannel.id)}/call/token`,
        { user: federationUserPayload(session) }
      ).catch(() => null);

      if (!result) return status(502, { error: 'Could not reach remote homeserver' });
      if (!result.response.ok) {
        const remoteError = remoteErrorSchema.safeParse(result.data);
        const remoteStatus = [401, 403, 404].includes(result.response.status)
          ? (result.response.status as 401 | 403 | 404)
          : 502;
        return status(
          remoteStatus,
          remoteError.success ? remoteError.data : { error: 'Remote call token failed' }
        );
      }
      const callToken = callTokenResponseSchema.safeParse(result.data);
      if (!callToken.success) {
        return status(502, { error: 'Remote call token returned an invalid response' });
      }

      return callToken.data;
    }

    const channel = await db.orm.public.Channel.where({ id: params.id }).first();
    if (!channel || channel.type !== 'VOICE') {
      return status(404, { error: 'Channel not right' });
    }

    const membership = await db.orm.public.GuildMember.where({
      guildId: channel.guildId,
      userId: session.userId,
    }).first();
    if (!membership) {
      return status(401, { error: 'Unauthorized' });
    }

    const token = new AccessToken(voiceConfig.livekit_key, voiceConfig.livekit_secret, {
      identity: session.userId,
      name: session.user.displayName || session.user.username,
      ttl: '5m',
      metadata: JSON.stringify({
        channelId: channel.id,
        guildId: channel.guildId,
        userId: session.userId,
      }),
    });

    token.addGrant({
      roomJoin: true,
      room: `voice:${channel.id}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return {
      serverUrl: voiceConfig.livekit_url,
      token: await token.toJwt(),
    };
  })
  .get('/:id/call/participants', async ({ params, session, status }) => {
    const channel = await db.orm.public.Channel.where({ id: params.id }).first();
    if (!channel || channel.type !== 'VOICE') {
      return status(404, { error: 'Channel not right' });
    }

    const channelMembership = await db.orm.public.GuildMember.where({
      guildId: channel.guildId,
      userId: session.userId,
    }).first();
    if (!channelMembership) {
      return status(401, { error: 'Unauthorized' });
    }

    const participants = await livekitServiceClient.listParticipants(`voice:${channel.id}`);

    return {
      participants: participants.map((p) => ({
        identity: p.identity,
        name: p.name,
        metadata: p.metadata,
      })),
    };
  })
  .post('/livekit/webhook', async ({ request, headers, server }) => {
    const event = await livekitWebhookReceiver.receive(
      await request.text(),
      headers.authorization ?? ''
    );

    const userId = event.participant?.identity;
    if (!userId) return { ok: true };

    if (event.event === 'participant_left') {
      const previous = removeVoicePresence(userId);
      if (previous && server) {
        publishRealtime(server, `guildEvents:${previous.guildId}`, {
          type: 'voice.state.changed',
          data: { ...previous, connected: false },
        });
      }
      return { ok: true };
    }

    if (event.event !== 'participant_joined') return { ok: true };

    // holy crap this code...
    const metadata = livekitMetadataSchema.safeParse(
      parseJson(event.participant?.metadata ?? '{}')
    );
    const channelId =
      (!metadata.error && metadata.data.channelId) ?? event.room?.name?.replace(/^voice:/, '');
    if (!channelId) return { ok: true };

    const channel = await db.orm.public.Channel.where({ id: channelId }).first();
    if (!channel) return { ok: true };

    const state = {
      guildId: channel.guildId,
      channelId: channel.id,
      userId,
      name: event.participant?.name ?? null,
    };

    setVoicePresence(state);
    if (server) {
      publishRealtime(server, `guildEvents:${state.guildId}`, {
        type: 'voice.state.changed',
        data: { ...state, connected: true },
      });
    }

    return { ok: true };
  });

type ChannelUsersResponse = {
  users: ChannelUser[];
};

type ChannelUser = {
  userId: string;
  username: string;
  displayName: string | null;
  homeserver: string;
  avatarUrl?: string;
  isBot: boolean;
  status: 'ONLINE' | 'OFFLINE';
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: Date;
};

type ActuallyTypedMembers = DefaultModelRow<Contract, 'GuildMember'> & {
  user: DefaultModelRow<Contract, 'Users'>;
};
