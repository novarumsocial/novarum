import { resolveBuildable, type Buildable } from './builders.js';
import type { Client } from './client.js';
import type {
  APIActionRow,
  APIChannel,
  APIEmbed,
  APIEphemeralMessage,
  APIGuild,
  APIInteraction,
  APIMember,
  APIMessage,
  APIMessageBody,
  APIResolvedOption,
  APIResponseMessage,
  APIUser,
} from './types.js';

/** What you can send: a string, or content with embeds and buttons (builders or plain objects). */
export type MessageOptions =
  | string
  | {
      content?: string | null;
      embeds?: Buildable<APIEmbed>[];
      components?: Buildable<APIActionRow>[];
    };
export type ReplyOptions =
  | MessageOptions
  | (Exclude<MessageOptions, string> & { ephemeral?: boolean });

export function resolveMessage(options: MessageOptions): APIMessageBody {
  if (typeof options === 'string') return { content: options };
  return {
    content: options.content,
    embeds: options.embeds?.map(resolveBuildable),
    components: options.components?.map(resolveBuildable),
  };
}

function resolveReply(options: ReplyOptions): APIResponseMessage {
  const ephemeral =
    typeof options === 'object' && 'ephemeral' in options ? options.ephemeral : undefined;
  return { ...resolveMessage(options), ...(ephemeral ? { ephemeral } : {}) };
}

/** `@username:homeserver`, the mention syntax Novarum clients understand. */
export const userMention = (user: { username: string; homeserver: string }) =>
  `@${user.username}:${user.homeserver}`;

export class User {
  constructor(public data: APIUser) {}
  get id() {
    return this.data.userId;
  }
  get username() {
    return this.data.username;
  }
  get homeserver() {
    return this.data.homeserver;
  }
  get displayName() {
    return this.data.displayName ?? this.data.username;
  }
  get bot() {
    return this.data.isBot;
  }
  get avatarUrl() {
    return this.data.avatarUrl;
  }
  /** `@username:homeserver` */
  get tag() {
    return userMention(this.data);
  }
  toString() {
    return this.tag;
  }
}

export class Channel {
  constructor(
    private client: Client,
    public data: APIChannel
  ) {}
  get id() {
    return this.data.id;
  }
  get name() {
    return this.data.name;
  }
  get type() {
    return this.data.type;
  }
  get guild() {
    return this.client.guilds.get(this.data.guildId);
  }
  isText() {
    return this.data.type === 'TEXT';
  }
  send(options: MessageOptions) {
    return this.client.sendMessage(this.id, options);
  }
  /** Shows "<bot> is typing…" for a few seconds. */
  sendTyping() {
    return this.client.rest.post(`/channel/${encodeURIComponent(this.id)}/typing`);
  }
  /** The most recent messages, oldest first. */
  async messages(amount = 50) {
    const { messages } = await this.client.rest.get<{ messages: APIMessage[] }>(
      `/message/list?channelId=${encodeURIComponent(this.id)}&cursor=0&amount=${Math.min(Math.max(amount, 20), 100)}`
    );
    return messages.map((message) => new Message(this.client, message));
  }
  async members() {
    const { users } = await this.client.rest.get<{ users: APIMember[] }>(
      `/channel/${encodeURIComponent(this.id)}/users`
    );
    return users;
  }
  toString() {
    return `#${this.name}`;
  }
}

export class Guild {
  readonly channels = new Map<string, Channel>();
  constructor(
    private client: Client,
    public data: Omit<APIGuild, 'channels'>,
    channels: APIChannel[] = []
  ) {
    for (const channel of channels) this.channels.set(channel.id, new Channel(client, channel));
  }
  get id() {
    return this.data.id;
  }
  get name() {
    return this.data.name;
  }
  /** Members of the guild (asked from the server every time). */
  async members() {
    const first = this.channels.values().next().value;
    return first ? first.members() : [];
  }
  /** Leaves the guild. */
  leave() {
    return this.client.rest.post(`/bots/@me/guilds/${encodeURIComponent(this.id)}/leave`);
  }
}

export class Message {
  readonly author: User;
  constructor(
    private client: Client,
    public data: APIMessage
  ) {
    this.author = new User(data.author);
  }
  get id() {
    return this.data.id;
  }
  get content() {
    return this.data.content ?? '';
  }
  get channelId() {
    return this.data.channelId;
  }
  get guildId() {
    return this.data.guildId;
  }
  get embeds() {
    return this.data.embeds ?? [];
  }
  get components() {
    return this.data.components ?? [];
  }
  get createdAt() {
    return new Date(this.data.createdAt);
  }
  get channel() {
    return this.client.channel(this.channelId);
  }
  get guild() {
    return this.guildId ? this.client.guilds.get(this.guildId) : undefined;
  }
  /** Whether this message @mentions the bot. */
  get mentionsMe() {
    const me = this.client.user;
    return (
      !!me && (this.data.pingedHandles ?? []).some((h) => h.toLowerCase() === me.tag.toLowerCase())
    );
  }
  reply(options: MessageOptions) {
    return this.client.sendMessage(this.channelId, options, this.id);
  }
  async edit(options: MessageOptions) {
    const message = await this.client.rest.editMessage(
      this.channelId,
      this.id,
      resolveMessage(options)
    );
    return new Message(this.client, message);
  }
  delete() {
    return this.client.rest.deleteMessage(this.channelId, this.id);
  }
}

