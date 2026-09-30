import type { Server } from 'elysia/universal';
import { z } from 'zod';
import { discoverRemoteAnchor, signFederationRequest } from './discovery';
import { getConfig } from './config';
import { db, channelMembers } from '../src/db';
import { eq } from 'drizzle-orm';
import {
  makeFederatedChannelId,
  makeFederatedGuildId,
  parseFederatedChannelId,
  parseFederatedGuildId,
} from './federationIds';
import type { RealtimeEvent, VoicePresence } from './types';
import { publishRealtime, publishToChannel } from './publishRealtime';
import { publicUserSchema } from './publicUser';
import {
  attachmentResponseSchema,
  channelResponseSchema,
  messageResponseBaseSchema,
  userStatusSchema,
} from '../src/db/zod';

const activeBridges = new Map<string, WebSocket | null>();
const bridgedVoicePresence = new Map<string, Map<string, VoicePresence>>();

// presence for remote guilds/DMs lives on their homeserver, so we keep what the bridges relay
// to include it in the snapshot local clients get when they connect.
export function bridgedVoicePresenceFor(ids: string[]) {
  return ids.flatMap((id) => [...(bridgedVoicePresence.get(id)?.values() ?? [])]);
}

function trackBridgedVoicePresence(id: string, event: RealtimeEvent) {
  if (event.type === 'voice.states.snapshot') {
    bridgedVoicePresence.set(id, new Map(event.data.states.map((state) => [state.userId, state])));
  }
  if (event.type === 'voice.state.changed') {
    const { connected, ...state } = event.data;
    const states = bridgedVoicePresence.get(id) ?? new Map<string, VoicePresence>();
    if (connected) states.set(state.userId, state);
    else states.delete(state.userId);
    bridgedVoicePresence.set(id, states);
  }
}

const messageEventDataSchema = messageResponseBaseSchema.extend({
  guildId: z.string().nullable(),
  replyTo: messageResponseBaseSchema.shape.replyTo.default(null),
  pingedHandles: z.array(z.string()).default([]),
  attachments: z.array(attachmentResponseSchema),
  createdAt: z.string(),
  author: publicUserSchema,
});

