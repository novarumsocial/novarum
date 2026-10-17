import { z } from 'zod';
import { db } from '../src/db';
import { callRemote, passThrough } from './federationClient';
import { parseFederatedGuildId } from './federationIds';
import { publicUser, userProfileSchema } from './publicUser';
import { publishRealtime } from './publishRealtime';
import type { RealtimeEvent } from './types';

// what a member can set per guild; null (or empty) falls back to their own profile
export const guildProfileSchema = userProfileSchema.pick({
  displayName: true,
  avatarUrl: true,
  bannerUrl: true,
  about: true,
});
export type GuildProfile = z.infer<typeof guildProfileSchema>;

type ProfileUser = Parameters<typeof publicUser>[0];

export function withGuildProfile<User extends ProfileUser>(
  user: User,
  profile?: Partial<GuildProfile> | null
): User {
  return {
    ...user,
    displayName: profile?.displayName || user.displayName,
    avatarUrl: profile?.avatarUrl || user.avatarUrl,
    bannerUrl: profile?.bannerUrl || user.bannerUrl,
    about: profile?.about || user.about,
  };
}

// the user as they look in a guild (or as themselves, outside of one)
export async function guildUser<User extends ProfileUser>(guildId: string | null, user: User) {
  const member = guildId
    ? await db.query.guildMembers.findFirst({ where: { guildId, userId: user.id } })
    : null;
  return withGuildProfile(user, member);
}

// guild profiles of many users at once, by user id
export async function guildProfiles(guildId: string | null, userIds: string[]) {
  const members = guildId
    ? await db.query.guildMembers.findMany({ where: { guildId, userId: { in: userIds } } })
    : [];
  return new Map(members.map((member) => [member.userId, member]));
}

export function memberUpdated(
  guildId: string,
  user: ProfileUser,
  profile: GuildProfile
): RealtimeEvent {
  return {
    type: 'member.updated',
    data: { guildId, user: publicUser(withGuildProfile(user, profile)) },
  };
}

// tells the guild how the user looks there now. A remote guild's host serves its members to
// everyone, so it gets the profile and tells its members itself.
export async function shareGuildProfile(
  server: Parameters<typeof publishRealtime>[0] | null,
  user: ProfileUser,
  guildId: string,
  profile: GuildProfile
) {
  const remote = parseFederatedGuildId(guildId);
  if (remote) {
    return callRemote(
      remote.homeserver,
      `/federation/guilds/${encodeURIComponent(remote.id)}/profile`,
      { user },
      { profile },
      {
        response: z.unknown(),
        forward: passThrough(400, 403, 404),
        errors: {
          failed: 'Remote server profile update failed',
          invalid: 'Remote server profile update failed',
        },
      }
    );
  }

  if (server)
    publishRealtime(server, `guildEvents:${guildId}`, memberUpdated(guildId, user, profile));
  return { ok: true as const };
}
