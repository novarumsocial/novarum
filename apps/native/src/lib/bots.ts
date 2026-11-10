// Port of apps/frontend/src/lib/bots.svelte.ts (using bots: slash commands and buttons; the developer panel is web only)
import { create } from 'zustand';
import { z } from 'zod';
import type { Command } from 'anchor/bot-schemas';
import type { PublicUser } from 'anchor/public-user';
import { anchor } from './anchor';
import { chat } from './chat-state';

const apiErrorSchema = z.object({ error: z.string() });
// eden puts the error body in `value`; validation errors only have a message
const errorMessage = (error: { value?: unknown } | null | undefined, fallback: string) =>
  apiErrorSchema.safeParse(error?.value).data?.error ?? fallback;

export type GuildBotCommands = { bot: PublicUser; commands: Command[] };
export type OptionValue = string | number | boolean;
const commandCacheMs = 30_000;
const noCommands: GuildBotCommands[] = [];

type InteractionsState = {
  commandsByGuild: Record<string, { bots: GuildBotCommands[]; at: number }>;
  pressing: string | null;
  loadCommands: (guildId: string, force?: boolean) => Promise<GuildBotCommands[]>;
  runCommand: (
    channelId: string,
    entry: GuildBotCommands,
    name: string,
    options: { name: string; value: OptionValue }[]
  ) => Promise<string | null>;
  autocomplete: (
    channelId: string,
    botId: string,
    name: string,
    options: { name: string; value: OptionValue }[],
    focused: string
  ) => Promise<{ name: string; value: string | number }[]>;
  pressButton: (channelId: string, messageId: string, customId: string) => Promise<string | null>;
};

export const useInteractions = create<InteractionsState>((set, get) => ({
  commandsByGuild: {},
  pressing: null,

  async loadCommands(guildId, force = false) {
    const cached = get().commandsByGuild[guildId];
    if (!force && cached && Date.now() - cached.at < commandCacheMs) return cached.bots;
    const { data } = await anchor().client.guilds({ id: guildId }).commands.get();
    const bots = data?.bots ?? [];
    set({ commandsByGuild: { ...get().commandsByGuild, [guildId]: { bots, at: Date.now() } } });
    return bots;
  },

  async runCommand(channelId, entry, name, options) {
    const { data, error } = await anchor().client.interactions.post({
      channelId,
      type: 'command',
      botId: entry.bot.userId,
      name,
      options,
    });
    if (error) return errorMessage(error, 'The command could not be used.');
    // a deferred answer shows the bot thinking until its reply arrives. A fast bot's reply can
    // come over the socket before this answer does, and then there is nothing left to wait for.
    const replied = (chat().messagesByChannel[channelId] ?? []).some(
      (message) => message.interaction?.id === data.id
    );
    if (data.type === 'deferred' && !replied) {
      const thinkingId = `thinking:${data.id}`;
      // the bot has 15 minutes to answer; after that nothing will replace it
      setTimeout(() => chat().removeMessage(channelId, thinkingId), 15 * 60_000);
      chat().addMessage({
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
  },

  async autocomplete(channelId, botId, name, options, focused) {
    const { data } = await anchor().client.interactions.post({
      channelId,
      type: 'autocomplete',
      botId,
      name,
      options,
      focused,
    });
    return data?.choices ?? [];
  },

  async pressButton(channelId, messageId, customId) {
    set({ pressing: `${messageId}:${customId}` });
    const { error } = await anchor().client.interactions.post({
      channelId,
      type: 'button',
      messageId,
      customId,
    });
    set({ pressing: null });
    return error ? errorMessage(error, 'Nothing happened. Try again.') : null;
  },
}));

// Same name as on the web: `interactions().runCommand(...)`
export const interactions = useInteractions.getState;

export const useGuildCommands = (guildId: string | null) =>
  useInteractions((s) => (guildId ? (s.commandsByGuild[guildId]?.bots ?? noCommands) : noCommands));

// ---- adding bots to guilds (guild settings) ----------------------------------------------------

/** `@name:homeserver` or `name:homeserver` */
export function parseBotHandle(handle: string) {
  const match = handle.trim().match(/^@?([a-zA-Z0-9._]{2,32}):(\S+)$/);
  return match ? { username: match[1]!, homeserver: match[2]! } : null;
}

export async function addBotToGuild(
  guildId: string,
  bot: { username: string; homeserver: string },
  role: 'MEMBER' | 'ADMIN'
) {
  const { error } = await anchor()
    .client.guilds({ id: guildId })
    .bots.post({ ...bot, role });
  return error ? errorMessage(error, 'Could not add the bot.') : null;
}

export async function removeBotFromGuild(guildId: string, userId: string) {
  const { error } = await anchor().client.guilds({ id: guildId }).bots({ userId }).delete();
  return error ? errorMessage(error, 'Could not remove the bot.') : null;
}
