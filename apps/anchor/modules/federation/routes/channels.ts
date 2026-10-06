import Elysia from 'elysia';
import { AccessToken } from 'livekit-server-sdk';
import { z } from 'zod';
import { channelUsersResponseSchema } from '../../../src/db/zod';
import { db } from '../../../src/db';
import { getConfig } from '../../../utils/config';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { publicUser } from '../../../utils/publicUser';
import { publishToChannel } from '../../../utils/publishRealtime';
import { removeVoicePresence, setVoicePresence } from '../../../utils/services/livekit';
import { getFederatedChannelAccess, isCallChannel } from '../access';
import { federationAuth } from '../plugin';
import { federationErrors, okResponseSchema } from '../schemas';

const channelErrors = {
  ...federationErrors,
  403: genericResponseErrorSchema,
  404: genericResponseErrorSchema,
};

// what a remote user can do in a channel besides reading and writing messages
export const channels = new Elysia()
  .use(federationAuth)
  // the member list of a guild; DMs have no roster to speak of
  .post(
    '/channels/:id/users',
    async ({ params, remoteUser, status }) => {
      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      if (!access.channel.guildId) return { users: [] };

      const members = await db.query.guildMembers.findMany({
        where: { guildId: access.channel.guildId },
        with: { user: true },
      });

      return {
        users: members.map((member) => ({
          ...publicUser(member.user),
          status: member.user.status as 'ONLINE' | 'OFFLINE',
          role: member.role as 'OWNER' | 'ADMIN' | 'MEMBER',
          joinedAt: member.joinedAt.toISOString(),
        })),
      };
    },
    { federatedUser: true, response: { 200: channelUsersResponseSchema, ...channelErrors } }
  )
  .post(
    '/channels/:id/typing',
    async ({ params, remoteUser, server, status }) => {
      const access = await getFederatedChannelAccess(params.id, remoteUser, true);
      if (!access.ok) return status(access.status, { error: access.error });

      if (server) {
        await publishToChannel(server, access.channel, {
          type: 'channel.typing',
          data: {
            channelId: access.channel.id,
            userId: access.user.id,
            username: access.user.username,
            displayName: access.user.displayName,
            homeserver: access.user.homeserver,
            time: new Date().toISOString(),
          },
        });
      }

      return { ok: true };
    },
    { federatedUser: true, response: { 200: okResponseSchema, ...channelErrors } }
  )
  // a LiveKit token so the remote user can join the call of one of our voice channels or DMs
  .post(
    '/channels/:id/call/token',
    async ({ params, remoteUser, status }) => {
      const access = await getFederatedChannelAccess(params.id, remoteUser, true);
      if (!access.ok) return status(access.status, { error: access.error });
      if (!isCallChannel(access.channel)) return status(404, { error: 'Channel not right' });

      const voiceConfig = getConfig().voice;
      const token = new AccessToken(voiceConfig.livekit_key, voiceConfig.livekit_secret, {
        identity: access.user.id,
        name: access.user.displayName || access.user.username,
        ttl: '5m',
        metadata: JSON.stringify({
          channelId: access.channel.id,
          guildId: access.channel.guildId,
          userId: access.user.id,
        }),
      });
      token.addGrant({
        roomJoin: true,
        room: `voice:${access.channel.id}`,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });

      return { serverUrl: voiceConfig.livekit_url, token: await token.toJwt() };
    },
    {
      federatedUser: true,
      response: { 200: z.object({ serverUrl: z.string(), token: z.string() }), ...channelErrors },
    }
  )
  // the remote user joined or left the call of a voice channel or DM
  .post(
    '/channels/:id/voice-state',
    async ({ params, payload, remoteUser, server, status }) => {
      const connected = z.boolean().safeParse(payload.connected);
      if (!connected.success) return status(400, { error: 'Invalid voice state' });

      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      if (!isCallChannel(access.channel)) return status(404, { error: 'Channel not right' });

      const state = {
        guildId: access.channel.guildId,
        channelId: access.channel.id,
        userId: access.user.id,
        name: access.user.displayName || access.user.username,
      };
      if (connected.data) setVoicePresence(state);
      else removeVoicePresence(state.userId);

      if (server) {
        await publishToChannel(server, access.channel, {
          type: 'voice.state.changed',
          data: { ...state, connected: connected.data },
        });
      }

      return { state };
    },
    {
      federatedUser: true,
      response: {
        200: z.object({
          state: z.object({
            guildId: z.string().nullable(),
            channelId: z.string(),
            userId: z.string(),
            name: z.string(),
          }),
        }),
        ...channelErrors,
      },
    }
  )
  // the remote user starts or stops ringing the other people in a DM
  .post(
    '/channels/:id/ring',
    async ({ params, payload, remoteUser, server, status }) => {
      const ringing = z.boolean().safeParse(payload.ringing);
      if (!ringing.success) return status(400, { error: 'Invalid ring state' });

      const access = await getFederatedChannelAccess(params.id, remoteUser, true);
      if (!access.ok) return status(access.status, { error: access.error });
      if (access.channel.type !== 'DM') return status(404, { error: 'Channel not right' });

      if (server) {
        await publishToChannel(server, access.channel, {
          type: 'call.ringing',
          data: {
            channelId: access.channel.id,
            user: publicUser(access.user),
            ringing: ringing.data,
          },
        });
      }

      return { ok: true };
    },
    { federatedUser: true, response: { 200: okResponseSchema, ...channelErrors } }
  );
