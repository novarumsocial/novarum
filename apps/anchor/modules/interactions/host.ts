import type { Server } from 'elysia/universal';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, messages, users } from '../../src/db';
import { getConfig } from '../../utils/config';
import { postSignedFederationJson } from '../../utils/discovery';
import { publicUser } from '../../utils/publicUser';
import { publishRealtime, publishToChannel } from '../../utils/publishRealtime';
import { randomString } from '../../utils/randomString';
import { canAccessChannel } from '../../utils/channelAccess';
import { commandListSchema, type Command, type CommandOption } from '../../utils/botSchemas';
import { messagePayload } from '../../utils/messagePayload';
import { createMessage, editMessage } from '../message/store';
import { getPingRecipients } from '../message/services';
import type {
  Callback,
  EphemeralMessage,
  InteractionInput,
  InteractionPayload,
  InteractionResult,
  RespondAction,
  ResponseMessage,
} from './schemas';

// Interactions as the guild's host sees them. The host is the one that knows the guild, the
// channel, the commands and the messages, so it checks everything and keeps the state; the bot
// (here or on its own homeserver) only gets told about it and answers with the token.

type User = typeof users.$inferSelect;
type Channel = { id: string; guildId: string | null; type: string };
type Failure = { ok: false; status: 400 | 403 | 404 | 502 | 504; error: string };
const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });

export const interactionLifetimeMs = 15 * 60_000;
// how long the person's client waits for the bot to acknowledge, like Discord's 3 seconds, plus
// some room for a bot on another homeserver
const ackTimeoutMs = (botIsRemote: boolean) => (botIsRemote ? 5_000 : 3_000);
const maxFollowups = 10;

type HostInteraction = {
  id: string;
  token: string;
  type: InteractionInput['type'];
  name: string;
  bot: User;
  user: User;
  channel: Channel & { guildId: string };
  // the message a button was on
  source?: { id: string; ephemeral: boolean };
  acknowledged: boolean;
  deferred: boolean;
  ephemeral: boolean;
  original?: { id: string; ephemeral: boolean };
  followups: number;
  settle?: (result: Omit<InteractionResult, 'id'>) => void;
};

const interactions = new Map<string, HostInteraction>();

// ephemeral messages live only on the invoking person's screen; we keep what we need to handle
// a button press on one, and to edit it
type StoredEphemeral = { message: EphemeralMessage; botId: string; userId: string };
const ephemerals = new Map<string, StoredEphemeral>();

const ours = (homeserver: string) =>
  homeserver.toLowerCase() === getConfig().server.homeserver.toLowerCase();

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.set(key, value);
  setTimeout(() => map.delete(key), interactionLifetimeMs).unref?.();
}

