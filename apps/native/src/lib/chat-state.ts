// Port of apps/frontend/src/lib/chat-state.svelte.ts
import { create } from 'zustand';
import { z } from 'zod';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { PublicUser } from 'anchor/public-user';
import { anchor } from './anchor';
import { dms, dmPath, useDms, type DmEntry } from './dms';
import { goHome, goto } from './navigation';
import { session } from './session';
import { storage } from './storage';
import type { Author, Channel, ChannelCategory, ChatRoute, Message, Server } from './types/chat';

function initialsFor(name: string) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return initials || name.slice(0, 1).toUpperCase();
}

type AddChannelInput = {
  id: string;
  guildId: string;
  name: string;
  position?: number;
  type?: string;
  topic?: string;
  unread?: boolean;
  lastReadMessageId?: string | null;
  mention?: number;
};

type AddMessageInput = {
  id: string;
  channelId: string;
  content: string | null;
  createdAt: string | Date;
  edited?: boolean;
  editedTime?: string;
  replyTo?: string | null;
  pingedHandles?: string[];
  author: PublicUser;
  attachments?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    url: string;
    previewUrl: string;
    width?: number | null;
    height?: number | null;
  }[];
};

type ChannelMemberInput = PublicUser & {
  status: 'ONLINE' | 'OFFLINE';
};

type VoicePresenceInput = {
  guildId: string | null;
  channelId: string;
  userId: string;
  name: string | null;
};

export type TypingInput = {
  userId: string;
  name: string;
  expiresAt: number;
};

// A file picked from the camera, gallery or document picker (the web uses `File`)
export type PickedFile = { uri: string; name: string; mimeType: string; size: number };

const typingRequestIntervalMs = 5_000;
const typingExpiryMs = 6_000;
const messagesPageSize = 50;
const reencodedImageFormats = {
  'image/jpeg': SaveFormat.JPEG,
  'image/png': SaveFormat.PNG,
  'image/webp': SaveFormat.WEBP,
} as Record<string, SaveFormat | undefined>;

// re-encoding drops EXIF and other metadata (GIFs and other types are uploaded untouched)
async function stripImageMetadata(file: PickedFile): Promise<PickedFile> {
  const format = reencodedImageFormats[file.mimeType];
  if (!format) return file;

  try {
    const image = await ImageManipulator.manipulate(file.uri).renderAsync();
    const saved = await image.saveAsync({
      format,
      compress: format === SaveFormat.JPEG ? 0.92 : 1,
    });
    return { ...file, uri: saved.uri, size: new File(saved.uri).size };
  } catch {
    throw new Error(`Could not process ${file.name}`);
  }
}

function messageFromInput(message: AddMessageInput): Message {
  return {
    id: message.id,
    author: authorFromInput(message.author),
    content: message.content ?? '',
    timestamp: new Date(message.createdAt),
    edited: message.edited ?? false,
    editedTime: message.editedTime ?? undefined,
    attachments: message.attachments ?? [],
    replyTo: message.replyTo ?? null,
    pingedHandles: message.pingedHandles ?? [],
  };
}

function memberFromInput(member: ChannelMemberInput): Author {
  const { status, ...user } = member;
  return { ...authorFromInput(user), status };
}

function authorFromInput({ homeserver, ...user }: PublicUser): Author {
  return {
    ...user,
    server: homeserver,
  };
}

function channelTypeFor(type: string | undefined): Channel['type'] {
  if (type === 'VOICE') return 'VOICE';

  return 'TEXT';
}

// builds the synthetic Channel the UI expects out of a DM's participants.
// Cached per entry so `selectCurrentChannel` returns a stable reference.
const dmChannels = new WeakMap<DmEntry, Channel>();
function dmChannel(entry: DmEntry | null): Channel | null {
  if (!entry) return null;

  const cached = dmChannels.get(entry);
  if (cached) return cached;

  const other = entry.participants[0];
  const channel: Channel = {
    id: entry.id,
    name: other ? other.displayName || other.username : 'Direct Message',
    unread: entry.unread,
    lastReadMessageId: null,
    mention: 0,
    type: 'DM',
    avatarUrl: other?.avatarUrl ?? null,
    avatarColor: other?.avatarColor ?? null,
  };
  dmChannels.set(entry, channel);
  return channel;
}

export function guildPath(serverId?: string, channelId?: string, messageId?: string) {
  if (!serverId) return '/guilds';

  const path = [serverId, channelId, messageId]
    .filter((part): part is string => Boolean(part))
    .map(encodeURIComponent)
    .join('/');

  return `/guilds/${path}`;
}

