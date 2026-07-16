import { anchor } from './anchor.svelte';
import { chat } from './chat-state.svelte';
import { z } from 'zod';
import type { RealtimeEvent } from 'anchor';

const channelTypeSchema = z.enum(['TEXT', 'VOICE']);
const userStatusSchema = z.enum(['ONLINE', 'OFFLINE']);
const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string().url(),
});

const emojiSearchResultsSchema = z.object({
  type: z.literal('emoji.search.results'),
  data: z.object({
    query: z.string(),
    emojis: z.array(
      z.object({
        name: z.string(),
        unicode: z.string(),
        url: z.string().url(),
      })
    ),
  }),
});

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
      avatarUrl: z.string().url().nullable(),
      description: z.string().nullable(),
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
      replyTo: z.string().nullable().default(null),
      attachments: z.array(attachmentSchema),
      createdAt: z.union([z.string(), z.date().transform((date) => date.toISOString())]),
      author: z.object({
        id: z.string(),
        username: z.string(),
        avatar: z.string().nullable(),
      }),
    }),
  }),
  z.object({
    type: z.literal('message.deleted'),
    data: z.object({
      id: z.string(),
      channelId: z.string(),
      guildId: z.string(),
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
        avatarUrl: z.string().url().nullable(),
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
      time: z.union([z.string(), z.date().transform((date) => date.toISOString())]),
    }),
  }),
]) satisfies z.ZodType<RealtimeEvent>;

function parseRealtimeData(data: unknown) {
  if (data instanceof MessageEvent) return parseRealtimeData(data.data);

  if (typeof data !== 'string') return data;

  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function parseRealtimeEvent(data: unknown) {
  const event = realtimeEventSchema.safeParse(parseRealtimeData(data));
  if (event.success) return event.data;

  if (data && typeof data === 'object' && 'data' in data) {
    const wrappedEvent = realtimeEventSchema.safeParse(parseRealtimeData(data.data));
    if (wrappedEvent.success) return wrappedEvent.data;
  }

  return null;
}

function parseEmojiSearchResults(data: unknown) {
  const results = emojiSearchResultsSchema.safeParse(parseRealtimeData(data));
  if (results.success) return results.data;

  if (data && typeof data === 'object' && 'data' in data) {
    const wrappedResults = emojiSearchResultsSchema.safeParse(parseRealtimeData(data.data));
    if (wrappedResults.success) return wrappedResults.data;
  }

  return null;
}

class RealtimeState {
  connected = $state(false);
  emojiQuery = $state('');
  emojiResults = $state<z.infer<typeof emojiSearchResultsSchema>['data']['emojis']>([]);
  private socket: ReturnType<typeof anchor.client.realtime.subscribe> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private active = false;
  private shouldRecover = false;
  private voiceChannelId: string | null = null;

  connect() {
    this.active = true;

    const reconnectWhenOnline = () => {
      if (!this.active || this.connected) return;

      this.clearReconnectTimer();
      this.openSocket();
    };

    window.addEventListener('online', reconnectWhenOnline);
    this.openSocket();

    return () => {
      this.active = false;
      this.connected = false;
      this.clearReconnectTimer();
      window.removeEventListener('online', reconnectWhenOnline);

      const socket = this.socket;
      this.socket = null;
      socket?.close();
    };
  }

  private openSocket() {
    if (!this.active || this.socket) return;

    const socket = anchor.client.realtime.subscribe();
    this.socket = socket;

    socket.on('open', () => {
      if (!this.active || this.socket !== socket) return;

      this.connected = true;
      this.reconnectAttempt = 0;

      for (const guild of chat.servers) this.subscribeGuild(guild.id);
      if (this.voiceChannelId) socket.send({ type: 'voice.join', channelId: this.voiceChannelId });

      if (this.shouldRecover) {
        this.shouldRecover = false;
        void chat
          .recoverRealtimeState()
          .catch((error) => console.error('Failed to recover realtime state', error));
      }
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;

      this.socket = null;
      this.connected = false;
      this.shouldRecover = true;
      this.scheduleReconnect();
    });

    socket.subscribe((message) => {
      const emojiResults = parseEmojiSearchResults(message);
      if (emojiResults) {
        this.emojiQuery = emojiResults.data.query;
        this.emojiResults = emojiResults.data.emojis;
        return;
      }

      const event = parseRealtimeEvent(message);
      if (!event) return;

      if (event.type === 'guild.created') {
        chat.addGuild(event.data);
        event.data.channels.forEach((channel) => {
          chat.addChannel(channel);
        });
        this.subscribeGuild(event.data.id);
        chat.selectServer(event.data.id);
      }
      if (event.type === 'channel.created') {
        chat.addChannel(event.data);
      }
      if (event.type === 'message.created') {
        chat.addMessage(event.data);
        chat.clearTyping(event.data.channelId, event.data.author.id);
      }
      if (event.type === 'message.deleted') {
        chat.removeMessage(event.data.channelId, event.data.id);
      }
      if (event.type === 'user.status.changed') {
        chat.updateMemberStatus(event.data.userId, event.data.status);
      }
      if (event.type === 'member.joined') {
        chat.addOrUpdateMember(event.data.guildId, event.data.user);
      }
      if (event.type === 'voice.states.snapshot') {
        chat.setVoiceStates(event.data.guildIds, event.data.states);
      }
      if (event.type === 'voice.state.changed') {
        chat.updateVoiceState(event.data);
      }
      if (event.type === 'channel.typing') {
        chat.setTyping(
          event.data.channelId,
          event.data.userId,
          event.data.displayName ?? event.data.username
        );
      }
    });
  }

  private scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return;

    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  subscribeGuild(guildId: string) {
    if (!this.socket || !this.connected) return;

    this.socket.send({ type: 'subscribe.guild', guildId });
  }

  searchEmojis(query: string) {
    if (!this.socket || !this.connected) return;

    this.socket.send({ type: 'emoji.search', query });
  }

  joinVoice(channelId: string) {
    this.voiceChannelId = channelId;
    if (!this.socket || !this.connected) return;

    this.socket.send({ type: 'voice.join', channelId });
  }

  leaveVoice() {
    this.voiceChannelId = null;
    if (!this.socket || !this.connected) return;

    this.socket.send({ type: 'voice.leave' });
  }
}

export const realtime = new RealtimeState();
