import type { Server } from 'elysia/universal';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, guildMembers, users } from '../../src/db';
import { getConfig } from '../../utils/config';
import {
  assertSafeFederationUrl,
  discoverRemoteAnchor,
  federationRequestTimeoutMs,
  postSignedFederationJson,
} from '../../utils/discovery';
import { readJson } from '../../utils/parseJson';
import { remoteSupports } from '../../utils/federationFeatures';
import { makeFederatedGuildId, parseFederatedGuildId } from '../../utils/federationIds';
import {
  federationUserPayload,
  federationUserSchema,
  upsertFederatedUser,
} from '../../utils/federationPayload';
import { ensureFederatedGuildRealtimeBridge } from '../../utils/federationRealtime';
import { canAddBot } from '../../utils/guildRoles';
import { publicUser } from '../../utils/publicUser';
import { publishRealtime } from '../../utils/publishRealtime';
import { randomString } from '../../utils/randomString';
import { rateLimiter } from '../../utils/rateLimit';
import { guildChannels, persistFederatedInviteSnapshot } from '../invite/services';
import { unsubscribeUserFromGuild } from '../realtime/services';

// Adding bots to guilds and taking them out again. The guild's host decides who may add a bot;
// the bot's homeserver decides whether the bot may join (public, or asked for by its owner).

export type BotRole = 'ADMIN' | 'MEMBER';
export type BotRef = { username: string; homeserver: string };
type Failure = { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502; error: string };
type Result = { ok: true } | Failure;
type User = typeof users.$inferSelect;

const ours = (homeserver: string) =>
  homeserver.toLowerCase() === getConfig().server.homeserver.toLowerCase();
const fail = (status: Failure['status'], error: string): Failure => ({
  ok: false,
  status,
  error,
});

// ---- one-time grants for private bots ---------------------------------------------------------

// A private bot may only join a guild its owner asked for. When the guild is on another
// homeserver, that homeserver can't prove who asked, so the owner's request leaves a grant here
// that the host has to hand back when it asks us to let the bot join.
const grants = new Map<string, { botId: string; host: string; guildId: string; expires: number }>();
const grantTtlMs = 60_000;

function createGrant(botId: string, host: string, guildId: string) {
  const grant = randomString();
  grants.set(grant, { botId, host: host.toLowerCase(), guildId, expires: Date.now() + grantTtlMs });
  setTimeout(() => grants.delete(grant), grantTtlMs).unref?.();
  return grant;
}

function consumeGrant(grant: string | undefined, botId: string, host: string, guildId: string) {
  const found = grant ? grants.get(grant) : undefined;
  if (!found) return false;
  grants.delete(grant!);
  return (
    found.expires > Date.now() &&
    found.botId === botId &&
    found.host === host.toLowerCase() &&
    found.guildId === guildId
  );
}

// ---- adding -----------------------------------------------------------------------------------

// every try can leave a grant and a placeholder row behind for a while, and asks another server
export const maxBotAddsPerMinute = 10;
export const allowBotAdd = rateLimiter(maxBotAddsPerMinute);

const remoteJoinResponseSchema = z.object({ user: federationUserSchema });
const remoteErrorSchema = z.object({ error: z.string() });

/** A local person adds a bot to a guild; the guild may be hosted here or on another homeserver. */
export async function requestAddBot(
  server: Server | null,
  adder: { userId: string; user: User },
  guildId: string,
  bot: BotRef,
  role: BotRole
): Promise<Result> {
  if (!allowBotAdd(adder.userId)) return fail(429, 'Too many bots added, try again later');
  const federatedGuild = parseFederatedGuildId(guildId);
  if (!federatedGuild) {
    const guild = await db.query.guilds.findFirst({ where: { id: guildId } });
    if (!guild) return fail(404, 'Guild not found');
    return hostAddBot(server, guild, adder.userId, bot, role, undefined);
  }

  if (!(await db.query.guildMembers.findFirst({ where: { guildId, userId: adder.userId } }))) {
    return fail(404, 'Guild not found');
  }
  const remote = await discoverRemoteAnchor(federatedGuild.homeserver).catch(() => null);
  if (!remote) return fail(502, 'Could not reach remote homeserver');
  if (!remoteSupports(remote, 'bots')) {
    return fail(400, "This guild's homeserver doesn't support bots");
  }

  // our own private bot, asked for by its owner: leave a grant for the host to bring back
  let grant: string | undefined;
  if (ours(bot.homeserver)) {
    const local = await findLocalBot(bot.username);
    if (local?.bot.ownerId === adder.userId) {
      grant = createGrant(local.user.id, federatedGuild.homeserver, federatedGuild.id);
    }
  }

  const result = await postSignedFederationJson(
    federatedGuild.homeserver,
    `/federation/guilds/${encodeURIComponent(federatedGuild.id)}/bots`,
    {
      user: federationUserPayload(adder),
      username: bot.username,
      homeserver: bot.homeserver,
      role,
      grant,
    }
  ).catch(() => null);
  if (!result) return fail(502, 'Could not reach remote homeserver');
  if (!result.response.ok) {
    const error = remoteErrorSchema.safeParse(result.data);
    const status = [400, 403, 404, 409, 429].includes(result.response.status)
      ? (result.response.status as 400 | 403 | 404 | 409 | 429)
      : 502;
    return fail(status, error.success ? error.data.error : 'Remote homeserver refused the bot');
  }
  return { ok: true };
}

