import { page } from '$app/state';
import { goto } from '$app/navigation';
import { anchor } from '$lib/anchor.svelte';
import type { Author, Channel, ChannelCategory, ChatRoute, Message, Server } from '$lib/types/chat';
import { useSession } from './session.svelte';

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
  type?: string;
  topic?: string;
};

type AddMessageInput = {
  id: string;
  channelId: string;
  content: string;
  createdAt: string | Date;
  author: {
    username: string;
    avatar?: string | null;
  };
  attachments?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    url: string;
  }[];
};

type ChannelMemberInput = {
  userId: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  homeserver: string;
  isBot: boolean;
  status: 'ONLINE' | 'OFFLINE';
};

type VoicePresenceInput = {
  guildId: string;
  channelId: string;
  userId: string;
  name: string | null;
};

type TypingInput = {
  userId: string;
  name: string;
  expiresAt: number;
};

const typingRequestIntervalMs = 5_000;
const typingExpiryMs = 6_000;
const reencodedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function stripImageMetadata(file: File) {
  if (!reencodedImageTypes.has(file.type)) return file;

  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error(`Could not process ${file.name}`);
    context.drawImage(bitmap, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type, file.type === 'image/jpeg' ? 0.92 : undefined)
    );
    if (!blob) throw new Error(`Could not process ${file.name}`);

    return new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

function messageFromInput(message: AddMessageInput): Message {
  return {
    id: message.id,
    author: {
      username: message.author.username,
      displayName: message.author.username,
      avatarUrl: message.author.avatar ?? null,
      server: '',
      avatarColor: 'bg-primary',
      isBot: false,
    },
    content: message.content,
    timestamp: new Date(message.createdAt),
    edited: false,
    replies: 0,
    attachments: message.attachments ?? [],
  };
}

function memberFromInput(member: ChannelMemberInput): Author {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl ?? null,
    server: member.homeserver,
    avatarColor: 'bg-primary',
    isBot: member.isBot,
    status: member.status,
  };
}

function channelTypeFor(type: string | undefined): Channel['type'] {
  if (type === 'VOICE') return 'VOICE';

  return 'TEXT';
}

function guildPath(serverId?: string, channelId?: string) {
  if (!serverId) return '/guilds';

  const path = [serverId, channelId]
    .filter((part): part is string => Boolean(part))
    .map(encodeURIComponent)
    .join('/');

  return `/guilds/${path}`;
}
function dmPath(userId: string) {
  // pretty sure theres no need to uri encode but thanks copilot i guess
  return `/guilds/dms/${encodeURIComponent(userId)}`;
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;

  const status = Number(error.status);
  return Number.isFinite(status) ? status : null;
}

function sendToGuildsIfFederatedServerDown(error: unknown) {
  if (errorStatus(error) !== 502) return false;

  void goto('/guilds', { replaceState: true });
  return true;
}

function currentRoute(): ChatRoute {
  const [first, second] = (page.params.path ?? '').split('/').filter(Boolean);

  // will eventually be replaced by dms
  if (!first) return { kind: 'home' };
  if (first === 'dms') return { kind: 'dms', userId: second ?? null };

  return {
    kind: 'guild',
    serverId: first ?? null,
    channelId: second ?? null,
  };
}

class ChatState {
  servers = $state<Server[]>([]);
  channelsByServer = $state<Record<string, ChannelCategory[]>>({});
  messagesByChannel = $state<Record<string, Message[]>>({});
  messagesLoadingByChannel = $state<Record<string, boolean>>({});
  members = $state<Author[]>([]);
  voiceStates = $state<Record<string, VoicePresenceInput[]>>({});
  typingByChannel = $state<Record<string, TypingInput[]>>({});
  private loadedChannel: string | null = null;
  private lastTypingByChannel = new Map<string, number>();

  route = $derived(currentRoute());
  activeServer = $derived(this.route.kind === 'guild' ? this.route.serverId : null);
  activeChannel = $derived(this.route.kind === 'guild' ? this.route.channelId : null);
  activeDMUser = $derived(this.route.kind === 'dms' ? this.route.userId : null);

  get currentServer() {
    return this.activeServer
      ? (this.servers.find((server) => server.id === this.activeServer) ?? null)
      : null;
  }