export function tokenMatches(expected: string, given: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const findHostInteraction = (id: string) => interactions.get(id);

// ---- commands ---------------------------------------------------------------------------------

const remoteCommandCache = new Map<string, { commands: Command[]; expires: number }>();
const remoteCommandTtlMs = 60_000;

/** The global commands of a bot in one of our guilds, asked from its homeserver when it is remote. */
export async function botCommands(bot: User, guildId: string): Promise<Command[]> {
  if (ours(bot.homeserver)) {
    const row = await db.query.bots.findFirst({ where: { userId: bot.id } });
    return row?.commands ?? [];
  }
  const key = `${bot.id}:${guildId}`;
  const cached = remoteCommandCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.commands;

  const result = await postSignedFederationJson(
    bot.homeserver,
    `/federation/bots/${encodeURIComponent(bot.username)}/commands`,
    { guildId }
  ).catch(() => null);
  const parsed = z.object({ commands: commandListSchema }).safeParse(result?.data);
  const commands = result?.response.ok && parsed.success ? parsed.data.commands : [];
  remoteCommandCache.set(key, { commands, expires: Date.now() + remoteCommandTtlMs });
  return commands;
}

/** Every bot of one of our guilds with its commands, for the person typing a slash. */
export async function guildCommands(guildId: string) {
  const members = await db.query.guildMembers.findMany({
    where: { guildId, user: { isBot: true } },
    with: { user: true },
  });
  return {
    bots: await Promise.all(
      members.map(async ({ user }) => ({
        bot: publicUser(user),
        commands: await botCommands(user, guildId),
      }))
    ),
  };
}

type ResolvedOption = NonNullable<InteractionPayload['data']['options']>[number];

// checks the options a person filled in against the command, and fills in users
async function resolveOptions(
  command: Command,
  given: { name: string; value: string | number | boolean }[],
  guildId: string,
  focused?: string
): Promise<{ ok: true; options: ResolvedOption[] } | Failure> {
  const byName = new Map(given.map((option) => [option.name, option.value]));
  if (byName.size !== given.length) return fail(400, 'Duplicate option');
  const known = new Map(command.options.map((option) => [option.name, option]));
  for (const name of byName.keys())
    if (!known.has(name)) return fail(400, `Unknown option ${name}`);

  const options: ResolvedOption[] = [];
  for (const definition of command.options) {
    const value = byName.get(definition.name);
    if (definition.name === focused) {
      if (!definition.autocomplete) return fail(400, 'This option has no autocomplete');
      options.push({
        name: definition.name,
        type: definition.type,
        value: String(value ?? ''),
        focused: true,
      });
      continue;
    }
    if (value === undefined) {
      if (definition.required && !focused) return fail(400, `Missing option ${definition.name}`);
      continue;
    }
    const resolved = await resolveOption(definition, value, guildId);
    if (!resolved) return fail(400, `Invalid value for ${definition.name}`);
    options.push(resolved);
  }
  return { ok: true, options };
}

async function resolveOption(
  definition: CommandOption,
  value: string | number | boolean,
  guildId: string
): Promise<ResolvedOption | null> {
  const base = { name: definition.name, type: definition.type };
  const inChoices = (v: string | number) =>
    !definition.choices || definition.choices.some((choice) => choice.value === v);
  switch (definition.type) {
    case 'string': {
      if (typeof value !== 'string' || !inChoices(value)) return null;
      if (definition.minLength !== undefined && value.length < definition.minLength) return null;
      if (definition.maxLength !== undefined && value.length > definition.maxLength) return null;
      return { ...base, value };
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || !inChoices(value)) return null;
      if (definition.type === 'integer' && !Number.isInteger(value)) return null;
      if (definition.minValue !== undefined && value < definition.minValue) return null;
      if (definition.maxValue !== undefined && value > definition.maxValue) return null;
      return { ...base, value };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ...base, value } : null;
    case 'user': {
      // the person picks a member by id; the bot gets the handle, which means the same everywhere
      if (typeof value !== 'string') return null;
      const member = await db.query.guildMembers.findFirst({
        where: { guildId, userId: value },
        with: { user: true },
      });
      if (!member) return null;
      const user = publicUser(member.user);
      return { ...base, value: `@${user.username}:${user.homeserver}`, user };
    }
  }
}

// ---- starting an interaction ------------------------------------------------------------------

/** On the guild's host: `user` (one of our rows) starts an interaction in `channel`. */
export async function startInteraction(
  server: Server | null,
  channel: Channel,
  user: User,
  input: InteractionInput
): Promise<{ ok: true; result: InteractionResult } | Failure> {
  if (!channel.guildId) return fail(404, 'Channel not found');
  const guildId = channel.guildId;
  if (!(await canAccessChannel(channel, user.id, input.type !== 'autocomplete'))) {
    return fail(403, 'Forbidden');
  }

  let bot: User;
  let name: string;
  let data: InteractionPayload['data'];
  let source: HostInteraction['source'];
  let message: InteractionPayload['message'];

  if (input.type === 'button') {
    const found = await findButton(input.messageId, channel.id, user.id, input.customId);
    if (!found.ok) return found;
    ({ bot } = found);
    name = input.customId;
    data = { name: input.customId, customId: input.customId };
    source = { id: input.messageId, ephemeral: found.ephemeral };
    message = { id: input.messageId, ephemeral: found.ephemeral, content: found.content };
  } else {
    const member = await db.query.guildMembers.findFirst({
      where: { guildId, userId: input.botId },
      with: { user: true },
    });
    if (!member?.user.isBot) return fail(404, 'Bot not found');
    bot = member.user;
    const command = (await botCommands(bot, guildId)).find((c) => c.name === input.name);
    if (!command) return fail(404, 'Command not found');
    const options = await resolveOptions(
      command,
      input.options,
      guildId,
      input.type === 'autocomplete' ? input.focused : undefined
    );
    if (!options.ok) return options;
    name = command.name;
    data = { name: command.name, options: options.options };
  }

  const interaction: HostInteraction = {
    id: randomString(),
    token: randomString(),
    type: input.type,
    name,
    bot,
    user,
    channel: { ...channel, guildId },
    source,
    acknowledged: false,
    deferred: false,
    ephemeral: false,
    followups: 0,
  };
  remember(interactions, interaction.id, interaction);

  const payload: InteractionPayload = {
    id: interaction.id,
    token: interaction.token,
    type: input.type,
    guildId,
    channelId: channel.id,
    user: publicUser(user),
    data,
    message,
  };

  const botIsRemote = !ours(bot.homeserver);
  const acknowledged = new Promise<Omit<InteractionResult, 'id'> | null>((resolve) => {
    interaction.settle = resolve;
    setTimeout(() => resolve(null), ackTimeoutMs(botIsRemote)).unref?.();
  });

  if (botIsRemote) {
    const delivered = await postSignedFederationJson(bot.homeserver, '/federation/interactions', {
      bot: bot.username,
      interaction: payload,
    }).catch(() => null);
    if (!delivered?.response.ok) return fail(502, "Could not reach the bot's homeserver");
  } else if (server) {
    publishRealtime(server, `userEvents:${bot.id}`, { type: 'interaction.created', data: payload });
  }

  const result = await acknowledged;
  interaction.settle = undefined;
  if (!result) return fail(504, "The bot didn't respond in time");
  return { ok: true, result: { ...result, id: interaction.id } };
}

