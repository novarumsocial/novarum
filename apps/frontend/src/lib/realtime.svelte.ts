import { anchor } from './anchor.svelte';
import { chat } from './chat-state.svelte';

type GuildCreatedEvent = {
  type: 'guild.created';
  data: {
    id: string;
    name: string;
    ownerId: string;
    channels: {
      id: string;
      name: string;
      position: number;
      type: string;
      guildId: string;
    }[];
  };
};

type ChannelCreatedEvent = {
  type: 'channel.created';
  data: {
    id: string;
    name: string;
    position: number;
    type: 'TEXT' | 'VOICE';
    guildId: string;
  };
};

type MessageCreatedEvent = {
  type: 'message.created';
  data: {
    id: string;
    channelId: string;
    guildId: string;
    content: string;
    nonce: string;
    createdAt: string | Date;
    author: {
      id: string;
      username: string;
      avatar: string | null;
    };
  };
};

type RealtimeEvent = GuildCreatedEvent | ChannelCreatedEvent | MessageCreatedEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type === 'guild.created') {
    if (!isRecord(value.data)) {
      return false;
    }

    return (
      typeof value.data.id === 'string' &&
      typeof value.data.name === 'string' &&
      typeof value.data.ownerId === 'string'
    );
  }

  if (value.type === 'channel.created') {
    if (!isRecord(value.data)) {
      return false;
    }

    return (
      typeof value.data.id === 'string' &&
      typeof value.data.name === 'string' &&
      typeof value.data.position === 'number' &&
      typeof value.data.type === 'string' &&
      (value.data.type === 'TEXT' || value.data.type === 'VOICE') &&
      typeof value.data.guildId === 'string'
    );
  }

  if (value.type === 'message.created') {
    if (!isRecord(value.data) || !isRecord(value.data.author)) {
      return false;
    }

    return (
      typeof value.data.id === 'string' &&
      typeof value.data.channelId === 'string' &&
      typeof value.data.guildId === 'string' &&
      typeof value.data.content === 'string' &&
      typeof value.data.nonce === 'string' &&
      (typeof value.data.createdAt === 'string' || value.data.createdAt instanceof Date) &&
      typeof value.data.author.id === 'string' &&
      typeof value.data.author.username === 'string' &&
      (typeof value.data.author.avatar === 'string' || value.data.author.avatar === null)
    );
  }

  return false;
}

function parseRealtimeData(data: unknown) {
  if (typeof data !== 'string') return data;

  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

class RealtimeState {
  connected = $state(false);

  connect() {
    const socket = anchor.client.realtime.subscribe();

    socket.on('open', () => {
      this.connected = true;
    });

    socket.on('close', () => {
      this.connected = false;
    });

    socket.subscribe(({ data }) => {
      const event = parseRealtimeData(data);
      if (!isRealtimeEvent(event)) return;

      if (event.type === 'guild.created') {
        chat.addGuild(event.data);
        event.data.channels.forEach((channel) => {
          chat.addChannel(channel);
        });
      }
      if (event.type === 'channel.created') {
        chat.addChannel(event.data);
      }
      if (event.type === 'message.created') {
        chat.addMessage(event.data);
      }
    });

    return () => socket.close();
  }
}

export const realtime = new RealtimeState();