  get currentCategories() {
    return this.activeServer ? (this.channelsByServer[this.activeServer] ?? []) : [];
  }

  get currentChannel() {
    if (!this.activeChannel) return null;

    for (const category of this.currentCategories) {
      const channel = category.channels.find((item) => item.id === this.activeChannel);
      if (channel) return channel;
    }

    return null;
  }

  get currentMessages() {
    return this.currentChannel ? (this.messagesByChannel[this.currentChannel.id] ?? []) : [];
  }

  get currentMessagesLoading() {
    return this.currentChannel
      ? (this.messagesLoadingByChannel[this.currentChannel.id] ?? false)
      : false;
  }

  get currentTyping() {
    if (!this.currentChannel) return [];

    return this.typingByChannel[this.currentChannel.id] ?? [];
  }

  selectServer(id?: string) {
    return goto(guildPath(id, this.firstChannelForServer(id)?.id));
  }

  selectChannel(id: string) {
    if (this.activeServer) return goto(guildPath(this.activeServer, id));
  }

  selectDm(userId: string) {
    return goto(dmPath(userId));
  }

  syncActiveChannel() {
    const channelId = this.currentChannel?.id ?? null;
    if (channelId === this.loadedChannel) return;

    void this.loadCurrentChannel();
  }

  addGuild(guild: {
    id: string;
    name: string;
    down?: boolean;
    avatarUrl?: string | null;
    description?: string | null;
  }) {
    const down = guild.down ?? false;

    if (this.servers.some((server) => server.id === guild.id)) {
      this.servers = this.servers.map((server) =>
        server.id === guild.id
          ? {
              ...server,
              name: guild.name,
              initials: initialsFor(guild.name),
              down,
              avatarUrl: guild.avatarUrl ?? null,
              description: guild.description ?? null,
            }
          : server
      );
      return;
    }

    this.servers = [
      ...this.servers,
      {
        id: guild.id,
        name: guild.name,
        initials: initialsFor(guild.name),
        down,
        avatarUrl: guild.avatarUrl ?? null,
        description: guild.description ?? null,
      },
    ];
  }

  setGuildCategories(guildId: string, categories: ChannelCategory[]) {
    this.channelsByServer = {
      ...this.channelsByServer,
      [guildId]: categories,
    };
  }

  addChannel(channel: AddChannelInput) {
    const categories = [...(this.channelsByServer[channel.guildId] ?? [])];
    const existingChannel = categories
      .flatMap((category) => category.channels)
      .find((item) => item.id === channel.id);

    if (existingChannel) return existingChannel;

    const nextChannel: Channel = {
      id: channel.id,
      name: channel.name,
      topic: channel.topic,
      unread: false,
      mention: 0,
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
      categories[textCategoryIndex] = {
        ...textCategory,
        channels: [...textCategory.channels, nextChannel],
      };
    }

    this.setGuildCategories(channel.guildId, categories);

    return nextChannel;
  }

  setMessages(channelId: string, messages: AddMessageInput[]) {
    this.setChannelMessages(channelId, messages.map(messageFromInput));
  }

  addMessage(message: AddMessageInput) {
    const channelMessages = this.messagesByChannel[message.channelId] ?? [];
    if (channelMessages.some((item) => item.id === message.id)) return;

    this.setChannelMessages(message.channelId, [...channelMessages, messageFromInput(message)]);

    if (this.activeChannel !== message.channelId) {
      this.setChannelUnread(message.channelId, true);
    }
  }

  updateMemberStatus(userId: string, status: 'ONLINE' | 'OFFLINE') {
    this.members = this.members.map((member) =>
      member.userId === userId ? { ...member, status } : member
    );
  }

  addOrUpdateMember(guildId: string, member: ChannelMemberInput) {
    if (this.activeServer !== guildId) return;

    const nextMember = memberFromInput(member);
    const existing = this.members.findIndex((item) => item.userId === nextMember.userId);

    if (existing === -1) {
      this.members = [...this.members, nextMember];
      return;
    }

    this.members = this.members.map((item, index) => (index === existing ? nextMember : item));
  }