async function findButton(messageId: string, channelId: string, userId: string, customId: string) {
  const hasButton = (rows: { components: { customId?: string; disabled?: boolean }[] }[] | null) =>
    rows?.some((row) => row.components.some((b) => b.customId === customId && !b.disabled));

  const ephemeral = ephemerals.get(messageId);
  if (ephemeral) {
    if (ephemeral.userId !== userId || ephemeral.message.channelId !== channelId) {
      return fail(404, 'Message not found');
    }
    if (!hasButton(ephemeral.message.components)) return fail(404, 'Button not found');
    const bot = await db.query.users.findFirst({ where: { id: ephemeral.botId } });
    if (!bot) return fail(404, 'Bot not found');
    return { ok: true as const, bot, ephemeral: true, content: ephemeral.message.content };
  }

  const stored = await db.query.messages.findFirst({
    where: { id: messageId, channelId },
    with: { author: true },
  });
  if (!stored) return fail(404, 'Message not found');
  if (!stored.author.isBot || !hasButton(stored.components)) return fail(404, 'Button not found');
  // the bot has to still be in the guild to answer
  const channel = await db.query.channels.findFirst({ where: { id: channelId } });
  const member =
    channel?.guildId &&
    (await db.query.guildMembers.findFirst({
      where: { guildId: channel.guildId, userId: stored.authorId },
    }));
  if (!member) return fail(404, 'Bot not found');
  return { ok: true as const, bot: stored.author, ephemeral: false, content: stored.content };
}

// ---- the bot answering ------------------------------------------------------------------------

/** On the guild's host: the bot answers an interaction (already checked: token and bot). */
export async function respond(
  server: Server | null,
  interaction: HostInteraction,
  action: RespondAction
): Promise<{ ok: true } | Failure> {
  if (action.action === 'callback') {
    if (interaction.acknowledged) return fail(400, 'Interaction has already been acknowledged');
    const handled = await handleCallback(server, interaction, action.body);
    if (!handled.ok) return handled;
    interaction.acknowledged = true;
    interaction.settle?.(handled.result);
    return { ok: true };
  }

  if (!interaction.acknowledged) return fail(400, 'Acknowledge the interaction first');
  if (interaction.type === 'autocomplete') return fail(400, 'Autocomplete has no messages');

  if (action.action === 'followup') {
    if (isEmpty(action.body)) return fail(400, emptyMessage);
    if (interaction.followups >= maxFollowups) return fail(400, 'Too many follow-up messages');
    interaction.followups++;
    await sendResponse(server, interaction, action.body);
    return { ok: true };
  }

  // edit: the original response, the message a deferred answer was waiting for, or for a
  // button the message the button was on
  const original =
    interaction.original ?? (interaction.type === 'button' ? interaction.source : undefined);
  if (!original) {
    if (!interaction.deferred) return fail(404, 'There is no original response');
    if (isEmpty(action.body)) return fail(400, emptyMessage);
    interaction.original = await sendResponse(server, interaction, {
      ...action.body,
      ephemeral: interaction.ephemeral,
    });
    return { ok: true };
  }
  return editResponse(server, interaction, original, action.body);
}

