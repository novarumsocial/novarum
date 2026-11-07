import { db } from '../src/db';

// The guild owner and ADMIN members (today only bots added as ADMIN) manage channels and can post
// in owner-only channels.
export async function canManageGuild(guild: { id: string; ownerId: string }, userId: string) {
  if (guild.ownerId === userId) return true;
  const member = await db.query.guildMembers.findFirst({ where: { guildId: guild.id, userId } });
  return member?.role === 'ADMIN';
}

/** Who may add (or remove) a bot with `role`: managers add MEMBER bots, only the owner ADMIN ones. */
export async function canAddBot(
  guild: { id: string; ownerId: string },
  userId: string,
  role: 'ADMIN' | 'MEMBER'
) {
  return role === 'ADMIN' ? guild.ownerId === userId : canManageGuild(guild, userId);
}
