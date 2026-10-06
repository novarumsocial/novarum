import type { RealtimeEvent } from './types';
import { db } from '../src/db';
import { sharedEventFrame, sharedSocketTopic } from './federationSharedSocket';

// whatever can publish to a topic: the server, or one of its sockets (which skips that socket)
type Publisher = { publish(topic: string, data: string): unknown };

const guildOrDmTopic = /^(guildEvents|dmEvents):(.+)$/;

export function publishRealtime(target: Publisher, topic: string, event: RealtimeEvent) {
  const message = JSON.stringify(event);
  target.publish(topic, message);

  // Other homeservers can follow guilds and DMs of ours through one shared socket, which needs
  // to know what each event belongs to, so they get a copy with that wrapped around it.
  // Remote (`fed:`) ids are not ours to share, so nobody can follow them.
  const [, topicName, id] = topic.match(guildOrDmTopic) ?? [];
  if (id && !id.startsWith('fed:')) {
    const kind = topicName === 'guildEvents' ? 'guild' : 'dm';
    target.publish(sharedSocketTopic(kind, id), sharedEventFrame(kind, id, message));
  }
}

// guild channels fan out to every guild member's shared topic; DM (and future
// group DM) channels have no shared topic, so we publish straight to each
// member's personal `userEvents:` topic instead. `dmEvents:` is also published
// so a federation bridge for this DM can relay the event to the other homeserver.
export async function publishToChannel(
  target: Publisher,
  channel: { id: string; guildId: string | null },
  event: RealtimeEvent
) {
  for (const topic of await channelTopics(channel)) publishRealtime(target, topic, event);
}

export async function channelTopics(channel: { id: string; guildId: string | null }) {
  if (channel.guildId) return [`guildEvents:${channel.guildId}`];

  const members = await db.query.channelMembers.findMany({
    where: { channelId: channel.id },
  });
  return [`dmEvents:${channel.id}`, ...members.map((member) => `userEvents:${member.userId}`)];
}
