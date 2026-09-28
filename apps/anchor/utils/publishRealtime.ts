import type { Server } from 'elysia/universal';
import type { RealtimeEvent } from './types';
import { db } from '../src/db';

export function publishRealtime(server: Server, topic: string, event: RealtimeEvent) {
  server.publish(topic, JSON.stringify(event));
}

// guild channels fan out to every guild member's shared topic; DM (and future
// group DM) channels have no shared topic, so we publish straight to each
// member's personal `userEvents:` topic instead. `dmEvents:` is also published
// so a federation bridge for this DM can relay the event to the other homeserver.
export async function publishToChannel(
  server: Server,
  channel: { id: string; guildId: string | null },
  event: RealtimeEvent
) {
  if (channel.guildId) {
    publishRealtime(server, `guildEvents:${channel.guildId}`, event);
    return;
  }

  publishRealtime(server, `dmEvents:${channel.id}`, event);

  const members = await db.query.channelMembers.findMany({
    where: { channelId: channel.id },
  });
  for (const member of members) {
    publishRealtime(server, `userEvents:${member.userId}`, event);
  }
}