async function findLocalBot(username: string) {
  const user = await db.query.users.findFirst({
    where: { username, homeserver: getConfig().server.homeserver, isBot: true },
    with: { bot: true },
  });
  return user?.bot ? { user, bot: user.bot } : null;
}

/** On the guild's host: `adderId` (one of our user rows) adds a bot. */
export async function hostAddBot(
  server: Server | null,
  guild: {
    id: string;
    ownerId: string;
    name: string;
    description: string | null;
    avatarUrl: string | null;
  },
  adderId: string,
  bot: BotRef,
  role: BotRole,
  grant: string | undefined
): Promise<Result> {
  if (parseFederatedGuildId(guild.id)) return fail(400, 'Cannot manage a federated guild');
  if (!(await canAddBot(guild, adderId, role))) {
    return fail(403, role === 'ADMIN' ? 'Only the guild owner can add admin bots' : 'Forbidden');
  }

  let botUser: User;
  if (ours(bot.homeserver)) {
    const local = await findLocalBot(bot.username);
    if (!local) return fail(404, 'Bot not found');
    if (!local.bot.public && local.bot.ownerId !== adderId) {
      return fail(403, 'This bot is private');
    }
    botUser = local.user;
    if (await isMember(guild.id, botUser.id)) return fail(409, 'This bot is already in the guild');
    await addMember(guild.id, botUser.id, role);
  } else {
    const remote = await reachBotHomeserver(bot.homeserver);
    if (!remote.ok) return remote;
    // The bot's homeserver starts following the guild as soon as it agrees, and we only let a
    // homeserver follow guilds it has members in, so the membership comes first and goes again
    // if the bot's homeserver refuses.
    const placeholder = await remoteUserRow({ ...bot, homeserver: remote.homeserver });
    if (!placeholder.ok) return placeholder;
    if (await isMember(guild.id, placeholder.user.id)) {
      return fail(409, 'This bot is already in the guild');
    }
    await addMember(guild.id, placeholder.user.id, role);
    const joined = await askBotToJoin(remote.homeserver, guild, bot, role, grant);
    if (!joined.ok) {
      await db
        .delete(guildMembers)
        .where(
          and(eq(guildMembers.guildId, guild.id), eq(guildMembers.userId, placeholder.user.id))
        );
      const elsewhere = await db.query.guildMembers.findFirst({
        where: { userId: placeholder.user.id },
      });
      if (placeholder.created && !elsewhere) {
        await db.delete(users).where(eq(users.id, placeholder.user.id));
      }
      return joined;
    }
    botUser = joined.user;
  }

  if (server) {
    publishRealtime(server, `guildEvents:${guild.id}`, {
      type: 'member.joined',
      data: {
        guildId: guild.id,
        user: { ...publicUser(botUser), status: botUser.status as 'ONLINE' | 'OFFLINE' },
      },
    });
    if (ours(botUser.homeserver)) {
      publishRealtime(server, `userEvents:${botUser.id}`, {
        type: 'guild.created',
        data: {
          id: guild.id,
          name: guild.name,
          ownerId: guild.ownerId,
          avatarUrl: guild.avatarUrl,
          description: guild.description,
          channels: await guildChannels(guild.id),
        },
      });
    }
  }
  return { ok: true };
}

const isMember = async (guildId: string, userId: string) =>
  !!(await db.query.guildMembers.findFirst({ where: { guildId, userId } }));

