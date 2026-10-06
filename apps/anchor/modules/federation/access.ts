import { eq } from 'drizzle-orm';
import { db, users } from '../../src/db';
import { canAccessChannel } from '../../utils/channelAccess';
import type { FederationUserPayload } from '../../utils/federationPayload';
import { userProfile } from '../../utils/publicUser';

const forbidden = { ok: false as const, status: 403 as const, error: 'Forbidden' };

// finds the local row of a remote user. We never create users from these routes: they must already
// be known here (they joined through an invite or a friendship).
function findRemoteUser(remoteUser: FederationUserPayload) {
  return db.query.users.findFirst({
    where: { username: remoteUser.username, homeserver: remoteUser.homeserver.toLowerCase() },
  });
}

// the remote sends its user's current profile with every request, so we keep our copy fresh.
// Most requests carry nothing new, so we only write when something actually changed.
async function refreshProfile(user: typeof users.$inferSelect, remoteUser: FederationUserPayload) {
  const profile = userProfile(remoteUser);
  const changed = Object.entries(profile).some(
    ([key, value]) => user[key as keyof typeof profile] !== value
  );
  if (changed) {
    await db
      .update(users)
      .set({ ...profile, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }
  return { ...user, ...profile };
}

/** A remote user asking to read (or, with `write`, to write to) a channel on this homeserver. */
export async function getFederatedChannelAccess(
  channelId: string,
  remoteUser: FederationUserPayload,
  write = false
) {
  const [channel, user] = await Promise.all([
    db.query.channels.findFirst({ where: { id: channelId } }),
    findRemoteUser(remoteUser),
  ]);
  if (!channel) return { ok: false as const, status: 404 as const, error: 'Channel not found' };
  if (!user) return forbidden;

  const freshUser = await refreshProfile(user, remoteUser);
  if (!(await canAccessChannel(channel, user.id, write))) return forbidden;

  return { ok: true as const, channel, user: freshUser };
}

/** A remote user acting inside one of our guilds; they have to be a member of it. */
export async function getFederatedGuildAccess(guildId: string, remoteUser: FederationUserPayload) {
  const [guild, user] = await Promise.all([
    db.query.guilds.findFirst({ where: { id: guildId } }),
    findRemoteUser(remoteUser),
  ]);
  if (!guild) return { ok: false as const, status: 404 as const, error: 'Guild not found' };
  if (!user) return forbidden;

  const membership = await db.query.guildMembers.findFirst({
    where: { guildId, userId: user.id },
  });
  if (!membership) return forbidden;

  return { ok: true as const, guild, user };
}

/** Voice and ringing only make sense in voice channels and DMs. */
export const isCallChannel = (channel: { type: string }) =>
  channel.type === 'VOICE' || channel.type === 'DM';
