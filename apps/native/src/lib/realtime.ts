// Port of apps/frontend/src/lib/realtime.svelte.ts
import { create } from 'zustand';
import { z } from 'zod';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { publicUserSchema } from 'anchor/public-user';
import type { RealtimeEvent } from 'anchor';
import { anchor } from './anchor';
import { chat, selectActiveChannel } from './chat-state';
import { settings } from './settings';
import { session } from './session';
import { goto } from './navigation';
import {
  messageNotificationTitle,
  notificationSound,
  sendNotification,
  shouldNotify,
} from './notifications';
import { notificationSettings } from './notification-settings';
import { friends } from './friends';
import { dms, dmPath } from './dms';

const channelTypeSchema = z.enum(['TEXT', 'VOICE']);
const userStatusSchema = z.enum(['ONLINE', 'OFFLINE']);
const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string().url(),
  previewUrl: z.string().url(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});

const emojiSchema = z.object({
  name: z.string(),
  unicode: z.string(),
  url: z.string().url(),
});

const emojiSearchResultsSchema = z.object({
  type: z.literal('emoji.search.results'),
  data: z.object({
    query: z.string(),
    emojis: z.array(emojiSchema),
  }),
});

const emojiQueryResultsSchema = z.object({
  type: z.literal('emoji.query.results'),
  data: z.object({
    unicodes: z.array(z.string()),
    emojis: z.array(emojiSchema),
  }),
});

const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  type: channelTypeSchema,
  guildId: z.string(),
});

// eden revives ISO date strings in ws payloads into Date objects, so every date field
// below has to accept both.
const isoDateSchema = z.union([z.string(), z.date().transform((date) => date.toISOString())]);
const dmParticipantsSchema = z.array(publicUserSchema);
const dmChannelSchema = z.object({
  id: z.string(),
  type: z.enum(['DM', 'GROUP_DM']),
  participants: dmParticipantsSchema,
  lastMessageAt: isoDateSchema.nullable(),
  unread: z.boolean(),
  joinedAt: isoDateSchema,
});

const messageEventDataSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  guildId: z.string().nullable(),
  content: z.string().nullable(),
  nonce: z.string(),
  replyTo: z.string().nullable().default(null),
  editedTime: z.string().optional(),
  pingedHandles: z.array(z.string()).default([]),
  attachments: z.array(attachmentSchema),
  createdAt: isoDateSchema,
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
      channels: z.array(channelSchema),
    }),
  }),
  z.object({
    type: z.literal('channel.created'),
    data: channelSchema,
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
    type: z.literal('dm.created'),
    data: dmChannelSchema,
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
      dmIds: z.array(z.string()).optional(),
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
      time: isoDateSchema,
    }),
  }),
  z.object({
    type: z.literal('guild.channels.reordered'),
    data: z.object({
      guildId: z.string(),
      channelIds: z.array(z.string()),
    }),
  }),
  z.object({
    type: z.literal('friends.changed'),
    data: z.object({}),
  }),
  z.object({
    type: z.literal('member.updated'),
    data: z.object({ guildId: z.string(), user: publicUserSchema }),
  }),
  z.object({
    type: z.literal('user.updated'),
    data: z.object({
      user: publicUserSchema,
    }),
  }),
]) satisfies z.ZodType<RealtimeEvent>;