async function reachBotHomeserver(homeserver: string) {
  const remote = await discoverRemoteAnchor(homeserver).catch(() => null);
  if (!remote) return fail(502, "Could not reach the bot's homeserver");
  if (!remoteSupports(remote, 'bots')) {
    return fail(400, "The bot's homeserver doesn't support bots");
  }
  return { ok: true as const, homeserver: remote.homeserver.toLowerCase() };
}

// our row for a remote bot, made bare when we've never seen it; its profile arrives with the join.
// A person we already know by that name stays a person: it can't be added as a bot.
async function remoteUserRow(bot: BotRef) {
  const { homeserver, username } = bot;
  const existing = await db.query.users.findFirst({ where: { username, homeserver } });
  if (existing) {
    return existing.isBot
      ? { ok: true as const, user: existing, created: false }
      : fail(400, 'That user is not a bot');
  }
  const now = new Date();
  const [created] = await db
    .insert(users)
    .values({
      id: randomString(),
      username: bot.username,
      homeserver,
      isBot: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { ok: true as const, user: created, created: true };
  return remoteUserRow(bot);
}

async function addMember(guildId: string, userId: string, role: BotRole) {
  await db.transaction(async (tx) => {
    await tx
      .update(guildMembers)
      .set({ position: sql`${guildMembers.position} + 1` })
      .where(eq(guildMembers.userId, userId));
    await tx.insert(guildMembers).values({ guildId, userId, role, position: 0 });
  });
}

// the bot lives on another homeserver, which has to agree to it joining
async function askBotToJoin(
  homeserver: string,
  guild: { id: string; name: string; description: string | null; avatarUrl: string | null },
  bot: BotRef,
  role: BotRole,
  grant: string | undefined
): Promise<{ ok: true; user: User } | Failure> {
  const result = await postSignedFederationJson(
    homeserver,
    `/federation/bots/${encodeURIComponent(bot.username)}/join`,
    {
      guild: {
        id: guild.id,
        homeserver: getConfig().server.homeserver,
        name: guild.name,
        description: guild.description,
        avatarUrl: guild.avatarUrl,
      },
      channels: await guildChannels(guild.id),
      role,
      grant,
    }
  ).catch(() => null);
  if (!result) return fail(502, "Could not reach the bot's homeserver");
  if (!result.response.ok) {
    const error = remoteErrorSchema.safeParse(result.data);
    const status = [403, 404].includes(result.response.status)
      ? (result.response.status as 403 | 404)
      : 502;
    return fail(status, error.success ? error.data.error : "The bot's homeserver refused");
  }

  const answer = remoteJoinResponseSchema.safeParse(result.data);
  if (
    !answer.success ||
    !answer.data.user.isBot ||
    answer.data.user.username !== bot.username ||
    answer.data.user.homeserver.toLowerCase() !== homeserver
  ) {
    return fail(502, "The bot's homeserver returned an invalid bot");
  }
  return { ok: true, user: await upsertFederatedUser(answer.data.user) };
}

const joinBodySchema = z.object({
  guild: z.object({ id: z.string().min(1), homeserver: z.string() }).loose(),
  role: z.enum(['ADMIN', 'MEMBER']),
  grant: z.string().optional(),
});

/** On the bot's homeserver: a remote guild host wants one of our bots to join. */
export async function acceptJoin(
  server: Server | null,
  origin: string,
  username: string,
  payload: unknown
): Promise<{ ok: true; user: ReturnType<typeof federationUserPayload> } | Failure> {
  const body = joinBodySchema.safeParse(payload);
  if (!body.success) return fail(400, 'Invalid bot join');
  // a homeserver can only bring bots into guilds it hosts itself
  if (body.data.guild.homeserver.toLowerCase() !== origin.toLowerCase()) {
    return fail(403, 'Guild homeserver mismatch');
  }

  const local = await findLocalBot(username);
  if (!local) return fail(404, 'Bot not found');
  if (
    !local.bot.public &&
    !consumeGrant(body.data.grant, local.user.id, origin, body.data.guild.id)
  ) {
    return fail(403, 'This bot is private');
  }

  const snapshot = await persistFederatedInviteSnapshot({ userId: local.user.id }, origin, payload);
  if (!snapshot) return fail(400, 'Invalid guild snapshot');

  if (server) {
    void ensureFederatedGuildRealtimeBridge(server, snapshot.guild.id).catch(() => null);
    publishRealtime(server, `userEvents:${local.user.id}`, {
      type: 'guild.created',
      data: {
        id: snapshot.guild.id,
        name: snapshot.guild.name,
        ownerId: local.user.id,
        avatarUrl: snapshot.guild.avatarUrl,
        description: snapshot.guild.description,
        channels: snapshot.channels,
      },
    });
  }
  return { ok: true, user: federationUserPayload({ user: local.user }) };
}

// ---- removing ---------------------------------------------------------------------------------

/** On the guild's host: `removerId` takes a bot out of the guild. */
export async function hostRemoveBot(
  server: Server | null,
  guild: { id: string; ownerId: string },
  removerId: string,
  botUserId: string
): Promise<Result> {
  if (parseFederatedGuildId(guild.id)) return fail(400, 'Cannot manage a federated guild');
  const member = await db.query.guildMembers.findFirst({
    where: { guildId: guild.id, userId: botUserId },
    with: { user: true },
  });
  if (!member?.user.isBot) return fail(404, 'Bot not found');
  if (!(await canAddBot(guild, removerId, member.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'))) {
    return fail(403, 'Forbidden');
  }

  await removeMember(server, guild.id, member.user);
  if (!ours(member.user.homeserver)) {
    // the bot's homeserver drops its copy of the guild; it can't refuse, so don't wait on it
    void postSignedFederationJson(
      member.user.homeserver,
      `/federation/bots/${encodeURIComponent(member.user.username)}/leave`,
      { guildId: guild.id }
    ).catch(() => null);
  }
  return { ok: true };
}

/** Deletes a membership and tells everyone: the guild that the member left, the member that it is gone. */
export async function removeMember(server: Server | null, guildId: string, user: User) {
  await db
    .delete(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, user.id)));
  unsubscribeUserFromGuild(user.id, guildId);
  if (!server) return;
  if (!parseFederatedGuildId(guildId)) {
    publishRealtime(server, `guildEvents:${guildId}`, {
      type: 'member.left',
      data: { guildId, userId: user.id },
    });
  }
  publishRealtime(server, `userEvents:${user.id}`, { type: 'guild.deleted', data: { guildId } });
}

/** On the bot's homeserver: one of our bots leaves a guild, wherever it is hosted. */
export async function leaveGuild(server: Server | null, bot: User, guildId: string) {
  const federatedGuild = parseFederatedGuildId(guildId);
  if (federatedGuild) {
    // best effort: we drop the guild either way, and the host won't send us its events anymore
    await postSignedFederationJson(
      federatedGuild.homeserver,
      `/federation/guilds/${encodeURIComponent(federatedGuild.id)}/bots/leave`,
      { user: federationUserPayload({ user: bot }) }
    ).catch(() => null);
  }
  await removeMember(server, guildId, bot);
}

/** On the bot's homeserver: the host of `guildId` took our bot out of it. */
export async function acceptLeave(
  server: Server | null,
  origin: string,
  username: string,
  guildId: string
) {
  const local = await findLocalBot(username);
  if (!local) return fail(404, 'Bot not found');
  // the origin can only take the bot out of guilds it hosts itself
  await removeMember(server, makeFederatedGuildId(origin, guildId), local.user);
  return { ok: true } as const;
}

// ---- looking bots up --------------------------------------------------------------------------

const remoteBotSchema = z.object({ user: federationUserSchema, public: z.boolean() });

/** The public profile of a bot anywhere, for the authorize page. */
export async function lookupBot(bot: BotRef) {
  if (ours(bot.homeserver)) {
    const local = await findLocalBot(bot.username);
    return local ? { user: publicUser(local.user), public: local.bot.public } : null;
  }

  const remote = await discoverRemoteAnchor(bot.homeserver).catch(() => null);
  if (!remote || !remoteSupports(remote, 'bots')) return null;
  const url = new URL(`/federation/bots/${encodeURIComponent(bot.username)}`, remote.baseUrl);
  if (
    !(await assertSafeFederationUrl(url).then(
      () => true,
      () => false
    ))
  )
    return null;
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(federationRequestTimeoutMs),
  }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = remoteBotSchema.safeParse(await readJson(response, 64 * 1024));
  if (
    !parsed.success ||
    !parsed.data.user.isBot ||
    parsed.data.user.username !== bot.username ||
    parsed.data.user.homeserver.toLowerCase() !== remote.homeserver.toLowerCase()
  ) {
    return null;
  }
  // remote users get a placeholder id: clients only need it to render the profile
  return {
    user: { ...parsed.data.user, userId: `${parsed.data.user.username}@${remote.homeserver}` },
    public: parsed.data.public,
  };
}

export const publicBotProfile = async (username: string) => {
  const local = await findLocalBot(username);
  return local
    ? { user: federationUserPayload({ user: local.user }), public: local.bot.public }
    : null;
};
