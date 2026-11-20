import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { attachments, channelMembers, db, messagePings, messages } from '../../src/db';
import { randomString } from '../../utils/randomString';
import { storage } from '../../utils/services/storage';
import type { ActionRow, Embed, MessageInteraction } from '../../utils/botSchemas';

// The database writes behind sending, editing and deleting a message. Local users and users of
// other homeservers (see modules/federation) go through the same functions, so a message
// behaves the same whoever wrote it.

type PingRecipient = { userId: string };

function insertPings(
  tx: Pick<typeof db, 'insert'>,
  messageId: string,
  recipients: PingRecipient[]
) {
  if (!recipients.length) return;
  return tx.insert(messagePings).values(recipients.map(({ userId }) => ({ messageId, userId })));
}

/** Saves a message with its pings, claims its uploaded attachments and reopens closed DMs. */
export async function createMessage(input: {
  channel: { id: string; guildId: string | null };
  authorId: string;
  content: string | null;
  replyTo: string | null;
  nonce: string;
  pingRecipients: PingRecipient[];
  attachments: {
    id: string;
    objectKey: string;
    pendingObjectKey: string;
    width: number | null;
    height: number | null;
  }[];
  embeds?: Embed[] | null;
  components?: ActionRow[] | null;
  interaction?: MessageInteraction | null;
}) {
  const created = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(messages)
      .values({
        id: randomString(),
        channelId: input.channel.id,
        authorId: input.authorId,
        content: input.content,
        replyTo: input.replyTo,
        nonce: input.nonce,
        embeds: input.embeds ?? null,
        components: input.components ?? null,
        interaction: input.interaction ?? null,
      })
      .returning();
    if (!created) throw new Error('Failed to create message');

    for (const attachment of input.attachments) {
      // only a PENDING attachment can be claimed, so two messages can't both take the same upload
      const claimed = await tx
        .update(attachments)
        .set({
          messageId: created.id,
          status: 'ATTACHED',
          objectKey: attachment.objectKey,
          width: attachment.width,
          height: attachment.height,
        })
        .where(and(eq(attachments.id, attachment.id), eq(attachments.status, 'PENDING')))
        .returning();
      if (claimed.length === 0) throw new Error('Attachment was already claimed');
    }

    await insertPings(tx, created.id, input.pingRecipients);

    // a new message reopens the DM for everyone who had closed it
    if (!input.channel.guildId) {
      await tx
        .update(channelMembers)
        .set({ closed: false })
        .where(eq(channelMembers.channelId, input.channel.id));
    }

    return created;
  });

  await Promise.all(
    input.attachments.map((attachment) =>
      storage
        .file(attachment.pendingObjectKey)
        .delete()
        .catch(() => {})
    )
  );
  return created;
}

/** Replaces the content of a message (and a bot's embeds and buttons, when given) and its pings. */
export function editMessage(
  messageId: string,
  content: string | null,
  pingRecipients: PingRecipient[],
  extras: { embeds?: Embed[]; components?: ActionRow[] } = {}
) {
  return db.transaction(async (tx) => {
    await tx.delete(messagePings).where(eq(messagePings.messageId, messageId));
    await insertPings(tx, messageId, pingRecipients);

    const [updated] = await tx
      .update(messages)
      .set({ content, ...extras })
      .where(eq(messages.id, messageId))
      .returning();
    if (!updated) throw new Error('Failed to edit message');
    return updated;
  });
}

/** Who was already pinged by a message, so an edit doesn't notify them a second time. */
export async function pingedUserIds(messageId: string) {
  const pings = await db.query.messagePings.findMany({ where: { messageId } });
  return new Set(pings.map((ping) => ping.userId));
}

/** Deletes a message and the files of its attachments. */
export async function deleteMessage(message: { id: string; attachments: { objectKey: string }[] }) {
  await db.delete(messages).where(eq(messages.id, message.id));
  // the message is already gone, so a file that can't be removed is only wasted space
  await Promise.all(
    message.attachments.map((attachment) =>
      storage
        .file(String(attachment.objectKey))
        .delete()
        .catch(() => {})
    )
  );
}

export const maxPinsPerChannel = 50;

export const pinCount = (channelId: string) =>
  db.$count(messages, and(eq(messages.channelId, channelId), isNotNull(messages.pinnedAt)));

/** Pins or unpins a message without marking it as edited. */
export async function setMessagePinned(messageId: string, pinned: boolean) {
  const [updated] = await db
    .update(messages)
    .set({ pinnedAt: pinned ? new Date() : null, updatedAt: sql`${messages.updatedAt}` })
    .where(eq(messages.id, messageId))
    .returning();
  if (!updated) throw new Error('Failed to pin message');
  return updated;
}

/** A channel's pinned messages, the most recently pinned first. */
export const pinnedMessages = (channelId: string) =>
  db.query.messages.findMany({
    where: { channelId, pinnedAt: { isNotNull: true } },
    orderBy: { pinnedAt: 'desc', id: 'desc' },
    with: { author: true, attachments: true },
    limit: maxPinsPerChannel,
  });