// eden revives JSON frames into the payload itself; a raw socket frame can still arrive as a string or as `{ data }`
function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> | null {
  const parse = (value: unknown) => {
    const text = z.string().safeParse(value);
    return schema.safeParse(text.success ? safeJson(text.data) : value);
  };

  const direct = parse(data);
  if (direct.success) return direct.data;

  const wrapped = z.object({ data: z.unknown() }).safeParse(data);
  const unwrapped = wrapped.success ? parse(wrapped.data.data) : null;
  return unwrapped?.success ? unwrapped.data : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type Socket = ReturnType<ReturnType<typeof anchor>['client']['realtime']['subscribe']>;

// The socket and timers are plain module state (not reactive), like the private fields on the web
let socket: Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let active = false;
let shouldRecover = false;
let voiceChannelId: string | null = null;
let emojiQueryTimer: ReturnType<typeof setTimeout> | null = null;
const pendingEmojiUnicodes = new Set<string>();
const missingEmojiUnicodes = new Set<string>();
const queuedEmojiUnicodes = new Set<string>();

const isForeground = () => AppState.currentState === 'active';

type RealtimeStore = {
  connected: boolean;
  emojiQuery: string;
  emojiResults: z.infer<typeof emojiSearchResultsSchema>['data']['emojis'];
  emojiUrls: Record<string, string>;
  connect: () => () => void;
  subscribeGuild: (guildId: string) => void;
  searchEmojis: (query: string) => void;
  queryEmojis: (unicodes: string[]) => void;
  joinVoice: (channelId: string) => void;
  ringCall: (channelId: string, ringing?: boolean) => void;
  leaveVoice: () => void;
};

export const useRealtime = create<RealtimeStore>((set, get) => {
  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = () => {
    if (!active || reconnectTimer) return;

    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  };

  // the server skips push for users with an active app, so it has to hear when this one stops being it
  // (a socket that is still connecting throws on `send` in React Native)
  const sendClientState = () => {
    if (get().connected) socket?.send({ type: 'client.state', active: isForeground() });
  };

  const flushEmojiQuery = () => {
    emojiQueryTimer = null;
    const unicodes = [...queuedEmojiUnicodes].slice(0, 100);
    unicodes.forEach((unicode) => queuedEmojiUnicodes.delete(unicode));

    if (socket && get().connected) socket.send({ type: 'emoji.query', unicodes });
    else unicodes.forEach((unicode) => pendingEmojiUnicodes.delete(unicode));

    if (queuedEmojiUnicodes.size) {
      emojiQueryTimer = setTimeout(flushEmojiQuery, 16);
    }
  };

  const handleEvent = async (message: unknown) => {
    const emojiQueryResults = parseWith(emojiQueryResultsSchema, message);
    if (emojiQueryResults) {
      const found = new Set(emojiQueryResults.data.emojis.map((emoji) => emoji.unicode));
      set({
        emojiUrls: {
          ...get().emojiUrls,
          ...Object.fromEntries(emojiQueryResults.data.emojis.map((e) => [e.unicode, e.url])),
        },
      });
      for (const unicode of emojiQueryResults.data.unicodes) {
        pendingEmojiUnicodes.delete(unicode);
        if (!found.has(unicode)) missingEmojiUnicodes.add(unicode);
      }
      return;
    }

    const emojiResults = parseWith(emojiSearchResultsSchema, message);
    if (emojiResults) {
      set({ emojiQuery: emojiResults.data.query, emojiResults: emojiResults.data.emojis });
      return;
    }

    const event = parseWith(realtimeEventSchema, message);
    if (!event) return;

    if (event.type === 'guild.created') {
      chat().addGuild(event.data);
      event.data.channels.forEach((channel) => {
        chat().addChannel(channel);
      });
      get().subscribeGuild(event.data.id);
      chat().selectServer(event.data.id);
    }
    if (event.type === 'channel.created') {
      chat().addChannel(event.data);
    }
    if (event.type === 'message.created') {
      const { user } = session();
      const isDm = event.data.guildId === null;
      const activeChannel = selectActiveChannel(chat());
      const isActive = activeChannel === event.data.channelId;

      if (
        user &&
        shouldNotify(event.data, {
          user,
          activeChannelId: activeChannel,
          hasFocus: isForeground(),
          entries: notificationSettings().entries,
        })
      ) {
        // the sound follows its own switch, so it plays even with system notifications off
        if (settings().mentionSound) notificationSound();
        if (settings().pushNotifications) {
          const guild = chat().servers.find((server) => server.id === event.data.guildId);
          const channel = chat()
            .channelsByServer[event.data.guildId ?? '']?.flatMap((category) => category.channels)
            .find((item) => item.id === event.data.channelId);
          // fed: ids stay as they are, so the link opens the shadow guild or DM
          const url = isDm
            ? dmPath(event.data.channelId)
            : `/guilds/${[event.data.guildId!, event.data.channelId, event.data.id]
                .map(encodeURIComponent)
                .join('/')}`;
          void sendNotification({
            title: messageNotificationTitle(
              event.data.author,
              isDm ? null : { channel: channel?.name, guild: guild?.name }
            ),
            body: settings().messagePreview
              ? (event.data.content ?? 'Sent an attachment')
              : isDm
                ? 'Sent you a message'
                : 'Mentioned you',
            icon: event.data.author.avatarUrl ?? undefined,
            tag: event.data.channelId,
            url,
            onClick: () => void goto(url),
          });
        }
      }

      chat().addMessage(event.data);
      chat().clearTyping(event.data.channelId, event.data.author.userId);

      if (isDm) {
        dms().handleMessage(event.data.channelId, event.data.createdAt, {
          active: isActive,
          fromSelf: user ? event.data.author.userId === user.id : false,
        });
      }
    }
    if (event.type === 'message.updated') {
      chat().updateMessage(event.data.channelId, { ...event.data, edited: true });
    }
    if (event.type === 'message.deleted') {
      chat().removeMessage(event.data.channelId, event.data.id);
    }
    if (event.type === 'user.status.changed') {
      chat().updateMemberStatus(event.data.userId, event.data.status);
      friends().updateStatus(event.data.userId, event.data.status);
    }
    if (event.type === 'member.joined') {
      chat().addOrUpdateMember(event.data.guildId, event.data.user);
    }
    if (event.type === 'voice.states.snapshot') {
      chat().setVoiceStates(event.data.guildIds, event.data.states, event.data.dmIds);
    }
    if (event.type === 'voice.state.changed') {
      chat().updateVoiceState(event.data);
    }
    if (event.type === 'call.ringing') {
      const { user } = session();
      const { channelId, user: caller, ringing } = event.data;
      const self =
        caller.username === user?.username &&
        caller.homeserver.toLowerCase() === user.homeserver.toLowerCase();

      if (!ringing) {
        // declined on another of my devices, or the other person declined my call.
        if (dms().incomingCall?.channelId === channelId) dms().setIncomingCall(null);
        if (!self && dms().outgoingCall === channelId) dms().setOutgoingCall(null);
      } else if (!self) {
        dms().setIncomingCall({ channelId, user: caller });
        if (!isForeground() && settings().pushNotifications) {
          notificationSound();
          void sendNotification({
            title: caller.displayName || caller.username,
            body: 'Is calling you',
            icon: caller.avatarUrl ?? undefined,
            tag: `call:${channelId}`,
            url: dmPath(channelId),
            onClick: () => void goto(dmPath(channelId)),
          });
        }
      }
    }
    if (event.type === 'channel.typing') {
      chat().setTyping(
        event.data.channelId,
        event.data.userId,
        event.data.username,
        event.data.homeserver,
        event.data.displayName ?? event.data.username
      );
    }
    if (event.type === 'guild.channels.reordered') {
      chat().reorderChannels(event.data.guildId, event.data.channelIds);
    }
    if (event.type === 'friends.changed') {
      void friends().load();
    }
    if (event.type === 'user.updated') {
      chat().updateUserProfile(event.data.user.userId, event.data.user);
    }
    if (event.type === 'member.updated') {
      chat().updateMemberProfile(event.data.guildId, event.data.user);
    }
    if (event.type === 'dm.created') {
      dms().upsert(event.data);
    }
  };

  // forgets what only made sense on the old connection
  const resetConnectionState = () => {
    if (emojiQueryTimer) clearTimeout(emojiQueryTimer);
    emojiQueryTimer = null;
    queuedEmojiUnicodes.clear();
    pendingEmojiUnicodes.clear();
  };

  function openSocket() {
    if (!active || socket) return;

    const current = anchor().client.realtime.subscribe();
    socket = current;

    current.on('open', () => {
      if (!active || socket !== current) return;

      set({ connected: true });
      reconnectAttempt = 0;
      sendClientState();

      for (const guild of chat().servers) get().subscribeGuild(guild.id);
      if (voiceChannelId) current.send({ type: 'voice.join', channelId: voiceChannelId });

      if (shouldRecover) {
        shouldRecover = false;
        void chat()
          .recoverRealtimeState()
          .catch((error) => console.error('Failed to recover realtime state', error));
      }
    });

    current.on('close', () => {
      if (socket !== current) return;

      socket = null;
      set({ connected: false });
      resetConnectionState();
      shouldRecover = true;
      scheduleReconnect();
    });

    // a socket that was replaced or closed on purpose must not touch the stores any more
    current.subscribe((message) => {
      if (socket === current) void handleEvent(message);
    });
  }

  return {
    connected: false,
    emojiQuery: '',
    emojiResults: [],
    emojiUrls: {},

    connect() {
      active = true;

      const reconnectWhenOnline = () => {
        if (!active || get().connected) return;

        clearReconnectTimer();
        openSocket();
      };

      const stopNetInfo = NetInfo.addEventListener((state) => {
        if (state.isConnected) reconnectWhenOnline();
      });
      // phones suspend sockets in the background without a `close` event, so after a while away
      // the old one is dropped and a new one recovers whatever was missed
      let backgroundedAt = 0;
      const appState = AppState.addEventListener('change', (state) => {
        if (state !== 'active') backgroundedAt ||= Date.now();
        else {
          const away = backgroundedAt ? Date.now() - backgroundedAt : 0;
          backgroundedAt = 0;
          if (active && socket && away > 10_000) {
            const stale = socket;
            socket = null;
            set({ connected: false });
            resetConnectionState();
            shouldRecover = true;
            stale.close();
            clearReconnectTimer();
            openSocket();
          }
        }
        sendClientState();
      });
      openSocket();

      return () => {
        active = false;
        clearReconnectTimer();
        stopNetInfo();
        appState.remove();

        const closing = socket;
        socket = null;
        closing?.close();

        // the next connect() may be another account's
        resetConnectionState();
        reconnectAttempt = 0;
        shouldRecover = false;
        voiceChannelId = null;
        missingEmojiUnicodes.clear();
        set({ connected: false, emojiQuery: '', emojiResults: [], emojiUrls: {} });
      };
    },

    subscribeGuild(guildId) {
      if (!socket || !get().connected) return;

      socket.send({ type: 'subscribe.guild', guildId });
    },

    searchEmojis(query) {
      if (!socket || !get().connected) return;

      socket.send({ type: 'emoji.search', query });
    },

    queryEmojis(unicodes) {
      if (!socket || !get().connected) return;

      for (const unicode of unicodes.map((unicode) => unicode.toUpperCase())) {
        if (
          !get().emojiUrls[unicode] &&
          !pendingEmojiUnicodes.has(unicode) &&
          !missingEmojiUnicodes.has(unicode)
        ) {
          queuedEmojiUnicodes.add(unicode);
          pendingEmojiUnicodes.add(unicode);
        }
      }

      if (queuedEmojiUnicodes.size && !emojiQueryTimer) {
        emojiQueryTimer = setTimeout(flushEmojiQuery, 16);
      }
    },

    joinVoice(channelId) {
      voiceChannelId = channelId;
      if (!socket || !get().connected) return;

      socket.send({ type: 'voice.join', channelId });
    },

    ringCall(channelId, ringing = true) {
      if (get().connected) socket?.send({ type: 'call.ring', channelId, ringing });
      if (ringing) dms().setOutgoingCall(channelId);
    },

    leaveVoice() {
      voiceChannelId = null;
      if (!socket || !get().connected) return;

      socket.send({ type: 'voice.leave' });
    },
  };
});

// Same name as on the web, for code that runs outside React: `realtime().joinVoice(id)`
export const realtime = useRealtime.getState;
