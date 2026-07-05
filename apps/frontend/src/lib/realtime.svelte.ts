import { anchor } from './anchor.svelte';
import { chat } from './chat-state.svelte';
import { z } from 'zod';
import type { RealtimeEvent } from 'anchor';

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
      createdAt: z.union([z.string(), z.date().transform((date) => date.toISOString())]),
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

class RealtimeState {
  connected = $state(false);
  private socket: ReturnType<typeof anchor.client.realtime.subscribe> | null = null;

  connect() {
    const socket = anchor.client.realtime.subscribe();
    this.socket = socket;

    socket.on('open', () => {
      this.connected = true;
    });

    socket.on('close', () => {
      this.connected = false;
    });

    socket.subscribe((message) => {
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
    });

    return () => {
      if (this.socket === socket) this.socket = null;
      socket.close();
    };
  }

  subscribeGuild(guildId: string) {
    if (!this.socket || !this.connected) return;

    this.socket.send({ type: 'subscribe.guild', guildId });
  }

  joinVoice(channelId: string) {
    if (!this.socket || !this.connected) return;

    this.socket.send({ type: 'voice.join', channelId });
  }

  leaveVoice() {
    if (!this.socket || !this.connected) return;

    this.socket.send({ type: 'voice.leave' });
  }
}

export const realtime = new RealtimeState();
