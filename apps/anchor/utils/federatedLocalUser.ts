import { db } from '../src/db';
import { getConfig } from './config';
import { userProfile } from './publicUser';

type Scope = { guildId: string | null; channelId: string };
type Identity = { username: string; homeserver: string };

// A host relays what our own users do in its guilds and DMs, but it must not be able to speak for
// a local user who isn't there, nor choose their profile. Returns the identity unchanged when it
// isn't ours, with our own profile when it is a local member, and null when it must be dropped.
export async function vetLocalIdentity<T extends Identity>(scope: Scope, identity: T) {
  const homeserver = getConfig().server.homeserver;
  if (identity.homeserver.toLowerCase() !== homeserver.toLowerCase()) return identity;

  const user = await db.query.users.findFirst({
    where: { username: identity.username, homeserver },
  });
  if (!user) return null;
  const member = scope.guildId
    ? await db.query.guildMembers.findFirst({ where: { guildId: scope.guildId, userId: user.id } })
    : await db.query.channelMembers.findFirst({
        where: { channelId: scope.channelId, userId: user.id },
      });
  return member ? { ...identity, ...userProfile(user) } : null;
}

// hosts know our users by their own ids, so one of our ids in a relayed event is forged
export async function localUserIds(ids: string[]) {
  if (!ids.length) return new Set<string>();
  const users = await db.query.users.findMany({
    where: { id: { in: ids }, homeserver: getConfig().server.homeserver },
    columns: { id: true },
  });
  return new Set(users.map((user) => user.id));
}