  setVoiceStates(guildIds: string[], states: VoicePresenceInput[]) {
    const guildSet = new Set(guildIds);
    const next = Object.fromEntries(
      Object.entries(this.voiceStates).filter(([, channelStates]) =>
        channelStates.some((state) => !guildSet.has(state.guildId))
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

    this.voiceStates = next;
  }

  updateVoiceState(state: VoicePresenceInput & { connected: boolean }) {
    const next = { ...this.voiceStates };

    for (const [channelId, states] of Object.entries(next)) {
      const filtered = states.filter((item) => item.userId !== state.userId);
      if (filtered.length === states.length) continue;

      if (filtered.length === 0) delete next[channelId];
      else next[channelId] = filtered;
    }

    if (state.connected) {
      next[state.channelId] = [...(next[state.channelId] ?? []), state];
    }

    this.voiceStates = next;
  }

  private setChannelMessages(channelId: string, messages: Message[]) {
    this.messagesByChannel = {
      ...this.messagesByChannel,
      [channelId]: messages,
    };
  }

  async sendMessage(channelId: string, content: string, files: File[] = []) {
    const nonce = messageNonce();
    const attachmentIds: string[] = [];

    for (const file of files) {
      const uploadFile = await stripImageMetadata(file);
      const contentType = uploadFile.type || 'application/octet-stream';
      const presign = await anchor.client.upload.presign.post({
        channelId,
        filename: uploadFile.name,
        contentType,
        size: uploadFile.size,
      });

      if (presign.error || !presign.data || 'error' in presign.data) {
        throw new Error(`Could not prepare ${file.name} for upload`);
      }

      const uploaded = await fetch(presign.data.uploadUrl, {
        method: 'PUT',
        headers: presign.data.headers,
        body: uploadFile,
      });
      if (!uploaded.ok) throw new Error(`Could not upload ${file.name}`);

      attachmentIds.push(presign.data.attachmentId);
    }

    const result = await anchor.client.message.send.post({
      channelId,
      content,
      nonce,
      attachmentIds,
    });

    if (result.error || !result.data || 'error' in result.data) {
      if (sendToGuildsIfFederatedServerDown(result.error)) return;

      console.error('Failed to send message', result.error ?? result.data);
      throw new Error('Failed to send message');
    }
  }

  async loadMessages(channelId: string) {
    this.messagesLoadingByChannel = {
      ...this.messagesLoadingByChannel,
      [channelId]: true,
    };

    try {
      const result = await anchor.client.message.list.get({
        query: { channelId },
      });

      if (result.error || !result.data || 'error' in result.data) {
        if (sendToGuildsIfFederatedServerDown(result.error)) return;

        console.error('Failed to load messages', result.error ?? result.data);
        return;
      }

      this.setMessages(
        channelId,
        result.data.messages.map((message: any) => ({
          ...message,
          author: {
            username: String(message.author.username),
            avatar: message.author.avatar ?? null,
          },
        }))
      );
    } finally {
      this.messagesLoadingByChannel = {
        ...this.messagesLoadingByChannel,
        [channelId]: false,
      };
    }
  }

  async onTyping() {
    if (!this.activeChannel) return;

    const now = Date.now();
    const lastTyping = this.lastTypingByChannel.get(this.activeChannel) ?? 0;
    if (now - lastTyping < typingRequestIntervalMs) {
      return;
    }

    this.lastTypingByChannel.set(this.activeChannel, now);
    const result = await anchor.client.channel({ id: this.activeChannel }).typing.post();

    if (result.error || !result.data || 'error' in result.data) {
      console.error('Failed to send typing event', result.error ?? result.data);
    }
  }

  setTyping(channelId: string, userId: string, name: string) {
    const session = useSession();

    if (!session.user) return;
    if (userId === session.user.id) return;

    const expiresAt = Date.now() + typingExpiryMs;
    const typing = this.typingByChannel[channelId] ?? [];
    const nextTyping = typing.filter((item) => item.userId !== userId);

    nextTyping.push({ userId, name, expiresAt });

    this.typingByChannel = {
      ...this.typingByChannel,
      [channelId]: nextTyping,
    };

    setTimeout(() => this.expireTyping(channelId, userId, expiresAt), typingExpiryMs);
  }

  clearTyping(channelId: string, userId: string) {
    const nextTyping = (this.typingByChannel[channelId] ?? []).filter(
      (item) => item.userId !== userId
    );

    this.typingByChannel = {
      ...this.typingByChannel,
      [channelId]: nextTyping,
    };
  }

  private expireTyping(channelId: string, userId: string, expiresAt: number) {
    const nextTyping = (this.typingByChannel[channelId] ?? []).filter(
      (item) => item.userId !== userId || item.expiresAt !== expiresAt
    );

    this.typingByChannel = {
      ...this.typingByChannel,
      [channelId]: nextTyping,
    };
  }

  async loadMembers(channelId: string) {
    const result = await anchor.client.channel({ id: channelId }).users.get();

    if (result.error || !result.data || 'error' in result.data) {
      console.error('Failed to load members', result.error ?? result.data);
      this.members = [];
      return;
    }

    this.members = result.data.users.map(memberFromInput);
  }

  private setChannelUnread(channelId: string, unread: boolean) {
    let changed = false;
    const nextChannelsByServer: Record<string, ChannelCategory[]> = {};

    for (const [guildId, categories] of Object.entries(this.channelsByServer)) {
      nextChannelsByServer[guildId] = categories.map((category) => ({
        ...category,
        channels: category.channels.map((channel) => {
          if (channel.id !== channelId || channel.unread === unread) return channel;

          changed = true;
          return { ...channel, unread };
        }),
      }));
    }

    if (changed) {
      this.channelsByServer = nextChannelsByServer;
    }
  }

  async createServer(server: Server) {
    await anchor.client.guilds.create.post({ name: server.name });
  }

  updateGuildAvatar(guildId: string, avatarUrl: string) {
    this.servers = this.servers.map((server) =>
      server.id === guildId ? { ...server, avatarUrl } : server
    );
  }

  createLocalChannel(categoryId: string, channel: Channel) {
    if (!this.activeServer) return;

    const categories = [...this.currentCategories];
    const categoryIndex = categories.findIndex((category) => category.id === categoryId);

    if (categoryIndex === -1) return;

    const category = categories[categoryIndex];
    categories[categoryIndex] = {
      ...category,
      channels: [...category.channels, channel],
    };

    this.setGuildCategories(this.activeServer, categories);
    this.selectChannel(channel.id);
  }

  async createChannel(guildId: string, channel: Channel, type: 'TEXT' | 'VOICE') {
    const result = await anchor.client.channel.create.post({
      name: channel.name,
      type,
      guildId,
    });

    if (result.error || !result.data || 'error' in result.data) return;

    const createdChannel = this.addChannel(result.data);
    if (!createdChannel) return;

    this.selectChannel(createdChannel.id);
    return createdChannel;
  }

  async createGuildInvite(guildId: string) {
    const result = await anchor.client.guilds({ id: guildId }).invites.post();

    if (result.error || !result.data || 'error' in result.data) return;

    return result.data;
  }

  async getGuildInvite(inviteCode: string) {
    const result = await anchor.client.guilds({ id: inviteCode }).invites.get();

    if (result.error || !result.data || 'error' in result.data) return;

    return result.data;
  }

  async loadInitialData() {
    await this.loadGuilds();
    await this.selectInitialChannel();
    await this.loadCurrentChannel();
  }

  private async loadGuilds() {
    const result = await anchor.client.guilds.list.get();

    if (result.error || !result.data) return;

    for (const guild of result.data.guilds) {
      this.addGuild(guild);

      for (const channel of guild.channels) {
        this.addChannel(channel);
      }
    }
  }

  private async loadCurrentChannel() {
    const channelId = this.currentChannel?.id ?? null;
    this.loadedChannel = channelId;

    if (!channelId) {
      this.members = [];
      return;
    }

    this.setChannelUnread(channelId, false);
    await Promise.all([this.loadMessages(channelId), this.loadMembers(channelId)]);
  }

  private firstChannelForServer(serverId?: string) {
    return serverId ? this.channelsByServer[serverId]?.[0]?.channels[0] : null;
  }

  private selectInitialChannel() {
    if (!this.activeServer) return;

    if (this.currentServer?.down) {
      return goto('/guilds', { replaceState: true });
    }

    const serverId = this.currentServer?.id;
    const channelId = this.currentChannel?.id ?? this.firstChannelForServer(serverId)?.id ?? null;

    if (serverId !== this.activeServer || channelId !== this.activeChannel) {
      return goto(guildPath(serverId, channelId ?? undefined), { replaceState: true });
    }
  }
}

export const chat = new ChatState();

function messageNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