// the path of any channel the app knows: a DM or a channel of one of your guilds
export function channelPath(channelId: string, messageId?: string): string {
  if (dms().get(channelId)) return dmPath(channelId, messageId);
  const { channelsByServer } = useChat.getState();
  const guildId = Object.keys(channelsByServer).find((id) =>
    channelsByServer[id]!.some((category) => category.channels.some((c) => c.id === channelId))
  );
  return guildPath(guildId, channelId, messageId);
}

function sendToGuildsIfFederatedServerDown(error: unknown) {
  const status = z.object({ status: z.coerce.number() }).safeParse(error);
  if (!status.success || status.data.status !== 502) return false;

  goHome();
  return true;
}

// a catch-all route param is a plain string when it has only one segment
export const pathSegments = z
  .string()
  .transform((segment) => [segment])
  .or(z.array(z.string()))
  .catch([]);

// `path` is the URL below `/guilds` (the channel screen's `[server]/[...rest]` params); the web reads it from the URL
export function routeFromPath(path: string[]): ChatRoute {
  const [first, second, third] = path.filter(Boolean);

  if (!first) return { kind: 'home' };
  if (first === 'dms') return { kind: 'dms', channelId: second ?? null, messageId: third ?? null };

  return {
    kind: 'guild',
    serverId: first,
    channelId: second ?? null,
    messageId: third ?? null,
  };
}

// Selectors replace the web's `$derived`/getters. Use `useChat(selectX)`.
// They return references that already live in the store (or a shared empty constant), so they are safe
// as plain Zustand v5 selectors. Do not wrap them in `(s) => [...selectX(s)]`.
const noCategories: ChannelCategory[] = [];
const noMessages: Message[] = [];
const noTyping: TypingInput[] = [];

type ChatStateData = Pick<
  ChatState,
  'route' | 'servers' | 'channelsByServer' | 'messagesByChannel' | 'typingByChannel'
>;

export const selectActiveServer = (state: Pick<ChatState, 'route'>) =>
  state.route.kind === 'guild' ? state.route.serverId : null;

export const selectActiveChannel = (state: Pick<ChatState, 'route'>) =>
  state.route.kind === 'guild' || state.route.kind === 'dms' ? state.route.channelId : null;

export const selectActiveMessage = (state: Pick<ChatState, 'route'>) =>
  state.route.kind === 'guild' || state.route.kind === 'dms'
    ? (state.route.messageId ?? null)
    : null;

export const selectCurrentServer = (state: ChatStateData) => {
  const activeServer = selectActiveServer(state);
  return activeServer ? (state.servers.find((server) => server.id === activeServer) ?? null) : null;
};

export const selectCurrentCategories = (state: ChatStateData) => {
  const activeServer = selectActiveServer(state);
  return activeServer ? (state.channelsByServer[activeServer] ?? noCategories) : noCategories;
};

// For a DM this also reads the dms store (`useDms.subscribe` at the bottom re-runs selectors when it changes)
export const selectCurrentChannel = (state: ChatStateData): Channel | null => {
  const activeChannel = selectActiveChannel(state);
  if (!activeChannel) return null;

  if (state.route.kind === 'dms') return dmChannel(dms().get(activeChannel));

  for (const category of selectCurrentCategories(state)) {
    const channel = category.channels.find((item) => item.id === activeChannel);
    if (channel) return channel;
  }

  return null;
};

export const selectCurrentMessages = (state: ChatStateData) => {
  const channel = selectCurrentChannel(state);
  return channel ? (state.messagesByChannel[channel.id] ?? noMessages) : noMessages;
};

export const selectCurrentMessagesLoading = (
  state: ChatStateData & Pick<ChatState, 'messagesLoadingByChannel' | 'loadedChannel'>
) => {
  const channel = selectCurrentChannel(state);
  // a channel opened before shows its cached messages while they refresh, instead of skeletons
  if (!channel || state.messagesByChannel[channel.id]?.length) return false;
  return (
    (state.messagesLoadingByChannel[channel.id] ?? false) || channel.id !== state.loadedChannel
  );
};

export const selectCurrentTyping = (state: ChatStateData) => {
  const channel = selectCurrentChannel(state);
  return channel ? (state.typingByChannel[channel.id] ?? noTyping) : noTyping;
};

