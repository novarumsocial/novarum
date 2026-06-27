import type { Server } from 'elysia/universal';
import { discoverRemoteAnchor, signFederationRequest } from './discovery';
import { getConfig } from './config';
import {
  makeFederatedChannelId,
  makeFederatedGuildId,
  parseFederatedGuildId,
} from './federationIds';
import type { RealtimeEvent } from './types';
import { publishRealtime } from './publishRealtime';

const activeBridges = new Map<string, WebSocket>();

export async function ensureFederatedGuildRealtimeBridge(server: Server, guildId: string) {
  const federatedGuild = parseFederatedGuildId(guildId);
  if (!federatedGuild || activeBridges.has(guildId)) return;

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

  const socket = new WebSocket(url);
  activeBridges.set(guildId, socket);

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
    const parsed = JSON.parse(data) as RealtimeEvent;
    return parsed && typeof parsed === 'object' && 'type' in parsed ? parsed : null;
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

  return event;
}
