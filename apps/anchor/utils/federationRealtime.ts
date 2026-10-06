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
import { remoteSupports } from './federationFeatures';
import { subscribeMessages, type SharedKind } from './federationSharedSocket';
import type { RealtimeEvent, VoicePresence } from './types';
import { publishRealtime, publishToChannel } from './publishRealtime';
import { publicUserSchema } from './publicUser';
import {
  attachmentResponseSchema,
  channelResponseSchema,
  messageResponseBaseSchema,
  userStatusSchema,
} from '../src/db/zod';

// Guilds and DMs hosted on another homeserver only produce events there, so we follow them with a
// WebSocket ("bridge") and publish what comes in to our own clients as if it happened here.
//
// A homeserver that supports the shared socket (see federationSharedSocket.ts) is followed through
// ONE socket for everything we have there. Older ones get one socket per guild or DM.

// presence for remote guilds/DMs lives on their homeserver, so we keep what the bridges relay
// to include it in the snapshot local clients get when they connect.
const bridgedVoicePresence = new Map<string, Map<string, VoicePresence>>();

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

export const realtimeEventSchema = z.discriminatedUnion('type', [
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

// what the host sends over a shared socket
const sharedFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    kind: z.enum(['guild', 'dm']),
    id: z.string(),
    event: realtimeEventSchema,
  }),
  z.object({ type: z.literal('refused'), kind: z.enum(['guild', 'dm']), id: z.string() }),
]);

// ---- bridges --------------------------------------------------------------------------------

// A guild or DM we follow on another homeserver.
type Bridge = {
  // our id for it (fed:guild:... / fed:channel:...), which is what our clients know it by
  id: string;
  kind: SharedKind;
  homeserver: string;
  // the id the host uses
  remoteId: string;
  // publishes an event to our own clients
  handler: (event: RealtimeEvent) => void | Promise<void>;
};

// every bridge that is running or waiting to reconnect, by our id for it
const bridges = new Map<string, Bridge>();

export async function ensureFederatedGuildRealtimeBridge(server: Server, guildId: string) {
  const federatedGuild = parseFederatedGuildId(guildId);
  if (!federatedGuild) return;

  await ensureBridge({
    id: guildId,
    kind: 'guild',
    homeserver: federatedGuild.homeserver,
    remoteId: federatedGuild.id,
    handler: (event) => publishRealtime(server, `guildEvents:${guildId}`, event),
  });
}

// same idea as the guild bridge, but a DM has no shared topic of its own to
// publish to: publishToChannel fans the event out to each local participant.
export async function ensureFederatedDmRealtimeBridge(server: Server, channelId: string) {
  const federatedChannel = parseFederatedChannelId(channelId);
  if (!federatedChannel) return;

  await ensureBridge({
    id: channelId,
    kind: 'dm',
    homeserver: federatedChannel.homeserver,
    remoteId: federatedChannel.id,
    handler: async (event) => {
      if (event.type === 'message.created') {
        await db
          .update(channelMembers)
          .set({ closed: false })
          .where(eq(channelMembers.channelId, channelId));
      }
      await publishToChannel(server, { id: channelId, guildId: null }, event);
    },
  });
}

// Starts following a guild or DM, unless we already do. Callers don't wait for the connection and
// never ask again once it is up, so the bridge has to keep reconnecting by itself.
async function ensureBridge(bridge: Bridge, attempt = 0) {
  if (bridges.has(bridge.id)) return;
  bridges.set(bridge.id, bridge);

  try {
    const remote = await discoverRemoteAnchor(bridge.homeserver);
    if (remoteSupports(remote, 'realtime-mux')) joinSharedSocket(bridge);
    else await openOwnSocket(bridge, remote, attempt);
  } catch (error) {
    bridges.delete(bridge.id);
    reconnectLater(() => ensureBridge(bridge, attempt + 1), attempt);
    throw error;
  }
}

const maxReconnectDelayMs = 5 * 60 * 1000;

// retries with a growing delay, up to a few minutes
function reconnectLater(reconnect: () => Promise<unknown>, attempt: number) {
  return setTimeout(
    () => void reconnect().catch(() => null),
    Math.min(1000 * 2 ** attempt, maxReconnectDelayMs)
  );
}

// the remote closes with this code when it refuses us (left the guild, DM gone, bad signature):
// retrying won't help, and the next GET /dm or /guilds starts a fresh bridge if access comes back.
const refusedCloseCode = 1008;

// a bridge's own socket, or the shared one, opened with the signed headers in the query because
// a WebSocket can't carry custom headers
async function openSignedSocket(remote: { baseUrl: string }, path: string) {
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

  return new WebSocket(url);
}

