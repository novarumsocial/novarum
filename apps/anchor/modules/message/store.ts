import { and, eq } from 'drizzle-orm';
import { attachments, channelMembers, db, messagePings, messages } from '../../src/db';
import { randomString } from '../../utils/randomString';
import { storage } from '../../utils/services/storage';

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
export function createMessage(input: {
  channel: { id: string; guildId: string | null };
  authorId: string;
  content: string | null;
  replyTo: string | null;
  nonce: string;
  pingRecipients: PingRecipient[];
  attachments: { id: string }[];
}) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(messages)
      .values({
        id: randomString(),
        channelId: input.channel.id,
        authorId: input.authorId,
        content: input.content,
        replyTo: input.replyTo,
        nonce: input.nonce,
      })
      .returning();
    if (!created) throw new Error('Failed to create message');

    for (const attachment of input.attachments) {
      // only a PENDING attachment can be claimed, so two messages can't both take the same upload
      const claimed = await tx
        .update(attachments)
        .set({ messageId: created.id, status: 'ATTACHED' })
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
}

/** Replaces the content of a message and the pings that came with it. */
export function editMessage(
  messageId: string,
  content: string | null,
  pingRecipients: PingRecipient[]
) {
  return db.transaction(async (tx) => {
    await tx.delete(messagePings).where(eq(messagePings.messageId, messageId));
    await insertPings(tx, messageId, pingRecipients);

    const [updated] = await tx
      .update(messages)
      .set({ content })
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