type ChatState = {
  servers: Server[];
  channelsByServer: Record<string, ChannelCategory[]>;
  messagesByChannel: Record<string, Message[]>;
  messagesLoadingByChannel: Record<string, boolean>;
  members: Author[];
  voiceStates: Record<string, VoicePresenceInput[]>;
  typingByChannel: Record<string, TypingInput[]>;
  loadingOlderByChannel: Record<string, boolean>;
  loadedChannel: string | null;
  // the web derives this from the URL; the focused screen sets it: a channel screen its channel, the hub `home`
  route: ChatRoute;
  // the server picked in the hub's guild rail (null is Home: the DMs)
  hubServer: string | null;
  editingMessage: boolean;
  editingMessageId: string | null;
  uploadProgress: Record<number, number>;

  setRoute: (route: ChatRoute) => void;
  selectServer: (id?: string) => void | undefined;
  selectChannel: (id: string) => void | undefined;
  messagePath: (id: string) => string;
  syncActiveChannel: () => void;
  addGuild: (guild: {
    id: string;
    name: string;
    down?: boolean;
    ownerId?: string;
    canManageChannels?: boolean;
    avatarUrl?: string | null;
    description?: string | null;
  }) => void;
  setGuildCategories: (guildId: string, categories: ChannelCategory[]) => void;
  addChannel: (channel: AddChannelInput) => Channel;
  setMessages: (channelId: string, messages: AddMessageInput[]) => void;
  addMessage: (message: AddMessageInput) => void;
  removeMessage: (channelId: string, messageId: string) => void;
  updateMessage: (channelId: string, message: AddMessageInput) => void;
  updateMemberStatus: (userId: string, status: 'ONLINE' | 'OFFLINE') => void;
  updateUserProfile: (
    userId: string,
    profile: Partial<
      Pick<
        Author,
        'displayName' | 'avatarUrl' | 'avatarColor' | 'speakingRingColor' | 'bannerUrl' | 'about'
      >
    >
  ) => void;
  addOrUpdateMember: (guildId: string, member: ChannelMemberInput) => void;
  setVoiceStates: (guildIds: string[], states: VoicePresenceInput[], dmIds?: string[]) => void;
  updateVoiceState: (state: VoicePresenceInput & { connected: boolean }) => void;
  sendMessage: (
    channelId: string,
    content: string | null,
    files?: PickedFile[],
    replyTo?: string | null,
    onProgress?: (index: number, fraction: number) => void
  ) => Promise<void>;
  deleteMessage: (channelId: string, messageId: string) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string | null) => Promise<void>;
  loadMessages: (
    channelId: string
  ) => Promise<{ id: string; createdAt: string | Date } | undefined>;
  loadOlderMessages: (channelId: string) => Promise<void>;
  hasMoreMessages: (channelId: string) => boolean;
  onTyping: () => Promise<void>;
  setTyping: (
    channelId: string,
    userId: string,
    username: string,
    homeserver: string,
    name: string
  ) => void;
  clearTyping: (channelId: string, userId: string) => void;
  loadMembers: (channelId: string) => Promise<void>;
  createServer: (server: Server) => Promise<void>;
  updateGuildAvatar: (guildId: string, avatarUrl: string) => void;
  createLocalChannel: (categoryId: string, channel: Channel) => void;
  createChannel: (
    guildId: string,
    channel: Channel,
    type: 'TEXT' | 'VOICE'
  ) => Promise<Channel | undefined>;
  createGuildInvite: (guildId: string) => Promise<unknown>;
  getGuildInvite: (inviteCode: string) => Promise<unknown>;
  loadInitialData: () => Promise<void>;
  recoverRealtimeState: () => Promise<void>;
  reorderGuilds: (guilds: string[]) => Promise<void>;
  reorderChannels: (guildId: string, channelIds: string[]) => void;
  saveChannelOrder: (guildId: string, channelIds: string[]) => Promise<void>;
  // native-only: the web reloads the page when the account changes
  reset: () => void;
};

// not reactive on the web either
const lastTypingByChannel = new Map<string, number>();
const nextCursorByChannel = new Map<string, number>();
const hasMoreByChannel = new Map<string, boolean>();
let resetCount = 0;

// Native-only: where you were, kept across launches like a phone chat app does: the hub's server, the last text
// channel of each guild (reopened when you tap the guild; `dms` for the last DM) and the chat open when the app closed (reopened on
// launch by the hub). Kept per account, since a reload or the app closing also runs `reset`.
const navKey = (name: string) => `nav:${session().user?.id ?? ''}:${name}`;
// the last page of each channel, shown instantly next time while the fresh one loads (also per account)
const messagesKey = (channelId: string) => `messages:${session().user?.id ?? ''}:${channelId}`;
export const lastHubServer = () => storage.getString(navKey('hub-server')) ?? null;
export const lastChat = () => storage.getString(navKey('last-chat')) ?? null;
export const lastGuildChannel = (guildId: string) =>
  storage.getString(navKey(`channel:${guildId}`)) ?? null;

