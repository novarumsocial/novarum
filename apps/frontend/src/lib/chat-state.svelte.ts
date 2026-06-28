import { page } from '$app/state';
import { goto } from '$app/navigation';
import { anchor } from '$lib/anchor.svelte';
import type {
  Author,
  Channel,
  ChannelCategory,
  ChatRoute,
  Message,
  Server,
  VoiceUser,
} from '$lib/types/chat';

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
  };
};

type ChannelMemberInput = {
  userId: string;
  username: string;
  displayName: string;
  homeserver: string;
  isBot: boolean;
  status: 'ONLINE' | 'OFFLINE';
};

function messageFromInput(message: AddMessageInput): Message {
  return {
    id: message.id,
    author: {
      username: message.author.username,
      displayName: message.author.username,
      server: '',
      avatarColor: 'bg-primary',
      isBot: false,
    },
    content: message.content,
    timestamp: new Date(message.createdAt),
    edited: false,
    replies: 0,
  };
}

function memberFromInput(member: ChannelMemberInput): Author {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
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
  voiceUsers = $state<VoiceUser[]>([]);
  private loadedChannel: string | null = null;

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

  addGuild(guild: { id: string; name: string; down: boolean }) {
    if (this.servers.some((server) => server.id === guild.id)) return;

    this.servers = [
      ...this.servers,
      {
        id: guild.id,
        name: guild.name,
        initials: initialsFor(guild.name),
        down: guild.down,
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

  private setChannelMessages(channelId: string, messages: Message[]) {
    this.messagesByChannel = {
      ...this.messagesByChannel,
      [channelId]: messages,
    };
  }

  async sendMessage(channelId: string, content: string) {
    const nonce = messageNonce();

    const result = await anchor.client.message.send.post({
      channelId,
      content,
      nonce,
    });

    if (result.error || !result.data || 'error' in result.data) {
      console.error('Failed to send message', result.error ?? result.data);
      return;
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
        console.error('Failed to load messages', result.error ?? result.data);
        return;
      }

      this.setMessages(
        channelId,
        result.data.messages.map((message: any) => ({
          ...message,
          author: { username: String(message.author.username) },
        }))
      );
    } finally {
      this.messagesLoadingByChannel = {
        ...this.messagesLoadingByChannel,
        [channelId]: false,
      };
    }
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
