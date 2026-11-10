import type { Server } from 'elysia/universal';
import { z } from 'zod';
import { db, users } from '../../src/db';
import { getConfig } from '../../utils/config';
import { postSignedFederationJson } from '../../utils/discovery';
import { vetLocalIdentity } from '../../utils/federatedLocalUser';
import { makeFederatedChannelId, makeFederatedGuildId } from '../../utils/federationIds';
import { federationUserPayload } from '../../utils/federationPayload';
import { publishRealtime } from '../../utils/publishRealtime';
import { rateLimiter } from '../../utils/rateLimit';
import { findHostInteraction, interactionLifetimeMs, respond, tokenMatches } from './host';
import { ephemeralMessageSchema, interactionPayloadSchema, type RespondAction } from './schemas';

// Interactions as the bot's homeserver sees them, when the guild is hosted somewhere else: we
// pass the interaction on to the bot, and its answers back to the host, which holds the state.

type User = typeof users.$inferSelect;
type Failure = { ok: false; status: 400 | 403 | 404 | 429 | 502 | 504; error: string };
const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });

const relayed = new Map<string, { token: string; botId: string; host: string }>();
const remoteErrorSchema = z.object({ error: z.string() });
export const maxRelayedPerHostPerMinute = 600;
const allowDelivery = rateLimiter(maxRelayedPerHostPerMinute);
const allowEphemeral = rateLimiter(maxRelayedPerHostPerMinute);

// A host may only send one of our people ephemeral messages for a while after they used an
// interaction there; otherwise any guild could whisper "only you can see this" phishing at them.
const expectingEphemerals = new Map<string, number>();
const ephemeralKey = (userId: string, host: string) => `${userId}:${host.toLowerCase()}`;

export function expectEphemerals(userId: string, host: string) {
  const key = ephemeralKey(userId, host);
  expectingEphemerals.set(key, Date.now() + interactionLifetimeMs);
  setTimeout(() => {
    if ((expectingEphemerals.get(key) ?? 0) <= Date.now()) expectingEphemerals.delete(key);
  }, interactionLifetimeMs + 1_000).unref?.();
}

/** On the bot's homeserver: the host of a guild tells one of our bots about an interaction. */
export async function acceptDelivery(server: Server | null, origin: string, payload: unknown) {
  const body = z
    .object({ bot: z.string(), interaction: interactionPayloadSchema })
    .safeParse(payload);
  if (!body.success) return fail(400, 'Invalid interaction');
  if (!allowDelivery(origin.toLowerCase())) return fail(429, 'Too many interactions');
  const { interaction } = body.data;

  const bot = await db.query.users.findFirst({
    where: { username: body.data.bot, homeserver: getConfig().server.homeserver, isBot: true },
  });
  if (!bot) return fail(404, 'Bot not found');

  // the host can only send interactions from its own guilds, and only to bots that are in them
  const guildId = makeFederatedGuildId(origin, interaction.guildId);
  const channelId = makeFederatedChannelId(origin, interaction.channelId);
  const membership = await db.query.guildMembers.findFirst({ where: { guildId, userId: bot.id } });
  if (!membership) return fail(403, 'Bot is not in this guild');
  // nor speak for one of our people who isn't in the guild
  const user = await vetLocalIdentity({ guildId, channelId }, interaction.user);
  if (!user) return fail(403, 'Forbidden');
  if (relayed.has(interaction.id)) return fail(400, 'Interaction already delivered');

  relayed.set(interaction.id, { token: interaction.token, botId: bot.id, host: origin });
  setTimeout(() => relayed.delete(interaction.id), interactionLifetimeMs).unref?.();

  if (server) {
    publishRealtime(server, `userEvents:${bot.id}`, {
      type: 'interaction.created',
      data: { ...interaction, guildId, channelId, user },
    });
  }
  return { ok: true as const };
}

/** A bot answers an interaction, here or through the guild's host. */
export async function botRespond(
  server: Server | null,
  bot: User,
  id: string,
  token: string,
  action: RespondAction
): Promise<{ ok: true } | Failure> {
  const local = findHostInteraction(id);
  if (local) {
    if (local.bot.id !== bot.id || !tokenMatches(local.token, token)) {
      return fail(404, 'Interaction not found');
    }
    return respond(server, local, action);
  }

  const remote = relayed.get(id);
  if (!remote || remote.botId !== bot.id || !tokenMatches(remote.token, token)) {
    return fail(404, 'Interaction not found');
  }
  const result = await postSignedFederationJson(
    remote.host,
    `/federation/interactions/${encodeURIComponent(id)}/respond`,
    { user: federationUserPayload({ user: bot }), token, ...action }
  ).catch(() => null);
  if (!result) return fail(502, "Could not reach the guild's homeserver");
  if (!result.response.ok) {
    const error = remoteErrorSchema.safeParse(result.data);
    const status = [400, 403, 404].includes(result.response.status)
      ? (result.response.status as 400 | 403 | 404)
      : 502;
    return fail(
      status,
      error.success ? error.data.error : 'The guild homeserver refused the response'
    );
  }
  return { ok: true };
}

/** On the guild's host: a remote bot answers, through its homeserver. */
export async function acceptRemoteResponse(
  server: Server | null,
  remoteUser: { username: string; homeserver: string },
  id: string,
  token: string,
  action: RespondAction
) {
  const interaction = findHostInteraction(id);
  if (
    !interaction ||
    interaction.bot.username !== remoteUser.username ||
    interaction.bot.homeserver.toLowerCase() !== remoteUser.homeserver.toLowerCase() ||
    !tokenMatches(interaction.token, token)
  ) {
    return fail(404, 'Interaction not found');
  }
  return respond(server, interaction, action);
}

/** On a person's homeserver: a guild's host sends them an ephemeral message from a bot. */
export async function acceptEphemeral(server: Server | null, origin: string, payload: unknown) {
  const body = z
    .object({ username: z.string(), message: ephemeralMessageSchema })
    .safeParse(payload);
  if (!body.success) return fail(400, 'Invalid ephemeral message');
  if (!allowEphemeral(origin.toLowerCase())) return fail(429, 'Too many ephemeral messages');
  const { message } = body.data;
  // only bots answer interactions
  if (!message.author.isBot) return fail(403, 'Forbidden');

  const user = await db.query.users.findFirst({
    where: { username: body.data.username, homeserver: getConfig().server.homeserver },
  });
  if (!user) return fail(404, 'User not found');
  if ((expectingEphemerals.get(ephemeralKey(user.id, origin)) ?? 0) <= Date.now()) {
    return fail(403, 'Forbidden');
  }
  // only for a channel of a guild of the sender that our person is in
  const guildId = makeFederatedGuildId(origin, message.guildId);
  const channelId = makeFederatedChannelId(origin, message.channelId);
  const [membership, channel] = await Promise.all([
    db.query.guildMembers.findFirst({ where: { guildId, userId: user.id } }),
    db.query.channels.findFirst({ where: { id: channelId, guildId } }),
  ]);
  if (!membership || !channel) return fail(403, 'Forbidden');
  const scope = { guildId, channelId };
  const author = await vetLocalIdentity(scope, message.author);
  const interactionUser =
    message.interaction && (await vetLocalIdentity(scope, message.interaction.user));
  if (!author) return fail(403, 'Forbidden');

  if (server) {
    publishRealtime(server, `userEvents:${user.id}`, {
      type: 'message.ephemeral',
      data: {
        ...message,
        guildId,
        channelId,
        author,
        interaction:
          message.interaction && interactionUser
            ? { ...message.interaction, user: interactionUser }
            : null,
      },
    });
  }
  return { ok: true as const };
}
