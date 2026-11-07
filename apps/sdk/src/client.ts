import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { resolveBuildable, type Buildable } from './builders.js';
import { REST } from './rest.js';
import {
  Channel,
  createInteraction,
  Guild,
  Message,
  resolveMessage,
  User,
  type Interaction,
  type MessageOptions,
} from './structures.js';
import type {
  APIBot,
  APIChannel,
  APICommand,
  APIGuild,
  APIInteraction,
  APIMessage,
  APIRealtimeEvent,
  APIUser,
} from './types.js';

export interface ClientOptions {
  /** the bot token from the developer panel */
  token: string;
  /** the Anchor homeserver the bot lives on, e.g. `https://anchor.example.com` */
  baseUrl: string;
  /** reconnect when the connection drops (default true) */
  reconnect?: boolean;
  /** a custom fetch, for tests or proxies */
  fetch?: typeof fetch;
}

export interface ClientEvents {
  ready: [client: Client];
  messageCreate: [message: Message];
  messageUpdate: [message: Message];
  messageDelete: [message: { id: string; channelId: string; guildId: string | null }];
  interactionCreate: [interaction: Interaction];
  guildCreate: [guild: Guild];
  guildDelete: [guild: { id: string }];
  guildMemberAdd: [member: { guildId: string; user: User }];
  guildMemberRemove: [member: { guildId: string; userId: string }];
  channelCreate: [channel: Channel];
  channelUpdate: [channel: Channel];
  typingStart: [
    typing: { channelId: string; user: { userId: string; username: string; homeserver: string } },
  ];
  presenceUpdate: [presence: { userId: string; status: 'ONLINE' | 'OFFLINE' }];
  userUpdate: [user: User];
  /** every event the server sends, as it arrives */
  raw: [event: APIRealtimeEvent];
  error: [error: Error];
  debug: [message: string];
  disconnect: [code: number, reason: string];
}

// Anchor sends misc.ping every 30 seconds; no ping for this long means the connection is dead
const deadAfterMs = 75_000;

/**
 * A Novarum bot.
 *
 * ```ts
 * const client = new Client({ token: process.env.BOT_TOKEN!, baseUrl: 'https://anchor.example.com' });
 * client.on('messageCreate', (message) => {
 *   if (message.content === '!ping') message.reply('pong');
 * });
 * await client.login();
 * ```
 */
export class Client extends EventEmitter<ClientEvents> {
  readonly rest: REST;
  readonly guilds = new Map<string, Guild>();
  /** the bot itself, once logged in */
  user: User | null = null;
  application: APIBot | null = null;
  #socket: WebSocket | null = null;
  #ready = false;
  #closing = false;
  #attempt = 0;
  #deadTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnect: boolean;

  constructor(options: ClientOptions) {
    super();
    this.rest = new REST(options);
    this.#reconnect = options.reconnect ?? true;
  }

  get isReady() {
    return this.#ready;
  }

  /** Global slash commands. */
  readonly commands = {
    /** Replaces every global command of the bot. */
    set: async (commands: Buildable<APICommand>[]) =>
      (
        await this.rest.put<{ commands: APICommand[] }>('/bots/@me/commands', {
          commands: commands.map(resolveBuildable),
        })
      ).commands,
    fetch: async () =>
      (await this.rest.get<{ commands: APICommand[] }>('/bots/@me/commands')).commands,
  };

  /** Finds a channel in any guild the bot is in. */
  channel(id: string) {
    for (const guild of this.guilds.values()) {
      const channel = guild.channels.get(id);
      if (channel) return channel;
    }
    return undefined;
  }

  async sendMessage(channelId: string, options: MessageOptions, replyTo?: string) {
    const message = await this.rest.sendMessage(channelId, { ...resolveMessage(options), replyTo });
    return new Message(this, message);
  }

