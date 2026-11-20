import type { Server } from 'elysia/universal';
import { eq } from 'drizzle-orm';
import { db, messages } from '../../src/db';
import { messagePayload } from '../../utils/messagePayload';
import { publishToChannel } from '../../utils/publishRealtime';
import { voicePresenceForChannels, watchVoicePresence } from '../../utils/services/livekit';
import { isDmChannel } from '../federation/access';
import { postSystemMessage } from './groups';

// Calls in DMs and group DMs we host leave a system message: "X started a call" when the first
// person joins, which becomes the call's duration, or "Missed call" when nobody else joined,
// once the last one leaves. Calls only live in memory, so a restart mid-call leaves the message
// as it was when it started.

type Call = { messageId: string; starterId: string; startedAt: number; answered: boolean };
const calls = new Map<string, Call>();
// presence changes arrive faster than the database answers, so each channel is handled in order
const queues = new Map<string, Promise<void>>();

export function trackCalls(server: Server) {
  watchVoicePresence((channelId) => {
    const next = (queues.get(channelId) ?? Promise.resolve())
      .then(() => update(server, channelId))
      .catch((error) => console.warn('Could not log a call:', error));
    queues.set(channelId, next);
    void next.then(() => {
      if (queues.get(channelId) === next) queues.delete(channelId);
    });
  });
}

async function update(server: Server, channelId: string) {
  const callers = voicePresenceForChannels([channelId]);
  const call = calls.get(channelId);

  if (!call) {
    // guild voice channels and DMs hosted elsewhere (their host logs those) aren't ours to log
    const starter = callers[0];
    if (!starter || starter.guildId || channelId.startsWith('fed:')) return;
    const [channel, author] = await Promise.all([
      db.query.channels.findFirst({ where: { id: channelId } }),
      db.query.users.findFirst({ where: { id: starter.userId } }),
    ]);
    if (!channel || !author || !isDmChannel(channel)) return;
    const message = await postSystemMessage(server, channel, author, {
      type: 'call',
      durationSeconds: null,
      missed: false,
    });
    calls.set(channelId, {
      messageId: message.id,
      starterId: author.id,
      startedAt: Date.now(),
      answered: callers.some((caller) => caller.userId !== author.id),
    });
    return;
  }

  if (callers.length) {
    call.answered ||= callers.some((caller) => caller.userId !== call.starterId);
    return;
  }

  calls.delete(channelId);
  const durationSeconds = Math.round((Date.now() - call.startedAt) / 1000);
  const existing = await db.query.messages.findFirst({
    where: { id: call.messageId },
    with: { author: true, attachments: true, channel: true },
  });
  if (!existing) return;
  // keeps updatedAt at createdAt, so the message doesn't show as edited
  const [updated] = await db
    .update(messages)
    .set({
      system: { type: 'call', durationSeconds, missed: !call.answered },
      updatedAt: existing.createdAt,
    })
    .where(eq(messages.id, existing.id))
    .returning();
  if (!updated) return;
  await publishToChannel(server, existing.channel, {
    type: 'message.updated',
    data: messagePayload({ ...updated, attachments: [] }, existing.channel, existing.author),
  });
}
