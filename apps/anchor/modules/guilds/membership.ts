import type { Server } from 'elysia/universal';
import { and, eq, inArray } from 'drizzle-orm';
import {
  channelReadStates,
  db,
  guildBans,
  guildMembers,
  guilds,
  notificationSettings,
  users,
} from '../../src/db';
import { getConfig } from '../../utils/config';
import { postSignedFederationJson } from '../../utils/discovery';
import { parseFederatedGuildId } from '../../utils/federationIds';
import { federationUserPayload } from '../../utils/federationPayload';
import { publicUser } from '../../utils/publicUser';
import { publishRealtime } from '../../utils/publishRealtime';
import { stopFollowingGuild } from '../federation/routes/realtime';
import { unsubscribeUserFromGuild } from '../realtime/services';

// Leaving guilds, kicking and banning people out of them.

type User = typeof users.$inferSelect;
type Guild = { id: string; ownerId: string };
type Failure = { ok: false; status: 400 | 403 | 404; error: string };
export type RemovalReason = 'kicked' | 'banned';

const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });
const ours = (homeserver: string) =>
  homeserver.toLowerCase() === getConfig().server.homeserver.toLowerCase();

export const isBanned = async (guildId: string, userId: string) =>
  !!(await db.query.guildBans.findFirst({ where: { guildId, userId } }));

/**
 * Deletes a membership with what only existed for it (read states, notification settings, voice,
 * subscriptions), and tells the guild that the member left and the member that the guild is gone.
 */
export async function removeMember(
  server: Server | null,
  guildId: string,
  user: User,
  reason?: RemovalReason
) {
  const channelIds = (
    await db.query.channels.findMany({ where: { guildId }, columns: { id: true } })
  ).map((channel) => channel.id);
  await db.transaction(async (tx) => {
    await tx
      .delete(guildMembers)
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, user.id)));
    await tx
      .delete(notificationSettings)
      .where(
        and(
          eq(notificationSettings.userId, user.id),
          inArray(notificationSettings.targetId, [guildId, ...channelIds])
        )
      );
    if (channelIds.length) {
      await tx
        .delete(channelReadStates)
        .where(
          and(
            eq(channelReadStates.userId, user.id),
            inArray(channelReadStates.channelId, channelIds)
          )
        );
    }
  });
  await unsubscribeUserFromGuild(server, user, guildId, channelIds);

  // our copy of a guild hosted elsewhere goes once none of our users is in it anymore
  const federated = parseFederatedGuildId(guildId);
  if (federated && !(await db.query.guildMembers.findFirst({ where: { guildId } }))) {
    await db.delete(guilds).where(eq(guilds.id, guildId));
  }

  if (!server) return;
  if (!federated) {
    publishRealtime(server, `guildEvents:${guildId}`, {
      type: 'member.left',
      data: { guildId, userId: user.id },
    });
  }
  publishRealtime(server, `userEvents:${user.id}`, {
    type: 'guild.deleted',
    data: { guildId, ...(reason && { reason }) },
  });
}

/**
 * On the guild's host: takes `user` out of one of our guilds. A remote user's homeserver is told
 * (unless it asked for it), and stops getting the guild's events once none of its users is left.
 */
export async function hostRemoveMember(
  server: Server | null,
  guildId: string,
  user: User,
  reason?: RemovalReason,
  tellHomeserver = true
) {
  await removeMember(server, guildId, user, reason);
  if (ours(user.homeserver)) return;

  if (tellHomeserver) {
    // it drops its copy of the guild; it can't refuse, so don't wait on it
    const username = encodeURIComponent(user.username);
    void postSignedFederationJson(
      user.homeserver,
      user.isBot ? `/federation/bots/${username}/leave` : `/federation/members/${username}/removed`,
      { guildId, reason }
    ).catch(() => null);
  }
  await stopFollowingGuild(user.homeserver, guildId);
}

/** One of our users leaves a guild, wherever it is hosted. */
export async function leaveGuild(server: Server | null, user: User, guildId: string) {
  const membership = await db.query.guildMembers.findFirst({
    where: { guildId, userId: user.id },
    with: { guild: true },
  });
  if (!membership) return fail(404, 'Guild not found');

  const federated = parseFederatedGuildId(guildId);
  if (!federated) {
    if (membership.guild.ownerId === user.id) {
      return fail(400, "The owner can't leave the guild");
    }
    await hostRemoveMember(server, guildId, user);
    return { ok: true } as const;
  }

  // best effort: we drop the guild either way, and the host won't send us its events anymore
  const id = encodeURIComponent(federated.id);
  await postSignedFederationJson(
    federated.homeserver,
    user.isBot ? `/federation/guilds/${id}/bots/leave` : `/federation/guilds/${id}/leave`,
    { user: federationUserPayload({ user }) }
  ).catch(() => null);
  await removeMember(server, guildId, user);
  return { ok: true } as const;
}