export class EphemeralMessage {
  constructor(public data: APIEphemeralMessage) {}
}

/** The options of a slash command, read by name. */
export class CommandOptions {
  constructor(private options: APIResolvedOption[]) {}
  private get(name: string, required: boolean) {
    const option = this.options.find((o) => o.name === name);
    if (!option && required) throw new Error(`Option "${name}" is required`);
    return option;
  }
  getString(name: string, required: true): string;
  getString(name: string, required?: boolean): string | null;
  getString(name: string, required = false) {
    const value = this.get(name, required)?.value;
    return typeof value === 'string' ? value : null;
  }
  getInteger(name: string, required: true): number;
  getInteger(name: string, required?: boolean): number | null;
  getInteger(name: string, required = false) {
    const value = this.get(name, required)?.value;
    return typeof value === 'number' ? value : null;
  }
  getNumber(name: string, required: true): number;
  getNumber(name: string, required?: boolean): number | null;
  getNumber(name: string, required = false) {
    return this.getInteger(name, required as true);
  }
  getBoolean(name: string, required: true): boolean;
  getBoolean(name: string, required?: boolean): boolean | null;
  getBoolean(name: string, required = false) {
    const value = this.get(name, required)?.value;
    return typeof value === 'boolean' ? value : null;
  }
  getUser(name: string, required: true): User;
  getUser(name: string, required?: boolean): User | null;
  getUser(name: string, required = false) {
    const user = this.get(name, required)?.user;
    return user ? new User(user) : null;
  }
  /** For autocomplete: the option the person is typing in, and what they typed so far. */
  getFocused(): { name: string; value: string } {
    const focused = this.options.find((o) => o.focused);
    return { name: focused?.name ?? '', value: String(focused?.value ?? '') };
  }
  get data() {
    return this.options;
  }
}

abstract class BaseInteraction {
  readonly user: User;
  replied = false;
  deferred = false;
  constructor(
    protected client: Client,
    public data: APIInteraction
  ) {
    this.user = new User(data.user);
  }
  get id() {
    return this.data.id;
  }
  get channelId() {
    return this.data.channelId;
  }
  get guildId() {
    return this.data.guildId;
  }
  get channel() {
    return this.client.channel(this.channelId);
  }
  get guild() {
    return this.client.guilds.get(this.guildId);
  }
  isCommand(): this is CommandInteraction {
    return this.data.type === 'command';
  }
  isButton(): this is ButtonInteraction {
    return this.data.type === 'button';
  }
  isAutocomplete(): this is AutocompleteInteraction {
    return this.data.type === 'autocomplete';
  }
  protected path(action: string) {
    return `/interactions/${encodeURIComponent(this.data.id)}/${encodeURIComponent(this.data.token)}/${action}`;
  }
  protected async callback(body: unknown) {
    await this.client.rest.post(this.path('callback'), body);
  }
}

abstract class RepliableInteraction extends BaseInteraction {
  /** Answers with a message. `ephemeral: true` shows it only to the person who used it. */
  async reply(options: ReplyOptions) {
    await this.callback({ type: 'message', data: resolveReply(options) });
    this.replied = true;
  }
  /** Shows "<bot> is thinking…" so you have 15 minutes to `editReply`. */
  async deferReply(options: { ephemeral?: boolean } = {}) {
    await this.callback({ type: 'deferred', data: options });
    this.deferred = true;
  }
  /** Edits the reply (or sends the one a deferred reply was waiting for). */
  async editReply(options: MessageOptions) {
    await this.client.rest.patch(this.path('original'), resolveMessage(options));
    this.replied = true;
  }
  /** Sends another message after replying. */
  async followUp(options: ReplyOptions) {
    await this.client.rest.post(this.path('followup'), resolveReply(options));
  }
}

export class CommandInteraction extends RepliableInteraction {
  readonly options = new CommandOptions(this.data.data.options ?? []);
  get commandName() {
    return this.data.data.name;
  }
}

export class ButtonInteraction extends RepliableInteraction {
  get customId() {
    return this.data.data.customId ?? '';
  }
  /** The message the button is on. */
  get message() {
    return this.data.message;
  }
  /** Edits the message the button is on, as the answer. */
  async update(options: MessageOptions) {
    await this.callback({ type: 'update', data: resolveMessage(options) });
    this.replied = true;
  }
  /** Acknowledges the press without changing anything yet; `editReply` edits the message later. */
  async deferUpdate() {
    await this.callback({ type: 'deferredUpdate' });
    this.deferred = true;
  }
}

export class AutocompleteInteraction extends BaseInteraction {
  readonly options = new CommandOptions(this.data.data.options ?? []);
  get commandName() {
    return this.data.data.name;
  }
  /** Up to 25 suggestions. */
  async respond(choices: { name: string; value: string | number }[]) {
    await this.callback({ type: 'autocomplete', data: { choices: choices.slice(0, 25) } });
  }
}

export type Interaction = CommandInteraction | ButtonInteraction | AutocompleteInteraction;

export function createInteraction(client: Client, data: APIInteraction): Interaction {
  if (data.type === 'button') return new ButtonInteraction(client, data);
  if (data.type === 'autocomplete') return new AutocompleteInteraction(client, data);
  return new CommandInteraction(client, data);
}