async function handleCallback(
  server: Server | null,
  interaction: HostInteraction,
  callback: Callback
): Promise<{ ok: true; result: Omit<InteractionResult, 'id'> } | Failure> {
  const isAutocomplete = interaction.type === 'autocomplete';
  if (isAutocomplete !== (callback.type === 'autocomplete')) {
    return fail(400, isAutocomplete ? 'Answer autocomplete with choices' : 'Invalid callback type');
  }
  if ((callback.type === 'update' || callback.type === 'deferredUpdate') && !interaction.source) {
    return fail(400, 'Only button interactions can update their message');
  }

  switch (callback.type) {
    case 'autocomplete':
      return { ok: true, result: { type: 'autocomplete', choices: callback.data.choices } };
    case 'message':
      if (isEmpty(callback.data)) return fail(400, emptyMessage);
      interaction.original = await sendResponse(server, interaction, callback.data);
      return { ok: true, result: { type: 'message', ephemeral: interaction.original.ephemeral } };
    case 'deferred':
      interaction.deferred = true;
      interaction.ephemeral = callback.data?.ephemeral ?? false;
      return { ok: true, result: { type: 'deferred', ephemeral: interaction.ephemeral } };
    case 'update': {
      const edited = await editResponse(server, interaction, interaction.source!, callback.data);
      return edited.ok ? { ok: true, result: { type: 'update' } } : edited;
    }
    case 'deferredUpdate':
      return { ok: true, result: { type: 'deferredUpdate' } };
  }
}

// a new message needs something to show; edits may leave the content as it is
const isEmpty = (message: ResponseMessage) => !message.content && !message.embeds?.length;
const emptyMessage = 'A message needs content or an embed';

const interactionMeta = (interaction: HostInteraction) =>
  interaction.type === 'command'
    ? { id: interaction.id, name: interaction.name, user: publicUser(interaction.user) }
    : null;

async function sendResponse(
  server: Server | null,
  interaction: HostInteraction,
  body: ResponseMessage
) {
  const { channel, bot } = interaction;
  if (body.ephemeral) {
    const message: EphemeralMessage = {
      id: randomString(),
      channelId: channel.id,
      guildId: channel.guildId,
      content: body.content ?? null,
      embeds: body.embeds ?? [],
      components: body.components ?? [],
      author: publicUser(bot),
      interaction: interactionMeta(interaction),
      createdAt: new Date().toISOString(),
      ephemeral: true,
    };
    remember(ephemerals, message.id, { message, botId: bot.id, userId: interaction.user.id });
    await deliverEphemeral(server, interaction.user, message);
    return { id: message.id, ephemeral: true };
  }

  const content = body.content ?? null;
  const created = await createMessage({
    channel,
    authorId: bot.id,
    content,
    replyTo: null,
    nonce: `interaction:${interaction.id}:${interaction.followups}:${randomString()}`,
    pingRecipients: await getPingRecipients(channel.guildId, content, undefined, bot.id),
    attachments: [],
    embeds: body.embeds ?? null,
    components: body.components ?? null,
    interaction: interactionMeta(interaction),
  });
  if (server) {
    await publishToChannel(server, channel, {
      type: 'message.created',
      data: messagePayload({ ...created, attachments: [] }, channel, bot),
    });
  }
  return { id: created.id, ephemeral: false };
}

async function editResponse(
  server: Server | null,
  interaction: HostInteraction,
  target: { id: string; ephemeral: boolean },
  body: ResponseMessage
): Promise<{ ok: true } | Failure> {
  if (target.ephemeral) {
    const stored = ephemerals.get(target.id);
    if (!stored) return fail(404, 'Message not found');
    stored.message = {
      ...stored.message,
      content: body.content === undefined ? stored.message.content : body.content,
      embeds: body.embeds ?? stored.message.embeds,
      components: body.components ?? stored.message.components,
    };
    const user = await db.query.users.findFirst({ where: { id: stored.userId } });
    if (user) await deliverEphemeral(server, user, stored.message);
    return { ok: true };
  }

  const existing = await db.query.messages.findFirst({
    where: { id: target.id, authorId: interaction.bot.id },
  });
  if (!existing) return fail(404, 'Message not found');
  const content = body.content === undefined ? existing.content : body.content;
  await editMessage(
    existing.id,
    content,
    await getPingRecipients(interaction.channel.guildId, content, undefined, interaction.bot.id)
  );
  const [updated] = await db
    .update(messages)
    .set({
      embeds: body.embeds ?? existing.embeds,
      components: body.components ?? existing.components,
    })
    .where(eq(messages.id, existing.id))
    .returning();
  if (server && updated) {
    await publishToChannel(server, interaction.channel, {
      type: 'message.updated',
      data: messagePayload({ ...updated, attachments: [] }, interaction.channel, interaction.bot),
    });
  }
  return { ok: true };
}

// an ephemeral message goes to the person alone: straight to their sockets when they are ours,
// otherwise to their homeserver, which passes it on to them
async function deliverEphemeral(server: Server | null, user: User, message: EphemeralMessage) {
  if (ours(user.homeserver)) {
    if (server)
      publishRealtime(server, `userEvents:${user.id}`, {
        type: 'message.ephemeral',
        data: message,
      });
    return;
  }
  await postSignedFederationJson(user.homeserver, '/federation/interactions/ephemeral', {
    username: user.username,
    message,
  }).catch(() => null);
}
