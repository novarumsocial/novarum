import { z } from 'zod';
import { anchor } from '$lib/anchor.svelte';
import { chat } from '$lib/chat-state.svelte';
import type { Command } from 'anchor/bot-schemas';
import type { PublicUser } from 'anchor/public-user';

const apiErrorSchema = z.object({ error: z.string() });
// eden puts the error body in `value`; validation errors only have a message
const errorMessage = (error: { value?: unknown } | null | undefined, fallback: string) =>
  apiErrorSchema.safeParse(error?.value).data?.error ?? fallback;

export type DeveloperBot = PublicUser & {
  handle: string;
  public: boolean;
  createdAt: string;
  commands: Command[];
  guildCount: number;
};

/** The bots you own, for the developer panel. */
class DevelopersState {
  bots = $state<DeveloperBot[]>([]);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);
  // a token is only shown right after it was made
  revealedToken = $state<{ botId: string; token: string } | null>(null);

  find(id: string | null) {
    return this.bots.find((bot) => bot.userId === id) ?? null;
  }

  private put(bot: DeveloperBot) {
    const exists = this.bots.some((item) => item.userId === bot.userId);
    this.bots = exists
      ? this.bots.map((item) => (item.userId === bot.userId ? bot : item))
      : [...this.bots, bot];
  }

  async load() {
    this.loading = true;
    this.error = null;
    const { data, error } = await anchor.client.developers.bots.get();
    this.loading = false;
    if (error) return void (this.error = errorMessage(error, 'Could not load your bots.'));
    this.bots = data.bots;
    this.loaded = true;
  }

  async create(username: string, displayName: string) {
    const { data, error } = await anchor.client.developers.bots.post({
      username,
      displayName: displayName || null,
    });
    if (error)
      return { ok: false as const, error: errorMessage(error, 'Could not create the bot.') };
    this.put(data.bot);
    this.revealedToken = { botId: data.bot.userId, token: data.token };
    return { ok: true as const, bot: data.bot };
  }

  async update(
    id: string,
    patch: { displayName?: string | null; about?: string | null; public?: boolean }
  ) {
    const { data, error } = await anchor.client.developers.bots({ id }).patch(patch);
    if (error) return errorMessage(error, 'Could not save the changes.');
    this.put(data.bot);
    return null;
  }

  async uploadAvatar(id: string, avatar: File) {
    const { data, error } = await anchor.client.developers.bots({ id }).avatar.post({ avatar });
    if (error) return errorMessage(error, 'Could not upload the avatar.');
    this.put(data.bot);
    return null;
  }

  async regenerateToken(id: string) {
    const { data, error } = await anchor.client.developers.bots({ id }).token.post();
    if (error) return errorMessage(error, 'Could not make a new token.');
    this.revealedToken = { botId: id, token: data.token };
    return null;
  }

  async remove(id: string) {
    const { error } = await anchor.client.developers.bots({ id }).delete();
    if (error) return errorMessage(error, 'Could not delete the bot.');
    this.bots = this.bots.filter((bot) => bot.userId !== id);
    if (this.revealedToken?.botId === id) this.revealedToken = null;
    return null;
  }
}

export const developers = new DevelopersState();

/** `@name:homeserver` or `name:homeserver` */
export function parseBotHandle(handle: string) {
  const match = handle.trim().match(/^@?([a-zA-Z0-9._]{2,32}):(\S+)$/);
  return match ? { username: match[1]!, homeserver: match[2]! } : null;
}

export async function lookupBot(username: string, homeserver: string) {
  const { data, error } = await anchor.client.bots.lookup.get({ query: { username, homeserver } });
  return error ? null : data;
}

export async function addBotToGuild(
  guildId: string,
  bot: { username: string; homeserver: string },
  role: 'MEMBER' | 'ADMIN'
) {
  const { error } = await anchor.client.guilds({ id: guildId }).bots.post({ ...bot, role });
  return error ? errorMessage(error, 'Could not add the bot.') : null;
}

export async function removeBotFromGuild(guildId: string, userId: string) {
  const { error } = await anchor.client.guilds({ id: guildId }).bots({ userId }).delete();
  return error ? errorMessage(error, 'Could not remove the bot.') : null;
}

// ---- using bots: slash commands and buttons ----------------------------------------------------

export type GuildBotCommands = { bot: PublicUser; commands: Command[] };
export type OptionValue = string | number | boolean;
const commandCacheMs = 30_000;

class InteractionsState {
  private commandsByGuild = $state<Record<string, { bots: GuildBotCommands[]; at: number }>>({});
  pressing = $state<string | null>(null);

  commandsFor(guildId: string | null) {
    return guildId ? (this.commandsByGuild[guildId]?.bots ?? []) : [];
  }

  async loadCommands(guildId: string, force = false) {
    const cached = this.commandsByGuild[guildId];
    if (!force && cached && Date.now() - cached.at < commandCacheMs) return cached.bots;
    const { data } = await anchor.client.guilds({ id: guildId }).commands.get();
    const bots = data?.bots ?? [];
    this.commandsByGuild = { ...this.commandsByGuild, [guildId]: { bots, at: Date.now() } };
    return bots;
  }

  async runCommand(
    channelId: string,
    entry: GuildBotCommands,
    name: string,
    options: { name: string; value: OptionValue }[]
  ) {
    const { data, error } = await anchor.client.interactions.post({
      channelId,
      type: 'command',
      botId: entry.bot.userId,
      name,
      options,
    });
    if (error) return errorMessage(error, 'The command could not be used.');
    // a deferred answer shows the bot thinking until its reply arrives. A fast bot's reply can
    // come over the socket before this answer does, and then there is nothing left to wait for.
    const replied = (chat.messagesByChannel[channelId] ?? []).some(
      (message) => message.interaction?.id === data.id
    );
    if (data.type === 'deferred' && !replied) {
      const thinkingId = `thinking:${data.id}`;
      // the bot has 15 minutes to answer; after that nothing will replace it
      setTimeout(() => chat.removeMessage(channelId, thinkingId), 15 * 60_000);
      chat.addMessage({
        id: thinkingId,
        channelId,
        content: null,
        createdAt: new Date(),
        author: entry.bot,
        thinking: true,
        ephemeral: data.ephemeral,
      });
    }
    return null;
  }

  async autocomplete(
    channelId: string,
    botId: string,
    name: string,
    options: { name: string; value: OptionValue }[],
    focused: string
  ) {
    const { data } = await anchor.client.interactions.post({
      channelId,
      type: 'autocomplete',
      botId,
      name,
      options,
      focused,
    });
    return data?.choices ?? [];
  }

  async pressButton(channelId: string, messageId: string, customId: string) {
    this.pressing = `${messageId}:${customId}`;
    const { error } = await anchor.client.interactions.post({
      channelId,
      type: 'button',
      messageId,
      customId,
    });
    this.pressing = null;
    return error ? errorMessage(error, 'Nothing happened. Try again.') : null;
  }
}

export const interactions = new InteractionsState();
