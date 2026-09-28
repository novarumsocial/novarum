import { db } from '../src/db';

type AccessibleChannel = { id: string; guildId: string | null };

// guild channels are gated by guild membership; DM (and future group DM)
// channels are gated by channel membership instead.
export async function canAccessChannel(channel: AccessibleChannel, userId: string) {
  if (channel.guildId) {
    const membership = await db.query.guildMembers.findFirst({
      where: { guildId: channel.guildId, userId },
    });
    return !!membership;
  }

  const membership = await db.query.channelMembers.findFirst({
    where: { channelId: channel.id, userId },
  });
  return !!membership;
}
