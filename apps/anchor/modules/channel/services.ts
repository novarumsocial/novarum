import Elysia, { t } from 'elysia';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';
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
import { isMessageAfter } from '../../utils/messageCursor';
import { publicUser, publicUserSchema } from '../../utils/publicUser';
import { channelReadStates, channels, db } from '../../src/db';
import { and, eq, sql } from 'drizzle-orm';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { channelSchema } from '../../utils/federationRealtime';

const remoteErrorSchema = z.object({ error: z.string() });
const successResponseSchema = z.object({ success: z.boolean() });
const okResponseSchema = z.object({ ok: z.boolean() });
const callTokenResponseSchema = z.object({
  serverUrl: z.string(),
  token: z.string(),
});
const livekitMetadataSchema = z.object({ channelId: z.string().optional() });
const channelUsersResponseSchema = z.object({
  users: z.array(
    publicUserSchema.extend({
      status: z.enum(['ONLINE', 'OFFLINE']),
      role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
      joinedAt: z.iso.datetime(),
    })
  ),
});
const callParticipantsResponseSchema = z.object({
  participants: z.array(z.object({ identity: z.string(), name: z.string(), metadata: z.string() })),
});

// TODO: probably refactor the repeated code and put it in the .resolve()
export const channel = new Elysia({ prefix: '/channel', tags: ['Channel'] })
  .resolve(async ({ cookie, status, request }) => {
    // this has its own auth
    if (new URL(request.url).pathname === '/channel/livekit/webhook') {
      return;
    }

    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }
    return { session };
  })
  .post(
    '/:id/read',
    async ({ params, body, session, status }) => {
      if (!session) return status(401, { error: 'Unauthorized' });

      const channel = await db.query.channels.findFirst({
        where: {
          id: params.id,
        },
      });
      if (!channel) return status(404, { error: 'Channel not found' });

      const membership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
      if (!membership) return status(403, { error: 'Forbidden' });

      const createdAt = new Date(body.createdAt);
      if (!parseFederatedChannelId(params.id)) {
        const message = await db.query.messages.findFirst({
          where: {
            id: body.messageId,
            channelId: params.id,
          },
        });
        if (!message || new Date(message.createdAt).getTime() !== createdAt.getTime()) {
          return status(400, { error: 'Invalid read cursor' });
        }
      }

      const existing = await db.query.channelReadStates.findFirst({
        where: {
          userId: session.userId,
          channelId: params.id,
        },
      });
      if (
        isMessageAfter(
          { createdAt, id: body.messageId },
          existing
            ? {
                createdAt: existing.lastReadCreatedAt,
                id: existing.lastReadMessageId,
              }
            : undefined
        )
      ) {
        // apparently this is the drizzle way of doing upsert: https://orm.drizzle.team/docs/guides/upsert
        await db
          .insert(channelReadStates)
          .values({
            userId: session.userId,
            channelId: params.id,
            lastReadCreatedAt: createdAt,
            lastReadMessageId: body.messageId,
          })
          .onConflictDoUpdate({
            target: [channelReadStates.userId, channelReadStates.channelId],
            set: {
              lastReadCreatedAt: createdAt,
              lastReadMessageId: body.messageId,
            },
          });
      }

      return { success: true };
    },
    {
      body: t.Object({
        messageId: t.String(),
        createdAt: t.String({ format: 'date-time' }),
      }),
      response: {
        200: successResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/create',
    async ({ body, session, server, status }) => {
      const { name, guildId, type } = body;
      if (!session) return status(401, { error: 'Unauthorized' });
      if (parseFederatedGuildId(guildId)) {
        return status(400, {
          error: 'Cannot create channels on a federated guild',
        });
      }

      const guild = await db.query.guilds.findFirst({
        where: {
          id: guildId,
        },
      });
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }
      if (guild.ownerId !== session.userId) {
        return status(403, { error: 'Unauthorized' });
      }

      const { channel } = await db.transaction(async (tx) => {
        // reorder the channels to make space for the new channel at position 0
        await tx
          .update(channels)
          .set({ position: sql`${channels.position} + 1` })
          .where(eq(channels.guildId, guildId));

        const [channel] = await tx
          .insert(channels)
          .values({
            id: randomString(),
            name: name.replaceAll(' ', '-'),
            type,
            position: 0,
            guildId,
          })
          .returning();
        return { channel };
      });

      if (!channel) {
        return status(500, { error: 'Channel not created on the database' });
      }

      const createdChannel = {
        id: channel.id,
        name: channel.name,
        position: channel.position,
        type,
        guildId: channel.guildId,
      };

      if (server) {
        publishRealtime(server, `guildEvents:${guildId}`, {
          type: 'channel.created',
          data: createdChannel,
        });
      }

      return createdChannel;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        type: t.Enum({ TEXT: 'TEXT', VOICE: 'VOICE' }),
        guildId: t.String(),
      }),
      response: {
        200: channelSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        500: genericResponseErrorSchema,
      },
    }
  )
  .patch(
    '/order',
    async ({ body, session, server, status }) => {
      if (!session) return status(401, { error: 'Unauthorized' });
      if (parseFederatedGuildId(body.guildId)) {
        return status(400, {
          error: 'Cannot reorder channels on a federated guild',
        });
      }

      const guild = await db.query.guilds.findFirst({
        where: {
          id: body.guildId,
        },
        with: { channels: true },
      });
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }
      if (guild.ownerId !== session.userId) {
        return status(403, { error: 'Unauthorized' });
      }

      // borrowed from PATCH /guilds/order
      const channelIds = new Set(guild.channels.map((c) => c.id));
      const requestedIds = new Set(body.channelIds);
      if (
        body.channelIds.length !== channelIds.size ||
        body.channelIds.length !== requestedIds.size ||
        body.channelIds.some((id) => !channelIds.has(id))
      ) {
        return status(400, { error: 'Invalid channel IDs' });
      }

      await db.transaction(async (tx) => {
        for (const [position, channelId] of body.channelIds.entries()) {
          await tx
            .update(channels)
            .set({ position })
            .where(and(eq(channels.guildId, guild.id), eq(channels.id, channelId)));
        }
      });

      if (server) {
        publishRealtime(server, `guildEvents:${guild.id}`, {
          type: 'guild.channels.reordered',
          data: {
            guildId: guild.id,
            channelIds: body.channelIds,
          },
        });
      }

      return { success: true };
    },
    {
      body: t.Object({
        guildId: t.String(),
        channelIds: t.Array(t.String()),
      }),
      response: {
        200: successResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/:id/users',
    async ({ params, session, status }) => {
      if (!session) return status(401, { error: 'Unauthorized' });

      const channel = await db.query.channels.findFirst({
        where: {
          id: params.id,
        },
      });
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      const membership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
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
        const remoteUsers = channelUsersResponseSchema.safeParse(result.data);
        if (!remoteUsers.success) {
          return status(502, {
            error: 'Remote users returned an invalid response',
          });
        }

        return remoteUsers.data;
      }

      const members = await db.query.guildMembers.findMany({
        where: {
          guildId: channel.guildId,
        },
        with: {
          user: true,
        },
      });

      const users = members.map((member) => ({
        ...publicUser(member.user),
        status: member.user.status as 'ONLINE' | 'OFFLINE',
        role: member.role as 'OWNER' | 'ADMIN' | 'MEMBER',
        joinedAt: member.joinedAt.toISOString(),
      }));

      return { users };
    },
    {
      response: {
        200: channelUsersResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/:id/call/token',
    async ({ params, session, status }) => {
      if (!session) return status(401, { error: 'Unauthorized' });

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
          return status(502, {
            error: 'Remote call token returned an invalid response',
          });
        }

        return callToken.data;
      }

      const channel = await db.query.channels.findFirst({
        where: {
          id: params.id,
        },
      });
      if (!channel || channel.type !== 'VOICE') {
        return status(404, { error: 'Channel not right' });
      }

      const membership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
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
    },
    {
      response: {
        200: callTokenResponseSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/:id/typing',
    async ({ params, session, status, server }) => {
      if (!session) return status(401, { error: 'Unauthorized' });
      const channel = await db.query.channels.findFirst({
        where: {
          id: params.id,
        },
      });
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      const channelMembership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
      if (!channelMembership) {
        return status(401, { error: 'Unauthorized' });
      }

      const federatedChannel = parseFederatedChannelId(params.id);
      if (federatedChannel) {
        const result = await postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/typing`,
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
            remoteError.success ? remoteError.data : { error: 'Remote typing failed' }
          );
        }
      }

      if (server) {
        publishRealtime(server, `guildEvents:${channel.guildId}`, {
          type: 'channel.typing',
          data: {
            channelId: channel.id,
            userId: session.userId,
            username: session.user.username,
            displayName: session.user.displayName,
            homeserver: session.user.homeserver,
            time: new Date().toISOString(),
          },
        });
      }

      return { ok: true };
    },
    {
      response: {
        200: okResponseSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/:id/call/participants',
    async ({ params, session, status }) => {
      if (!session) return status(401, { error: 'Unauthorized' });
      const channel = await db.query.channels.findFirst({
        where: {
          id: params.id,
        },
      });
      if (!channel || channel.type !== 'VOICE') {
        return status(404, { error: 'Channel not right' });
      }

      const channelMembership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
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
    },
    {
      response: {
        200: callParticipantsResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/livekit/webhook',
    async ({ request, headers, server }) => {
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
        (metadata.success ? metadata.data.channelId : undefined) ??
        event.room?.name?.replace(/^voice:/, '');

      const channel = await db.query.channels.findFirst({
        where: {
          id: channelId,
        },
      });
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
    },
    {
      response: {
        200: okResponseSchema,
      },
    }
  );