  /** Loads the bot and its guilds, connects to realtime and resolves once `ready` fired. */
  async login() {
    this.#closing = false;
    const { bot } = await this.rest.get<{ bot: APIBot }>('/bots/@me');
    this.application = bot;
    this.user = new User(bot);
    await this.#loadGuilds();
    const ready = new Promise<void>((resolve, reject) => {
      this.once('ready', () => resolve());
      this.once('disconnect', (code, reason) => {
        if (!this.#ready) reject(new Error(`Realtime connection closed (${code}): ${reason}`));
      });
    });
    this.#connect();
    await ready;
    return this;
  }

  /** Disconnects for good. */
  destroy() {
    this.#closing = true;
    this.#ready = false;
    if (this.#deadTimer) clearTimeout(this.#deadTimer);
    this.#socket?.close(1000, 'Client destroyed');
    this.#socket = null;
  }

  async #loadGuilds() {
    const { guilds } = await this.rest.get<{ guilds: APIGuild[] }>('/guilds/list');
    this.guilds.clear();
    for (const { channels, ...guild } of guilds)
      this.guilds.set(guild.id, new Guild(this, guild, channels));
  }

  #connect() {
    const url = `${this.rest.baseUrl.replace(/^http/, 'ws')}/realtime`;
    this.emit('debug', `connecting to ${url}`);
    const socket = new WebSocket(url, { headers: { authorization: `Bot ${this.rest.token}` } });
    this.#socket = socket;

    socket.on('message', (raw) => {
      this.#alive();
      let event: APIRealtimeEvent;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.emit('raw', event);
      this.#handle(event).catch((error) => this.emit('error', error));
    });
    socket.on('open', () => {
      this.#attempt = 0;
      this.#alive();
    });
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', (code, reason) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#ready = false;
      if (this.#deadTimer) clearTimeout(this.#deadTimer);
      this.emit('disconnect', code, reason.toString());
      // 1008 is a refused token: reconnecting can't fix that
      if (this.#closing || !this.#reconnect || code === 1008) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++);
      this.emit('debug', `reconnecting in ${delay}ms`);
      setTimeout(() => {
        // guilds may have changed while we were away
        this.#loadGuilds()
          .then(() => this.#connect())
          .catch((error) => {
            this.emit('error', error);
            this.#connect();
          });
      }, delay);
    });
  }

  #alive() {
    if (this.#deadTimer) clearTimeout(this.#deadTimer);
    this.#deadTimer = setTimeout(() => this.#socket?.terminate(), deadAfterMs);
  }

  #send(message: object) {
    this.#socket?.send(JSON.stringify(message));
  }

  async #handle(event: APIRealtimeEvent) {
    // the server's payloads are typed in APIRealtimeEvent; `data` is narrowed per case below
    const data = (event as { data?: any }).data;
    switch (event.type) {
      case 'voice.states.snapshot':
        if (!this.#ready) {
          this.#ready = true;
          this.emit('ready', this);
        }
        return;
      case 'guild.created': {
        const { channels, ...rest } = data as APIGuild & { ownerId: string };
        const guild = new Guild(this, rest, channels);
        this.guilds.set(guild.id, guild);
        this.#send({ type: 'subscribe.guild', guildId: guild.id });
        this.emit('guildCreate', guild);
        return;
      }
      case 'guild.deleted':
        this.guilds.delete(data.guildId);
        this.emit('guildDelete', { id: data.guildId });
        return;
      case 'channel.created':
      case 'channel.updated': {
        const channel = new Channel(this, data as APIChannel);
        const guild = this.guilds.get(channel.data.guildId);
        if (!guild) return;
        guild.channels.set(channel.id, channel);
        this.emit(event.type === 'channel.created' ? 'channelCreate' : 'channelUpdate', channel);
        return;
      }
      case 'message.created':
        this.emit('messageCreate', new Message(this, data as APIMessage));
        return;
      case 'message.updated':
        this.emit('messageUpdate', new Message(this, data as APIMessage));
        return;
      case 'message.deleted':
        this.emit('messageDelete', data);
        return;
      case 'member.joined':
        this.emit('guildMemberAdd', {
          guildId: data.guildId,
          user: new User(data.user as APIUser),
        });
        return;
      case 'member.left':
        this.emit('guildMemberRemove', data);
        return;
      case 'user.status.changed':
        this.emit('presenceUpdate', data);
        return;
      case 'user.updated': {
        const user = new User(data.user as APIUser);
        if (this.user && user.id === this.user.id) this.user = user;
        this.emit('userUpdate', user);
        return;
      }
      case 'channel.typing':
        this.emit('typingStart', { channelId: data.channelId, user: data });
        return;
      case 'interaction.created':
        this.emit('interactionCreate', createInteraction(this, data as APIInteraction));
        return;
    }
  }
}
