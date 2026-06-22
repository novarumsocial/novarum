import { anchor } from '$lib/anchor.svelte';
import type { Author, Channel, ChannelCategory, Message, Server, VoiceUser } from '$lib/types/chat';

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

function channelTypeFor(type: string | undefined): Channel['type'] {
  if (type === 'VOICE') return 'VOICE';

  return 'TEXT';
}

class ChatState {
  servers = $state<Server[]>([]);
  channelsByServer = $state<Record<string, ChannelCategory[]>>({});
  messagesByChannel = $state<Record<string, Message[]>>({});
  messagesLoadingByChannel = $state<Record<string, boolean>>({});
  members = $state<Author[]>([]);
  voiceUsers = $state<VoiceUser[]>([]);
  guildsLoaded = $state(false);

  activeServer = $state<string | null>(null);
  activeChannel = $state<string | null>(null);

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

  selectServer(id: string | null) {
    this.activeServer = id;

    if (!id) {
      this.activeChannel = null;
      return;
    }

    const firstChannel = this.channelsByServer[id]?.[0]?.channels[0];
    if (firstChannel) {
      this.selectChannel(firstChannel.id);
    } else {
      this.activeChannel = null;
    }
  }

  selectChannel(id: string) {
    this.activeChannel = id;
    this.setChannelUnread(id, false);
    void this.loadMessages(id);
  }

  addGuild(guild: { id: string; name: string }) {
    if (this.servers.some((server) => server.id === guild.id)) return;

    this.servers = [
      ...this.servers,
      {
        id: guild.id,
        name: guild.name,
        initials: initialsFor(guild.name),
      },
    ];

    this.selectServer(guild.id);
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

    if (this.activeServer === channel.guildId && !this.activeChannel) {
      this.selectChannel(channel.id);
    }

    return nextChannel;
  }

  setMessages(channelId: string, messages: AddMessageInput[]) {
    this.messagesByChannel = {
      ...this.messagesByChannel,
      [channelId]: messages.map((message) => ({
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
        fromFederated: false,
        replies: 0,
      })),
    };
  }

  addMessage(message: AddMessageInput) {
    const messages = this.messagesByChannel[message.channelId] ?? [];
    if (messages.some((item) => item.id === message.id)) return;

    this.messagesByChannel = {
      ...this.messagesByChannel,
      [message.channelId]: [
        ...messages,
        {
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
          fromFederated: false,
          replies: 0,
        },
      ],
    };

    if (this.activeChannel !== message.channelId) {
      this.setChannelUnread(message.channelId, true);
    }
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
        result.data.messages.map((message) => ({
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
    this.activeChannel = channel.id;
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

  async loadGuilds() {
    const result = await anchor.client.guilds.list.get();

    if (result.error || !result.data) return;

    for (const guild of result.data.guilds) {
      this.addGuild(guild);

      for (const channel of guild.channels) {
        this.addChannel(channel);
      }
    }

    this.guildsLoaded = true;
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