const initialData = () => ({
  servers: [],
  channelsByServer: {},
  messagesByChannel: {},
  messagesLoadingByChannel: {},
  members: [],
  voiceStates: {},
  typingByChannel: {},
  loadingOlderByChannel: {},
  loadedChannel: null,
  route: { kind: 'home' } as ChatRoute,
  hubServer: null as string | null,
  editingMessage: false,
  editingMessageId: null,
  uploadProgress: {},
});

function messageNonce() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export const useChat = create<ChatState>((set, get) => {
  const setChannelMessages = (channelId: string, messages: Message[]) =>
    set({ messagesByChannel: { ...get().messagesByChannel, [channelId]: messages } });

  const setFlag = (
    key: 'messagesLoadingByChannel' | 'loadingOlderByChannel',
    channelId: string,
    value: boolean
  ) => set({ [key]: { ...get()[key], [channelId]: value } });

  const setChannelUnread = (
    channelId: string,
    unread: boolean,
    lastReadMessageId?: string | null,
    mention?: number
  ) => {
    let changed = false;
    const nextChannelsByServer: Record<string, ChannelCategory[]> = {};

    for (const [guildId, categories] of Object.entries(get().channelsByServer)) {
      nextChannelsByServer[guildId] = categories.map((category) => ({
        ...category,
        channels: category.channels.map((channel) => {
          if (
            channel.id !== channelId ||
            (channel.unread === unread &&
              (lastReadMessageId === undefined ||
                channel.lastReadMessageId === lastReadMessageId) &&
              (mention === undefined || channel.mention === mention))
          )
            return channel;

          changed = true;
          return {
            ...channel,
            unread,
            mention: mention ?? channel.mention,
            lastReadMessageId:
              lastReadMessageId === undefined ? channel.lastReadMessageId : lastReadMessageId,
          };
        }),
      }));
    }

    if (changed) set({ channelsByServer: nextChannelsByServer });
  };

  const incrementChannelMention = (channelId: string) => {
    for (const categories of Object.values(get().channelsByServer)) {
      for (const category of categories) {
        const channel = category.channels.find((item) => item.id === channelId);
        if (channel) return setChannelUnread(channelId, true, undefined, channel.mention + 1);
      }
    }
  };

  const markRead = async (channelId: string, messageId: string, createdAt: string | Date) => {
    const result = await anchor()
      .client.channel({ id: channelId })
      .read.post({
        messageId,
        createdAt: new Date(createdAt).toISOString(),
      });
    if (!result.error && result.data && !('error' in result.data)) {
      const latestMessage = get().messagesByChannel[channelId]?.at(-1);
      if (latestMessage?.id === messageId) {
        if (dms().get(channelId)) dms().markRead(channelId);
        else setChannelUnread(channelId, false, messageId, 0);
      }
    }
  };

  const expireTyping = (channelId: string, userId: string, expiresAt: number) =>
    set({
      typingByChannel: {
        ...get().typingByChannel,
        [channelId]: (get().typingByChannel[channelId] ?? []).filter(
          (item) => item.userId !== userId || item.expiresAt !== expiresAt
        ),
      },
    });

  const firstChannelForServer = (serverId?: string) =>
    serverId
      ? get().channelsByServer[serverId]?.[0]?.channels.filter((c) => c.type === 'TEXT')[0]
      : null;

  const loadGuilds = async () => {
    const count = resetCount;
    const result = await anchor().client.guilds.list.get();

    if (result.error || !result.data || count !== resetCount) return;

    for (const guild of result.data.guilds) {
      get().addGuild(guild);

      for (const channel of guild.channels) {
        get().addChannel(channel);
      }
    }
  };

  const loadCurrentChannel = async () => {
    const channelId = selectCurrentChannel(get())?.id ?? null;
    set({ loadedChannel: channelId });

    // the hub keeps the last guild's members, so its voice channels still show avatars
    if (!channelId) return;

    const isDm = get().route.kind === 'dms';
    const [lastMessage] = await Promise.all([
      get().loadMessages(channelId),
      isDm ? Promise.resolve() : get().loadMembers(channelId),
    ]);
    if (!lastMessage) {
      if (isDm) dms().markRead(channelId);
      else setChannelUnread(channelId, false, undefined, 0);
      return;
    }

    await markRead(channelId, lastMessage.id, lastMessage.createdAt);
  };

  const selectInitialChannel = () => {
    const activeServer = selectActiveServer(get());
    if (!activeServer) return;

    const currentServer = selectCurrentServer(get());
    if (currentServer?.down) return goHome();

    const serverId = currentServer?.id;
    const channelId =
      selectCurrentChannel(get())?.id ?? firstChannelForServer(serverId)?.id ?? null;

    if (serverId !== activeServer || channelId !== selectActiveChannel(get())) {
      return goto(guildPath(serverId, channelId ?? undefined), { replaceState: true });
    }
  };

  // presigned flow: ask the server for a URL, PUT the bytes straight to storage, send the id with the message
  const uploadAttachment = async (
    channelId: string,
    file: PickedFile,
    index: number,
    onProgress?: (index: number, fraction: number) => void
  ) => {
    const presign = await anchor().client.upload.presign.post({
      channelId,
      filename: file.name,
      contentType: file.mimeType || 'application/octet-stream',
      size: file.size,
    });
    if (presign.error || !presign.data || 'error' in presign.data) {
      throw new Error(`Could not prepare ${file.name} for upload`);
    }

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', presign.data.uploadUrl);
      for (const [name, value] of Object.entries(presign.data.headers as Record<string, string>)) {
        xhr.setRequestHeader(name, value);
      }
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const fraction = event.loaded / event.total;
        set({ uploadProgress: { ...get().uploadProgress, [index]: fraction } });
        onProgress?.(index, fraction);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      // React Native streams a `{ uri }` body straight from disk (no need to load it into memory)
      xhr.send({ uri: file.uri } as unknown as XMLHttpRequestBodyInit);
    });
    return presign.data.attachmentId;
  };

  return {
    ...initialData(),

    setRoute(route) {
      if (JSON.stringify(route) === JSON.stringify(get().route)) return;
      // going back from a channel shows its server in the hub
      set(route.kind === 'guild' ? { route, hubServer: route.serverId } : { route });
      get().syncActiveChannel();

      if (route.kind === 'guild' && route.serverId)
        storage.set(navKey('hub-server'), route.serverId);
      if (route.kind === 'home') {
        storage.remove(navKey('last-chat'));
        return;
      }
      const channel = selectCurrentChannel(get());
      // a voice channel is a call, not somewhere to land
      if (!channel || channel.type === 'VOICE') return;
      storage.set(navKey('last-chat'), channel.id);
      const hub = route.kind === 'dms' ? 'dms' : route.serverId;
      if (hub) storage.set(navKey(`channel:${hub}`), channel.id);
    },

    selectServer(id) {
      set({ hubServer: id ?? null });
      if (id) storage.set(navKey('hub-server'), id);
      else storage.remove(navKey('hub-server'));
    },

    selectChannel: (id) => goto(channelPath(id)),

    messagePath(id) {
      const activeChannel = selectActiveChannel(get());
      return activeChannel ? channelPath(activeChannel, id) : '/guilds';
    },

    syncActiveChannel() {
      const channelId = selectCurrentChannel(get())?.id ?? null;
      if (channelId === get().loadedChannel) return;

      void loadCurrentChannel();
    },

    addGuild(guild) {
      const down = guild.down ?? false;
      const canManageChannels = guild.canManageChannels ?? guild.ownerId === session().user?.id;

      if (get().servers.some((server) => server.id === guild.id)) {
        set({
          servers: get().servers.map((server) =>
            server.id === guild.id
              ? {
                  ...server,
                  name: guild.name,
                  initials: initialsFor(guild.name),
                  down,
                  canManageChannels,
                  avatarUrl: guild.avatarUrl ?? null,
                  description: guild.description ?? null,
                }
              : server
          ),
        });
        return;
      }

      set({
        servers: [
          ...get().servers,
          {
            id: guild.id,
            name: guild.name,
            initials: initialsFor(guild.name),
            down,
            canManageChannels,
            avatarUrl: guild.avatarUrl ?? null,
            description: guild.description ?? null,
            ownerId: guild.ownerId,
          },
        ],
      });
    },

    setGuildCategories: (guildId, categories) =>
      set({ channelsByServer: { ...get().channelsByServer, [guildId]: categories } }),

    addChannel(channel) {
      const categories = [...(get().channelsByServer[channel.guildId] ?? [])];
      const existingChannel = categories
        .flatMap((category) => category.channels)
        .find((item) => item.id === channel.id);

      if (existingChannel) {
        setChannelUnread(
          channel.id,
          channel.unread ?? existingChannel.unread,
          channel.lastReadMessageId,
          channel.mention
        );
        return existingChannel;
      }

      const nextChannel: Channel = {
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        unread: channel.unread ?? false,
        lastReadMessageId: channel.lastReadMessageId ?? null,
        mention: channel.mention ?? 0,
        type: channelTypeFor(channel.type),
      };

      const textCategoryIndex = categories.findIndex((category) => category.id === 'text');

      if (textCategoryIndex === -1) {
        categories.push({
          id: 'text',
          label: 'Text Channels',
          channels: [nextChannel],
        });
      } else {
        const textCategory = categories[textCategoryIndex];
        const nextChannels = [...textCategory.channels];
        nextChannels.splice(
          Math.min(Math.max(channel.position ?? nextChannels.length, 0), nextChannels.length),
          0,
          nextChannel
        );
        categories[textCategoryIndex] = {
          ...textCategory,
          channels: nextChannels,
        };
      }

      get().setGuildCategories(channel.guildId, categories);

      return nextChannel;
    },

    setMessages(channelId, messages) {
      // messages that didn't change keep their object, so a refreshed page doesn't re-render every row
      const current = get().messagesByChannel[channelId] ?? [];
      const byId = new Map(current.map((message) => [message.id, message]));
      const next = messages.map((input) => {
        const message = messageFromInput(input);
        const previous = byId.get(message.id);
        return previous && JSON.stringify(previous) === JSON.stringify(message)
          ? previous
          : message;
      });
      if (next.length === current.length && next.every((message, i) => message === current[i]))
        return;
      setChannelMessages(channelId, next);
    },

    addMessage(message) {
      const channelMessages = get().messagesByChannel[message.channelId] ?? [];
      if (channelMessages.some((item) => item.id === message.id)) return;

      setChannelMessages(message.channelId, [...channelMessages, messageFromInput(message)]);

      if (selectActiveChannel(get()) !== message.channelId) {
        const handle = session().user?.handle.toLowerCase();
        const pinged = handle
          ? message.pingedHandles?.some((pingedHandle) => pingedHandle.toLowerCase() === handle)
          : false;
        setChannelUnread(message.channelId, true);
        if (pinged) incrementChannelMention(message.channelId);
      } else {
        void markRead(message.channelId, message.id, message.createdAt);
      }
    },

    removeMessage(channelId, messageId) {
      const messages = get().messagesByChannel[channelId];
      if (!messages?.some((message) => message.id === messageId)) return;

      setChannelMessages(
        channelId,
        messages.filter((message) => message.id !== messageId)
      );
    },

    updateMessage(channelId, message) {
      const messages = get().messagesByChannel[channelId];
      if (!messages?.some((item) => item.id === message.id)) return;

      setChannelMessages(
        channelId,
        messages.map((item) => (item.id === message.id ? messageFromInput(message) : item))
      );
    },

    updateMemberStatus: (userId, status) =>
      set({
        members: get().members.map((member) =>
          member.userId === userId ? { ...member, status } : member
        ),
      }),

    updateUserProfile: (userId, profile) =>
      set({
        members: get().members.map((member) =>
          member.userId === userId ? { ...member, ...profile } : member
        ),
        messagesByChannel: Object.fromEntries(
          Object.entries(get().messagesByChannel).map(([channelId, messages]) => [
            channelId,
            messages.map((message) =>
              message.author.userId === userId
                ? { ...message, author: { ...message.author, ...profile } }
                : message
            ),
          ])
        ),
      }),

    addOrUpdateMember(guildId, member) {
      if (selectActiveServer(get()) !== guildId) return;

      const nextMember = memberFromInput(member);
      const members = get().members;
      const existing = members.findIndex((item) => item.userId === nextMember.userId);

      set({
        members:
          existing === -1
            ? [...members, nextMember]
            : members.map((item, index) => (index === existing ? nextMember : item)),
      });
    },

    setVoiceStates(guildIds, states, dmIds = []) {
      const guildSet = new Set(guildIds);
      const next = Object.fromEntries(
        Object.entries(get().voiceStates).filter(
          ([channelId, channelStates]) =>
            !dmIds.includes(channelId) &&
            channelStates.some((state) => !state.guildId || !guildSet.has(state.guildId))
        )
      );

      for (const state of states) {
        next[state.channelId] = (next[state.channelId] ?? []).filter(
          (item) => item.userId !== state.userId
        );
      }
      for (const state of states) {
        next[state.channelId] = [...(next[state.channelId] ?? []), state];
      }

      set({ voiceStates: next });
    },

    updateVoiceState(state) {
      const next = { ...get().voiceStates };

      for (const [channelId, states] of Object.entries(next)) {
        const filtered = states.filter((item) => item.userId !== state.userId);
        if (filtered.length === states.length) continue;

        if (filtered.length === 0) delete next[channelId];
        else next[channelId] = filtered;
      }

      if (state.connected) {
        next[state.channelId] = [...(next[state.channelId] ?? []), state];
      }

      set({ voiceStates: next });
    },

    // `onProgress(index, fraction)` fires per attachment; `uploadProgress` holds the same numbers
    async sendMessage(channelId, content, files = [], replyTo = null, onProgress) {
      const nonce = messageNonce();
      const attachmentIds: string[] = [];

      for (const [index, file] of files.entries()) {
        try {
          const uploadFile = await stripImageMetadata(file);
          attachmentIds.push(await uploadAttachment(channelId, uploadFile, index, onProgress));
        } finally {
          const { [index]: _removed, ...rest } = get().uploadProgress;
          set({ uploadProgress: rest });
        }
      }

      const result = await anchor().client.message.send.post({
        channelId,
        content,
        nonce,
        attachmentIds,
        ...(replyTo ? { replyTo } : {}),
      });

      if (result.error || !result.data || 'error' in result.data) {
        if (sendToGuildsIfFederatedServerDown(result.error)) return;

        console.error('Failed to send message', result.error ?? result.data);
        throw new Error('Failed to send message');
      }
    },

    async deleteMessage(channelId, messageId) {
      const result = await anchor().client.message.delete.post({ channelId, messageId });

      if (result.error || !result.data || 'error' in result.data) {
        if (sendToGuildsIfFederatedServerDown(result.error)) return;

        console.error('Failed to delete message', result.error ?? result.data);
        throw new Error('Failed to delete message');
      }

      get().removeMessage(channelId, messageId);
    },

    async editMessage(channelId, messageId, content) {
      const result = await anchor().client.message.edit.post({ channelId, messageId, content });

      if (result.error || !result.data || 'error' in result.data) {
        if (sendToGuildsIfFederatedServerDown(result.error)) return;

        console.error('Failed to edit message', result.error ?? result.data);
        throw new Error('Failed to edit message');
      }

      get().updateMessage(channelId, result.data.message);
    },

    async loadMessages(channelId) {
      // show the last session's messages right away while the fresh page loads
      if (!get().messagesByChannel[channelId]?.length) {
        const cached = z.string().safeParse(storage.getString(messagesKey(channelId)));
        if (cached.success) get().setMessages(channelId, JSON.parse(cached.data));
      }
      setFlag('messagesLoadingByChannel', channelId, true);
      nextCursorByChannel.set(channelId, 0);

      try {
        const count = resetCount;
        const result = await anchor().client.message.list.get({
          query: { channelId, cursor: 0, amount: messagesPageSize },
        });
        if (count !== resetCount) return;

        if (result.error || !result.data || 'error' in result.data) {
          if (sendToGuildsIfFederatedServerDown(result.error)) return;

          console.error('Failed to load messages', result.error ?? result.data);
          return;
        }

        hasMoreByChannel.set(channelId, result.data.messages.length === messagesPageSize);
        get().setMessages(channelId, result.data.messages);
        storage.set(messagesKey(channelId), JSON.stringify(result.data.messages));
        return result.data.messages.at(-1);
      } finally {
        setFlag('messagesLoadingByChannel', channelId, false);
      }
    },

    async loadOlderMessages(channelId) {
      if (get().messagesLoadingByChannel[channelId] || get().loadingOlderByChannel[channelId])
        return;
      if (!hasMoreByChannel.get(channelId)) return;

      setFlag('loadingOlderByChannel', channelId, true);

      try {
        const cursor = nextCursorByChannel.get(channelId) ?? 0;
        const result = await anchor().client.message.list.get({
          query: { channelId, cursor, amount: messagesPageSize },
        });

        if (result.error || !result.data || 'error' in result.data) {
          if (sendToGuildsIfFederatedServerDown(result.error)) return;

          console.error('Failed to load older messages', result.error ?? result.data);
          return;
        }

        const loaded = result.data.messages.map(messageFromInput);
        const existing = get().messagesByChannel[channelId] ?? [];
        const existingIds = new Set(existing.map((message) => message.id));
        const older = loaded.filter((message: Message) => !existingIds.has(message.id));
        if (older.length > 0) {
          setChannelMessages(channelId, [...older, ...existing]);
        }

        nextCursorByChannel.set(channelId, cursor + loaded.length);
        hasMoreByChannel.set(channelId, loaded.length === messagesPageSize);
      } finally {
        setFlag('loadingOlderByChannel', channelId, false);
      }
    },

    hasMoreMessages: (channelId) => hasMoreByChannel.get(channelId) ?? false,

    async onTyping() {
      const activeChannel = selectActiveChannel(get());
      if (!activeChannel) return;

      const now = Date.now();
      const lastTyping = lastTypingByChannel.get(activeChannel) ?? 0;
      if (now - lastTyping < typingRequestIntervalMs) {
        return;
      }

      lastTypingByChannel.set(activeChannel, now);
      const result = await anchor().client.channel({ id: activeChannel }).typing.post();

      if (result.error || !result.data || 'error' in result.data) {
        console.error('Failed to send typing event', result.error ?? result.data);
      }
    },

    setTyping(channelId, userId, username, homeserver, name) {
      const { user } = session();

      if (!user) return;
      if (userId === user.id) return;
      if (
        username === user.username &&
        homeserver.toLowerCase() === user.homeserver.toLowerCase()
      ) {
        return;
      }

      const expiresAt = Date.now() + typingExpiryMs;
      const typing = get().typingByChannel[channelId] ?? [];
      const nextTyping = typing.filter((item) => item.userId !== userId);

      nextTyping.push({ userId, name, expiresAt });

      set({ typingByChannel: { ...get().typingByChannel, [channelId]: nextTyping } });

      setTimeout(() => expireTyping(channelId, userId, expiresAt), typingExpiryMs);
    },

    clearTyping: (channelId, userId) =>
      set({
        typingByChannel: {
          ...get().typingByChannel,
          [channelId]: (get().typingByChannel[channelId] ?? []).filter(
            (item) => item.userId !== userId
          ),
        },
      }),

    async loadMembers(channelId) {
      const count = resetCount;
      const result = await anchor().client.channel({ id: channelId }).users.get();
      if (count !== resetCount) return;

      if (result.error || !result.data || 'error' in result.data) {
        console.error('Failed to load members', result.error ?? result.data);
        set({ members: [] });
        return;
      }

      set({ members: result.data.users.map(memberFromInput) });
    },

    async createServer(server) {
      await anchor().client.guilds.create.post({ name: server.name });
    },

    updateGuildAvatar: (guildId, avatarUrl) =>
      set({
        servers: get().servers.map((server) =>
          server.id === guildId ? { ...server, avatarUrl } : server
        ),
      }),

    createLocalChannel(categoryId, channel) {
      const activeServer = selectActiveServer(get());
      if (!activeServer) return;

      const categories = [...selectCurrentCategories(get())];
      const categoryIndex = categories.findIndex((category) => category.id === categoryId);

      if (categoryIndex === -1) return;

      const category = categories[categoryIndex];
      categories[categoryIndex] = {
        ...category,
        channels: [...category.channels, channel],
      };

      get().setGuildCategories(activeServer, categories);
      get().selectChannel(channel.id);
    },

    async createChannel(guildId, channel, type) {
      const result = await anchor().client.channel.create.post({
        name: channel.name,
        type,
        guildId,
      });

      if (result.error || !result.data || 'error' in result.data) return;

      // the caller opens it (channel-sidebar.tsx)
      return get().addChannel(result.data);
    },

    async createGuildInvite(guildId) {
      const result = await anchor().client.guilds({ id: guildId }).invites.post();

      if (result.error || !result.data || 'error' in result.data) return;

      return result.data;
    },

    async getGuildInvite(inviteCode) {
      const result = await anchor().client.guilds({ id: inviteCode }).invites.get();

      if (result.error || !result.data || 'error' in result.data) return;

      return result.data;
    },

    async loadInitialData() {
      await Promise.all([loadGuilds(), dms().load()]);
      await selectInitialChannel();
      await loadCurrentChannel();
    },

    async recoverRealtimeState() {
      await Promise.all([loadGuilds(), dms().load()]);
      await loadCurrentChannel();
    },

    async reorderGuilds(guilds) {
      await anchor().client.guilds.order.patch({ guildIds: guilds });
    },

    reorderChannels(guildId, channelIds) {
      const categories = get().channelsByServer[guildId] ?? [];
      const positions = new Map(channelIds.map((id, position) => [id, position]));

      get().setGuildCategories(
        guildId,
        categories.map((category) => ({
          ...category,
          channels: [...category.channels].sort(
            (a, b) =>
              (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER)
          ),
        }))
      );
    },

    async saveChannelOrder(guildId, channelIds) {
      await anchor().client.channel.order.patch({ guildId, channelIds });
    },

    reset() {
      resetCount++; // drops any guild load still in flight
      lastTypingByChannel.clear();
      nextCursorByChannel.clear();
      hasMoreByChannel.clear();
      set(initialData());
    },
  };
});

// Same name as on the web, for code that runs outside React: `chat().addMessage(...)`
export const chat = useChat.getState;

// A DM's channel comes from the dms store, so wake `useChat` selectors (they re-render only if their result changed)
useDms.subscribe(() => useChat.setState({}));

// the name of any channel (a guild channel or the other person of a DM), e.g. for the call bar
export function useChannelName(id: string | null) {
  const channelName = useChat((s) =>
    id
      ? Object.values(s.channelsByServer)
          .flat()
          .flatMap((category) => category.channels)
          .find((channel) => channel.id === id)?.name
      : undefined
  );
  const dmName = useDms((s) => {
    const other = id ? s.list.find((dm) => dm.id === id)?.participants[0] : undefined;
    return other ? other.displayName || other.username : undefined;
  });
  return id ? (channelName ?? dmName ?? null) : null;
}
