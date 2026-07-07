import type { Server } from 'elysia/universal';
import { z } from 'zod';
import { discoverRemoteAnchor, signFederationRequest } from './discovery';
import { getConfig } from './config';
import {
  makeFederatedChannelId,
  makeFederatedGuildId,
  parseFederatedGuildId,
} from './federationIds';
import type { RealtimeEvent } from './types';
import { publishRealtime } from './publishRealtime';

const activeBridges = new Map<string, WebSocket | null>();

const channelTypeSchema = z.enum(['TEXT', 'VOICE']);
const userStatusSchema = z.enum(['ONLINE', 'OFFLINE']);

const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  type: channelTypeSchema,
  guildId: z.string(),
});

const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('guild.created'),
    data: z.object({
      id: z.string(),
      name: z.string(),
      ownerId: z.string(),
      channels: z.array(channelSchema),
    }),
  }),
  z.object({
    type: z.literal('channel.created'),
    data: channelSchema,
  }),
  z.object({
    type: z.literal('message.created'),
    data: z.object({
      id: z.string(),
      channelId: z.string(),
      guildId: z.string(),
      content: z.string(),
      nonce: z.string(),
      createdAt: z.string(),
      author: z.object({
        id: z.string(),
        username: z.string(),
        avatar: z.string().nullable(),
      }),
    }),
  }),
  z.object({
    type: z.literal('user.status.changed'),
    data: z.object({
      userId: z.string(),
      status: userStatusSchema,
    }),
  }),
  z.object({
    type: z.literal('member.joined'),
    data: z.object({
      guildId: z.string(),
      user: z.object({
        userId: z.string(),
        username: z.string(),
        displayName: z.string().nullable(),
        homeserver: z.string(),
        isBot: z.boolean(),
        status: userStatusSchema,
      }),
    }),
  }),
  z.object({
    type: z.literal('voice.states.snapshot'),
    data: z.object({
      guildIds: z.array(z.string()),
      states: z.array(
        z.object({
          guildId: z.string(),
          channelId: z.string(),
          userId: z.string(),
          name: z.string().nullable(),
        })
      ),
    }),
  }),
  z.object({
    type: z.literal('voice.state.changed'),
    data: z.object({
      guildId: z.string(),
      channelId: z.string(),
      userId: z.string(),
      name: z.string().nullable(),
      connected: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('channel.typing'),
    data: z.object({
      channelId: z.string(),
      userId: z.string(),
      username: z.string(),
      displayName: z.string().nullable(),
      homeserver: z.string(),
      time: z.string(),
    }),
  }),
]) satisfies z.ZodType<RealtimeEvent>;

export async function ensureFederatedGuildRealtimeBridge(server: Server, guildId: string) {
  const federatedGuild = parseFederatedGuildId(guildId);
  if (!federatedGuild || activeBridges.has(guildId)) return;

  activeBridges.set(guildId, null);

  let socket: WebSocket;
  try {
    const remote = await discoverRemoteAnchor(federatedGuild.homeserver);
    const path = `/federation/realtime/guilds/${encodeURIComponent(federatedGuild.id)}`;
    const url = new URL(path, remote.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const { headers } = await signFederationRequest({
      method: 'GET',
      path,
      host: url.host,
      homeserver: getConfig().server.homeserver,
      body: '',
    });
    for (const [key, value] of Object.entries(headers)) {
      url.searchParams.set(key, value);
    }

    socket = new WebSocket(url);
    activeBridges.set(guildId, socket);
  } catch (error) {
    if (activeBridges.get(guildId) === null) activeBridges.delete(guildId);
    throw error;
  }

  socket.addEventListener('message', (message) => {
    const event = parseRealtimeEvent(message.data);
    if (!event) return;

    publishRealtime(
      server,
      `guildEvents:${guildId}`,
      mapFederatedRealtimeEvent(event, federatedGuild.homeserver)
    );
  });

  socket.addEventListener('close', () => {
    if (activeBridges.get(guildId) === socket) activeBridges.delete(guildId);
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  if (typeof data !== 'string') return null;

  try {
    const parsed = JSON.parse(data) as unknown;
    const event = realtimeEventSchema.safeParse(parsed);
    return event.success ? event.data : null;
  } catch {
    return null;
  }
}

function mapFederatedRealtimeEvent(event: RealtimeEvent, homeserver: string): RealtimeEvent {
  if (event.type === 'guild.created') {
    return {
      ...event,
      data: {
        ...event.data,
        id: makeFederatedGuildId(homeserver, event.data.id),
        channels: event.data.channels.map((channel) => ({
          ...channel,
          id: makeFederatedChannelId(homeserver, channel.id),
          guildId: makeFederatedGuildId(homeserver, channel.guildId),
        })),
      },
    };
  }

  if (event.type === 'channel.created') {
    return {
      ...event,
      data: {
        ...event.data,
        id: makeFederatedChannelId(homeserver, event.data.id),
        guildId: makeFederatedGuildId(homeserver, event.data.guildId),
      },
    };
  }

  if (event.type === 'message.created') {
    return {
      ...event,
      data: {
        ...event.data,
        channelId: makeFederatedChannelId(homeserver, event.data.channelId),
        guildId: makeFederatedGuildId(homeserver, event.data.guildId),
      },
    };
  }

  if (event.type === 'member.joined') {
    return {
      ...event,
      data: {
        ...event.data,
        guildId: makeFederatedGuildId(homeserver, event.data.guildId),
      },
    };
  }

  if (event.type === 'voice.states.snapshot') {
    return {
      ...event,
      data: {
        guildIds: event.data.guildIds.map((guildId) => makeFederatedGuildId(homeserver, guildId)),
        states: event.data.states.map((state) => ({
          ...state,
          guildId: makeFederatedGuildId(homeserver, state.guildId),
          channelId: makeFederatedChannelId(homeserver, state.channelId),
        })),
      },
    };
  }

  if (event.type === 'voice.state.changed') {
    return {
      ...event,
      data: {
        ...event.data,
        guildId: makeFederatedGuildId(homeserver, event.data.guildId),
        channelId: makeFederatedChannelId(homeserver, event.data.channelId),
      },
    };
  }

  if (event.type === 'channel.typing') {
    return {
      ...event,
      data: {
        ...event.data,
        channelId: makeFederatedChannelId(homeserver, event.data.channelId),
      },
    };
  }

  return event;
}
