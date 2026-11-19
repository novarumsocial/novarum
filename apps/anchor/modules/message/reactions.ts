import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { db, messageReactions, messages } from '../../src/db';
import {
  maxListedReactors,
  maxReactionsPerMessage,
  type messageReactionSchema,
} from '../../src/db/zod';
import type { z } from 'zod';
import { publicUser } from '../../utils/publicUser';
import { publishToChannel } from '../../utils/publishRealtime';

type Publisher = Parameters<typeof publishToChannel>[0];
type Reaction = z.infer<typeof messageReactionSchema>;

/** The reactions of each message, as `viewerId` sees them, in two queries however many messages. */
export async function reactionsFor(messageIds: string[], viewerId: string) {
  if (!messageIds.length) return new Map<string, Reaction[]>();

  const groups = await db
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      count: sql<number>`count(*)::int`,
      me: sql<boolean>`bool_or(${messageReactions.userId} = ${viewerId})`,
      userIds: sql<
        string[]
      >`(array_agg(${messageReactions.userId} order by ${messageReactions.createdAt}))[1:${sql.raw(String(maxListedReactors))}]`,
    })
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .groupBy(messageReactions.messageId, messageReactions.emoji)
    .orderBy(sql`min(${messageReactions.createdAt})`, messageReactions.emoji);

  const users = await db.query.users.findMany({
    where: { id: { in: [...new Set(groups.flatMap((group) => group.userIds))] } },
  });
  const usersById = new Map(users.map((user) => [user.id, publicUser(user)]));

  const byMessage = new Map<string, Reaction[]>();
  for (const { messageId, userIds, ...group } of groups) {
    const reactions = byMessage.get(messageId) ?? [];
    reactions.push({ ...group, users: userIds.flatMap((id) => usersById.get(id) ?? []) });
    byMessage.set(messageId, reactions);
  }
  return byMessage;
}

/**
 * Adds or removes `user`'s reaction on a message of `channel`. Doing it twice changes nothing, and
 * only a change is announced to the channel.
 */
export async function setReaction(input: {
  channel: { id: string; guildId: string | null };
  messageId: string;
  user: Parameters<typeof publicUser>[0];
  emoji: string;
  add: boolean;
  server?: Publisher | null;
}) {
  const { channel, messageId, user, emoji, add } = input;
  const result = await db.transaction(async (tx) => {
    // locking the message keeps two people from both adding the last emoji the message can take
    const [message] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channel.id)))
      .for('update');
    if (!message) return { ok: false as const, status: 404 as const, error: 'Message not found' };

    const thisEmoji = and(
      eq(messageReactions.messageId, messageId),
      eq(messageReactions.emoji, emoji)
    );
    if (add) {
      const emojis = await tx
        .selectDistinct({ emoji: messageReactions.emoji })
        .from(messageReactions)
        .where(eq(messageReactions.messageId, messageId));
      if (
        emojis.length >= maxReactionsPerMessage &&
        !emojis.some((reaction) => reaction.emoji === emoji)
      ) {
        return { ok: false as const, status: 400 as const, error: 'Too many reactions' };
      }
    }
    const changed = add
      ? await tx
          .insert(messageReactions)
          .values({ messageId, userId: user.id, emoji })
          .onConflictDoNothing()
          .returning()
      : await tx
          .delete(messageReactions)
          .where(and(thisEmoji, eq(messageReactions.userId, user.id)))
          .returning();
    const [left] = await tx.select({ count: count() }).from(messageReactions).where(thisEmoji);
    return { ok: true as const, changed: changed.length > 0, count: left?.count ?? 0 };
  });
  if (!result.ok) return result;

  if (result.changed && input.server) {
    await publishToChannel(input.server, channel, {
      type: add ? 'message.reaction.added' : 'message.reaction.removed',
      data: {
        messageId,
        channelId: channel.id,
        guildId: channel.guildId,
        emoji,
        count: result.count,
        user: publicUser(user),
      },
    });
  }

  const reactions = await reactionsFor([messageId], user.id);
  return { ok: true as const, reactions: reactions.get(messageId) ?? [] };
}