// An event from the host: map its ids to ours, remember who is in a call and publish it.
function receive(bridge: Bridge, event: RealtimeEvent) {
  const mapped = mapFederatedRealtimeEvent(event, bridge.homeserver);
  trackBridgedVoicePresence(bridge.id, mapped);
  publish(bridge, mapped);
}

// a failing handler must not break the bridge
function publish(bridge: Bridge, event: RealtimeEvent) {
  Promise.resolve()
    .then(() => bridge.handler(event))
    .catch((error) => console.warn(`Failed to handle bridged event for ${bridge.id}:`, error));
}

// updates stop with the bridge, so don't leave clients showing people in a call forever.
function clearBridgedVoicePresence(bridge: Bridge) {
  for (const state of bridgedVoicePresenceFor([bridge.id])) {
    publish(bridge, { type: 'voice.state.changed', data: { ...state, connected: false } });
  }
  bridgedVoicePresence.delete(bridge.id);
}

// ---- one socket per guild or DM (homeservers without the shared socket) ----------------------

const ownSockets = new Map<string, WebSocket>();

async function openOwnSocket(bridge: Bridge, remote: { baseUrl: string }, attempt: number) {
  const path = `/federation/realtime/${bridge.kind === 'guild' ? 'guilds' : 'dms'}/${encodeURIComponent(bridge.remoteId)}`;
  const socket = await openSignedSocket(remote, path);
  ownSockets.set(bridge.id, socket);

  // the delay starts over once the remote actually accepts the connection
  socket.addEventListener('open', () => {
    attempt = 0;
  });

  socket.addEventListener('message', (message) => {
    const event = parseRealtimeEvent(message.data);
    if (event) receive(bridge, event);
  });

  socket.addEventListener('close', (event) => {
    if (ownSockets.get(bridge.id) !== socket) return;
    ownSockets.delete(bridge.id);
    bridges.delete(bridge.id);

    clearBridgedVoicePresence(bridge);
    if (event.code !== refusedCloseCode) {
      reconnectLater(() => ensureBridge(bridge, attempt + 1), attempt);
    }
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

// ---- one socket per homeserver ---------------------------------------------------------------

// The shared socket to one homeserver, carrying all the bridges we have there.
type SharedSocket = {
  homeserver: string;
  socket: WebSocket | null;
  isOpen: boolean;
  isConnecting: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  // by `kind:remoteId`, which is how the host's events say what they belong to
  bridges: Map<string, Bridge>;
};

const sharedSockets = new Map<string, SharedSocket>();
const sharedKey = (kind: SharedKind, remoteId: string) => `${kind}:${remoteId}`;

function joinSharedSocket(bridge: Bridge) {
  let shared = sharedSockets.get(bridge.homeserver);
  if (!shared) {
    shared = {
      homeserver: bridge.homeserver,
      socket: null,
      isOpen: false,
      isConnecting: false,
      reconnectTimer: null,
      attempt: 0,
      bridges: new Map(),
    };
    sharedSockets.set(bridge.homeserver, shared);
  }
  shared.bridges.set(sharedKey(bridge.kind, bridge.remoteId), bridge);

  if (shared.isOpen) subscribe(shared, [bridge]);
  // otherwise it is subscribed once the socket opens, which a pending reconnect will also do
  else if (!shared.socket && !shared.isConnecting && !shared.reconnectTimer) void connect(shared);
}

// asks the host for these bridges' events; it answers each one with a snapshot, or a refusal
function subscribe(shared: SharedSocket, list: Bridge[]) {
  const remoteIds = (kind: SharedKind) =>
    list.filter((bridge) => bridge.kind === kind).map((bridge) => bridge.remoteId);
  for (const message of subscribeMessages(remoteIds('guild'), remoteIds('dm'))) {
    shared.socket?.send(message);
  }
}

async function connect(shared: SharedSocket) {
  shared.isConnecting = true;
  let socket: WebSocket;
  try {
    const remote = await discoverRemoteAnchor(shared.homeserver);
    socket = await openSignedSocket(remote, '/federation/realtime');
  } catch {
    shared.isConnecting = false;
    reconnectShared(shared);
    return;
  }
  shared.isConnecting = false;
  shared.socket = socket;

  socket.addEventListener('open', () => {
    shared.isOpen = true;
    shared.attempt = 0;
    subscribe(shared, [...shared.bridges.values()]);
  });

  socket.addEventListener('message', (message) => {
    const frame = parseSharedFrame(message.data);
    const bridge = frame && shared.bridges.get(sharedKey(frame.kind, frame.id));
    if (!frame || !bridge) return;

    if (frame.type === 'event') receive(bridge, frame.event);
    else leaveSharedSocket(shared, bridge);
  });

  socket.addEventListener('close', (event) => {
    if (shared.socket !== socket) return;
    shared.socket = null;
    shared.isOpen = false;
    for (const bridge of shared.bridges.values()) clearBridgedVoicePresence(bridge);

    if (event.code === refusedCloseCode) {
      for (const bridge of shared.bridges.values()) bridges.delete(bridge.id);
      sharedSockets.delete(shared.homeserver);
    } else {
      reconnectShared(shared);
    }
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

// the bridges stay registered while the socket is down, and are subscribed again when it is back
function reconnectShared(shared: SharedSocket) {
  shared.reconnectTimer = reconnectLater(
    async () => {
      shared.reconnectTimer = null;
      // every bridge may have been refused while we waited, which discards the socket
      if (sharedSockets.get(shared.homeserver) === shared) await connect(shared);
    },
    shared.attempt++
  );
}

// the host refused one bridge, like a closed single socket does
function leaveSharedSocket(shared: SharedSocket, bridge: Bridge) {
  shared.bridges.delete(sharedKey(bridge.kind, bridge.remoteId));
  bridges.delete(bridge.id);
  clearBridgedVoicePresence(bridge);

  if (shared.bridges.size === 0) {
    // taken out first, so closing it isn't mistaken for the connection dropping
    const socket = shared.socket;
    shared.socket = null;
    shared.isOpen = false;
    sharedSockets.delete(shared.homeserver);
    socket?.close();
  }
}

// ---- parsing and mapping events ----------------------------------------------------------------

export function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  if (typeof data !== 'string') return null;

  try {
    const parsed = JSON.parse(data) as unknown;
    const event = realtimeEventSchema.safeParse(parsed);
    return event.success ? event.data : null;
  } catch {
    return null;
  }
}

function parseSharedFrame(data: unknown) {
  if (typeof data !== 'string') return null;

  try {
    const frame = sharedFrameSchema.safeParse(JSON.parse(data));
    return frame.success ? frame.data : null;
  } catch {
    return null;
  }
}

// Events from another homeserver use its ids. Ours are the same ids prefixed with where they
// came from, so a remote can never produce an id that belongs to someone else.
export function mapFederatedRealtimeEvent(event: RealtimeEvent, homeserver: string): RealtimeEvent {
  const guild = (id: string) => makeFederatedGuildId(homeserver, id);
  const channel = (id: string) => makeFederatedChannelId(homeserver, id);
  const guildOrNull = (id: string | null) => (id ? guild(id) : null);

  switch (event.type) {
    case 'guild.created':
      return {
        ...event,
        data: {
          ...event.data,
          id: guild(event.data.id),
          channels: event.data.channels.map((c) => ({
            ...c,
            id: channel(c.id),
            guildId: guild(c.guildId),
          })),
        },
      };
    case 'channel.created':
      return {
        ...event,
        data: { ...event.data, id: channel(event.data.id), guildId: guild(event.data.guildId) },
      };
    case 'message.created':
    case 'message.updated':
      return {
        ...event,
        data: {
          ...event.data,
          channelId: channel(event.data.channelId),
          guildId: guildOrNull(event.data.guildId),
        },
      };
    case 'message.deleted':
      return {
        ...event,
        data: {
          ...event.data,
          channelId: channel(event.data.channelId),
          guildId: guildOrNull(event.data.guildId),
        },
      };
    case 'member.joined':
      return { ...event, data: { ...event.data, guildId: guild(event.data.guildId) } };
    case 'voice.states.snapshot':
      return {
        ...event,
        data: {
          guildIds: event.data.guildIds.map(guild),
          states: event.data.states.map((state) => ({
            ...state,
            guildId: guildOrNull(state.guildId),
            channelId: channel(state.channelId),
          })),
        },
      };
    case 'voice.state.changed':
      return {
        ...event,
        data: {
          ...event.data,
          guildId: guildOrNull(event.data.guildId),
          channelId: channel(event.data.channelId),
        },
      };
    case 'call.ringing':
      return { ...event, data: { ...event.data, channelId: channel(event.data.channelId) } };
    case 'channel.typing':
      return { ...event, data: { ...event.data, channelId: channel(event.data.channelId) } };
    case 'guild.channels.reordered':
      return {
        ...event,
        data: {
          ...event.data,
          guildId: guild(event.data.guildId),
          channelIds: event.data.channelIds.map(channel),
        },
      };
    default:
      // the rest (user.status.changed, ...) has no ids to map
      return event;
  }
}
