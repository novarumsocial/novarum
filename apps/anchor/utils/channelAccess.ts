import { db } from '../src/db';
import { findFriendship } from '../modules/friends/model';

type AccessibleChannel = { id: string; guildId: string | null; type: string };

// guild channels are gated by guild membership; DM (and future group DM)
// channels are gated by channel membership instead. writing to a DM also needs
// the participants to still be friends.
export async function canAccessChannel(channel: AccessibleChannel, userId: string, write = false) {
  if (channel.guildId) {
    const membership = await db.query.guildMembers.findFirst({
      where: { guildId: channel.guildId, userId },
    });
    return !!membership;
  }

  const members = await db.query.channelMembers.findMany({ where: { channelId: channel.id } });
  if (!members.some((member) => member.userId === userId)) return false;
  if (!write || channel.type !== 'DM') return true;

  const friendships = await Promise.all(
    members
      .filter((member) => member.userId !== userId)
      .map((member) => findFriendship(userId, member.userId))
  );
  return friendships.every((friendship) => friendship?.status === 'ACCEPTED');
}
