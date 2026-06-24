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
  return event.success ? event.data : null;
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
      const event = parseRealtimeEvent(data);
      if (!event) return;

      if (event.type === 'guild.created') {
        chat.addGuild(event.data);
        event.data.channels.forEach((channel) => {
          chat.addChannel(channel);
        });
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
    });

    return () => socket.close();
  }
}

export const realtime = new RealtimeState();