/**
 * Whether `actorId` may moderate `guild`: the owner can, and so can admins. With `targetId`, also
 * whether they may remove that user: nobody removes the owner or themselves, admins no other admin.
 */
async function checkModerator(guild: Guild, actorId: string, targetId?: string) {
  const [actor, target] = await Promise.all([
    db.query.guildMembers.findFirst({ where: { guildId: guild.id, userId: actorId } }),
    targetId
      ? db.query.guildMembers.findFirst({
          where: { guildId: guild.id, userId: targetId },
          with: { user: true },
        })
      : undefined,
  ]);
  const isOwner = guild.ownerId === actorId;
  if (!actor) return fail(404, 'Guild not found');
  if (!isOwner && actor.role !== 'ADMIN') return fail(403, 'Forbidden');
  if (targetId === actorId) return fail(400, "You can't remove yourself, leave the guild instead");
  if (targetId === guild.ownerId) return fail(403, "The guild owner can't be removed");
  if (!isOwner && target?.role === 'ADMIN') return fail(403, "Admins can't remove other admins");
  return { ok: true as const, target };
}

const hostedGuild = async (guildId: string) =>
  parseFederatedGuildId(guildId)
    ? fail(400, 'Cannot manage a federated guild')
    : ((await db.query.guilds.findFirst({ where: { id: guildId } })) ??
      fail(404, 'Guild not found'));

export async function kickMember(
  server: Server | null,
  guildId: string,
  actorId: string,
  targetId: string
) {
  const guild = await hostedGuild(guildId);
  if ('ok' in guild) return guild;
  const check = await checkModerator(guild, actorId, targetId);
  if (!check.ok) return check;
  if (!check.target) return fail(404, 'Member not found');

  await hostRemoveMember(server, guild.id, check.target.user, 'kicked');
  return { ok: true } as const;
}

/** Bans a member, or someone who already left, so they can't join again until unbanned. */
export async function banMember(
  server: Server | null,
  guildId: string,
  actorId: string,
  targetId: string,
  reason: string | null
) {
  const guild = await hostedGuild(guildId);
  if ('ok' in guild) return guild;
  const check = await checkModerator(guild, actorId, targetId);
  if (!check.ok) return check;
  const user = check.target?.user ?? (await db.query.users.findFirst({ where: { id: targetId } }));
  if (!user) return fail(404, 'User not found');

  const ban = { reason, bannedById: actorId, createdAt: new Date() };
  await db
    .insert(guildBans)
    .values({ guildId: guild.id, userId: user.id, ...ban })
    .onConflictDoUpdate({ target: [guildBans.guildId, guildBans.userId], set: ban });
  if (check.target) await hostRemoveMember(server, guild.id, user, 'banned');
  return { ok: true } as const;
}

export async function unbanMember(guildId: string, actorId: string, targetId: string) {
  const guild = await hostedGuild(guildId);
  if ('ok' in guild) return guild;
  const check = await checkModerator(guild, actorId);
  if (!check.ok) return check;

  const [ban] = await db
    .delete(guildBans)
    .where(and(eq(guildBans.guildId, guild.id), eq(guildBans.userId, targetId)))
    .returning();
  if (!ban) return fail(404, 'Ban not found');
  return { ok: true } as const;
}

export async function listBans(guildId: string, actorId: string) {
  const guild = await hostedGuild(guildId);
  if ('ok' in guild) return guild;
  const check = await checkModerator(guild, actorId);
  if (!check.ok) return check;

  const bans = await db.query.guildBans.findMany({
    where: { guildId: guild.id },
    with: { user: true, bannedBy: true },
    orderBy: { createdAt: 'desc' },
  });
  return {
    ok: true as const,
    bans: bans.map((ban) => ({
      user: publicUser(ban.user),
      reason: ban.reason,
      bannedBy: ban.bannedBy ? publicUser(ban.bannedBy) : null,
      createdAt: ban.createdAt.toISOString(),
    })),
  };
}
