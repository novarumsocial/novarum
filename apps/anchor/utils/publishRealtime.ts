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
  for (const topic of await channelTopics(channel)) publishRealtime(server, topic, event);
}

export async function channelTopics(channel: { id: string; guildId: string | null }) {
  if (channel.guildId) return [`guildEvents:${channel.guildId}`];

  const members = await db.query.channelMembers.findMany({
    where: { channelId: channel.id },
  });
  return [`dmEvents:${channel.id}`, ...members.map((member) => `userEvents:${member.userId}`)];
}