const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('guild.created'),
    data: z.object({
      id: z.string(),
      name: z.string(),
      ownerId: z.string(),
      avatarUrl: z.string().url().nullable(),
      description: z.string().nullable(),
      channels: z.array(channelResponseSchema),
    }),
  }),
  z.object({
    type: z.literal('channel.created'),
    data: channelResponseSchema,
  }),
  z.object({
    type: z.literal('message.created'),
    data: messageEventDataSchema,
  }),
  z.object({
    type: z.literal('message.updated'),
    data: messageEventDataSchema,
  }),
  z.object({
    type: z.literal('message.deleted'),
    data: z.object({
      id: z.string(),
      channelId: z.string(),
      guildId: z.string().nullable(),
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
      user: publicUserSchema.extend({
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
          guildId: z.string().nullable(),
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
      guildId: z.string().nullable(),
      channelId: z.string(),
      userId: z.string(),
      name: z.string().nullable(),
      connected: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('call.ringing'),
    data: z.object({ channelId: z.string(), user: publicUserSchema, ringing: z.boolean() }),
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
  z.object({
    type: z.literal('guild.channels.reordered'),
    data: z.object({
      guildId: z.string(),
      channelIds: z.array(z.string()),
    }),
  }),
]) satisfies z.ZodType<RealtimeEvent>;

export async function ensureFederatedGuildRealtimeBridge(server: Server, guildId: string) {
  const federatedGuild = parseFederatedGuildId(guildId);
  if (!federatedGuild) return;

  await ensureBridge(
    guildId,
    federatedGuild.homeserver,
    `/federation/realtime/guilds/${encodeURIComponent(federatedGuild.id)}`,
    (event) => publishRealtime(server, `guildEvents:${guildId}`, event)
  );
}

// same idea as the guild bridge, but a DM has no shared topic of its own to
// publish to: publishToChannel fans the event out to each local participant.
export async function ensureFederatedDmRealtimeBridge(server: Server, channelId: string) {
  const federatedChannel = parseFederatedChannelId(channelId);
  if (!federatedChannel) return;

  await ensureBridge(
    channelId,
    federatedChannel.homeserver,
    `/federation/realtime/dms/${encodeURIComponent(federatedChannel.id)}`,
    async (event) => {
      if (event.type === 'message.created') {
        await db
          .update(channelMembers)
          .set({ closed: false })
          .where(eq(channelMembers.channelId, channelId));
      }
      await publishToChannel(server, { id: channelId, guildId: null }, event);
    }
  );
}

const maxReconnectDelayMs = 5 * 60 * 1000;

async function ensureBridge(
  id: string,
  homeserver: string,
  path: string,
  handler: (event: RealtimeEvent) => void | Promise<void>,
  attempt = 0
) {
  if (activeBridges.has(id)) return;
  activeBridges.set(id, null);

  const onEvent = (event: RealtimeEvent) =>
    Promise.resolve()
      .then(() => handler(event))
      .catch((error) => console.warn(`Failed to handle bridged event for ${id}:`, error));

  // clients never ask for a bridge again once connected, so keep retrying with backoff
  // (reset once the remote actually accepts the connection).
  const reconnect = () =>
    setTimeout(
      () => void ensureBridge(id, homeserver, path, handler, attempt + 1).catch(() => null),
      Math.min(1000 * 2 ** attempt, maxReconnectDelayMs)
    );

  let socket: WebSocket;
  try {
    const remote = await discoverRemoteAnchor(homeserver);
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
    activeBridges.set(id, socket);
  } catch (error) {
    if (activeBridges.get(id) === null) activeBridges.delete(id);
    reconnect();
    throw error;
  }

  socket.addEventListener('open', () => {
    attempt = 0;
  });

  socket.addEventListener('message', (message) => {
    const event = parseRealtimeEvent(message.data);
    if (!event) return;

    const mapped = mapFederatedRealtimeEvent(event, homeserver);
    trackBridgedVoicePresence(id, mapped);
    onEvent(mapped);
  });

  socket.addEventListener('close', () => {
    if (activeBridges.get(id) !== socket) return;
    activeBridges.delete(id);

    // updates stop with the bridge, so don't leave clients showing people in a call forever.
    for (const state of bridgedVoicePresenceFor([id])) {
      onEvent({ type: 'voice.state.changed', data: { ...state, connected: false } });
    }
    bridgedVoicePresence.delete(id);
    reconnect();
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

  if (event.type === 'message.created' || event.type === 'message.updated') {
    return {
      ...event,
      data: {
        ...event.data,
        channelId: makeFederatedChannelId(homeserver, event.data.channelId),
        guildId: event.data.guildId ? makeFederatedGuildId(homeserver, event.data.guildId) : null,
      },
    };
  }

  if (event.type === 'message.deleted') {
    return {
      ...event,
      data: {
        ...event.data,
        channelId: makeFederatedChannelId(homeserver, event.data.channelId),
        guildId: event.data.guildId ? makeFederatedGuildId(homeserver, event.data.guildId) : null,
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
          guildId: state.guildId ? makeFederatedGuildId(homeserver, state.guildId) : null,
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
        guildId: event.data.guildId ? makeFederatedGuildId(homeserver, event.data.guildId) : null,
        channelId: makeFederatedChannelId(homeserver, event.data.channelId),
      },
    };
  }

  if (event.type === 'call.ringing') {
    return {
      ...event,
      data: { ...event.data, channelId: makeFederatedChannelId(homeserver, event.data.channelId) },
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

  if (event.type === 'guild.channels.reordered') {
    return {
      ...event,
      data: {
        ...event.data,
        guildId: makeFederatedGuildId(homeserver, event.data.guildId),
        channelIds: event.data.channelIds.map((channelId) =>
          makeFederatedChannelId(homeserver, channelId)
        ),
      },
    };
  }

  return event;
}
