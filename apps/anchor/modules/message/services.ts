import Elysia, { t } from 'elysia';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { randomString } from '../../utils/randomString';
import { publishRealtime } from '../../utils/publishRealtime';
import { parseFederatedChannelId } from '../../utils/federationIds';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload } from '../../utils/federationPayload';
import { attachmentPayload, maxAttachmentCount } from '../../utils/attachments';
import { storage } from '../../utils/services/storage';
import { mentionHandles } from '../../utils/mentions';
import { db, messages, attachments as dbAttachment, messagePings } from '../../src/db';
import { and, eq } from 'drizzle-orm';

export const message = new Elysia({ prefix: '/message' })
  .resolve(async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      return status(401, { error: 'Unauthorized' });
    }
    return { session };
  })
  .get(
    '/list',
    async ({ query, session, status }) => {
      const { channelId } = query;

      const channel = await db.query.channels.findFirst({
        where: { id: channelId },
      });
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      const membership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
      if (!membership) {
        return status(403, { error: 'Forbidden' });
      }

      const federatedChannel = parseFederatedChannelId(channelId);
      if (federatedChannel) {
        const result = await postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/messages`,
          { user: federationUserPayload(session) }
        ).catch(() => null);

        if (!result) return status(502, { error: 'Could not reach remote homeserver' });
        if (!result.response.ok) {
          return status(result.response.status, result.data ?? { error: 'Remote messages failed' });
        }
        if (
          !result.data ||
          typeof result.data !== 'object' ||
          !Array.isArray((result.data as any).messages)
        ) {
          return status(502, { error: 'Remote messages returned an invalid response' });
        }

        return {
          messages: (result.data as any).messages.map((message: any) =>
            mapFederatedMessage(message, channel.id, channel.guildId)
          ),
        };
      }

      const messages = await db.query.messages.findMany({
        where: { channelId },
        orderBy: { createdAt: 'asc' },
        with: {
          author: true,
          attachments: true,
        },
      });

      return {
        messages: messages.map((message) => ({
          id: message.id,
          channelId: message.channelId,
          guildId: channel.guildId,
          content: message.content,
          nonce: message.nonce,
          replyTo: message.replyTo ?? null,
          attachments: message.attachments.map((attachment) =>
            attachmentPayload(attachment as Parameters<typeof attachmentPayload>[0])
          ),
          createdAt:
            message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
          author: {
            id: message.authorId,
            username: message.author.displayName || message.author.username,
            avatar: message.author.avatarUrl ?? null,
          },
        })),
      };
    },
    {
      query: t.Object({
        channelId: t.String(),
      }),
    }
  )
  .post(
    '/send',
    async ({ body, session, status, server }) => {
      const { channelId, content, nonce, replyTo, attachmentIds = [] } = body;

      const channel = await db.query.channels.findFirst({
        where: { id: channelId },
      });
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      const membership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
      if (!membership) {
        return status(403, { error: 'Forbidden' });
      }

      const federatedChannel = parseFederatedChannelId(channelId);
      if (federatedChannel) {
        const result = await postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/messages/send`,
          {
            user: federationUserPayload(session),
            content,
            nonce,
            replyTo,
            attachmentIds,
          }
        ).catch(() => null);

        if (!result) return status(502, { error: 'Could not reach remote homeserver' });
        if (!result.response.ok) {
          return status(result.response.status, result.data ?? { error: 'Remote send failed' });
        }

        const message =
          result.data && typeof result.data === 'object' ? (result.data as any).message : null;
        if (!message || typeof message !== 'object') {
          return status(502, { error: 'Remote send returned an invalid response' });
        }

        const mappedMessage = mapFederatedMessage(message, channel.id, channel.guildId);
        if (server) {
          publishRealtime(server, `guildEvents:${channel.guildId}`, {
            type: 'message.created',
            data: mappedMessage,
          });
        }

        return { message: mappedMessage };
      }

      const priorMsg = await db.query.messages.findFirst({
        where: {
          authorId: session.userId,
          nonce,
        },
        with: {
          attachments: true,
        },
      });
      if (priorMsg) {
        if (
          priorMsg.channelId !== channelId ||
          priorMsg.content !== content ||
          priorMsg.replyTo !== (replyTo ?? null)
        ) {
          return status(409, { error: 'Nonce already used for a different message' });
        }

        return {
          message: {
            ...priorMsg,
            attachments: priorMsg.attachments.map((attachment) =>
              attachmentPayload(attachment as Parameters<typeof attachmentPayload>[0])
            ),
          },
        };
      }

      const replyTarget = replyTo
        ? await db.query.messages.findFirst({ where: { id: replyTo, channelId } })
        : null;
      if (replyTo && !replyTarget) {
        return status(400, { error: 'Invalid reply target' });
      }

      const pingRecipients = await getPingRecipients(
        channel.guildId,
        content,
        replyTarget?.authorId,
        session.userId
      );

      const attachments = await verifyPendingAttachments(attachmentIds, session.userId, channelId);
      if (!attachments.ok) return status(400, { error: attachments.error });

      const message = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(messages)
          .values({
            id: randomString(),
            channelId,
            authorId: session.userId,
            content,
            replyTo: replyTo ?? null,
            nonce,
          })
          .returning();
        if (!created) throw new Error('message creation shit the bed');

        for (const attachment of attachments.value) {
          const updated = await tx
            .update(dbAttachment)
            .set({
              messageId: created.id,
              status: 'ATTACHED',
            })
            .where(and(eq(dbAttachment.id, attachment.id), eq(dbAttachment.status, 'PENDING')));
          if (!updated) throw new Error('Attachment was already claimed');
        }

        for (const recipient of pingRecipients) {
          await tx.insert(messagePings).values({
            messageId: created.id,
            userId: recipient.userId,
          });
        }

        return created;
      });
      const responseAttachments = attachments.value.map(attachmentPayload);

      if (server) {
        publishRealtime(server, `guildEvents:${channel.guildId}`, {
          type: 'message.created',
          data: {
            id: message.id,
            channelId: message.channelId,
            guildId: channel.guildId,
            content: message.content,
            nonce: message.nonce,
            replyTo: message.replyTo ?? null,
            pingedHandles: pingRecipients.map((recipient) => recipient.handle),
            attachments: responseAttachments,
            createdAt:
              message.createdAt instanceof Date
                ? message.createdAt.toISOString()
                : message.createdAt,
            author: {
              id: session.userId,
              username: session.user.displayName || session.user.username,
              avatar: session.user.avatarUrl ?? null,
            },
          },
        });
      }

      return {
        message: {
          ...message,
          pingedHandles: pingRecipients.map((recipient) => recipient.handle),
          attachments: responseAttachments,
        },
      };
    },
    {
      body: t.Object({
        channelId: t.String(),
        content: t.String(),
        nonce: t.String(),
        replyTo: t.Optional(t.String()),
        attachmentIds: t.Optional(
          t.Array(t.String(), { maxItems: maxAttachmentCount, uniqueItems: true })
        ),
      }),
    }
  )
  .post(
    '/delete',
    async ({ body, session, status, server }) => {
      const { channelId, messageId } = body;
      const channel = await db.query.channels.findFirst({
        where: { id: channelId },
      });
      if (!channel) return status(404, { error: 'Channel not found' });

      const membership = await db.query.guildMembers.findFirst({
        where: {
          guildId: channel.guildId,
          userId: session.userId,
        },
      });
      if (!membership) return status(403, { error: 'Forbidden' });

      const federatedChannel = parseFederatedChannelId(channelId);
      if (federatedChannel) {
        const result = await postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/messages/delete`,
          { user: federationUserPayload(session), messageId }
        ).catch(() => null);

        if (!result) return status(502, { error: 'Could not reach remote homeserver' });
        if (!result.response.ok) {
          return status(result.response.status, result.data ?? { error: 'Remote delete failed' });
        }

        return { success: true };
      }

      const existing = await db.query.messages.findFirst({
        where: { id: messageId, channelId },
        with: { attachments: true },
      });
      if (!existing) return status(404, { error: 'Message not found' });
      if (existing.authorId !== session.userId) return status(403, { error: 'Forbidden' });

      await db.delete(messages).where(eq(messages.id, messageId));
      await Promise.all(
        existing.attachments.map((attachment) =>
          storage
            .file(String(attachment.objectKey))
            .delete()
            .catch(() => {})
        )
      );

      if (server) {
        publishRealtime(server, `guildEvents:${channel.guildId}`, {
          type: 'message.deleted',
          data: { id: messageId, channelId, guildId: channel.guildId },
        });
      }

      return { success: true };
    },
    {
      body: t.Object({
        channelId: t.String(),
        messageId: t.String(),
      }),
    }
  );

function mapFederatedMessage(message: any, channelId: string, guildId: string) {
  return {
    ...message,
    channelId,
    guildId,
  };
}

export async function verifyPendingAttachments(
  attachmentIds: string[],
  uploaderId: string,
  channelId: string
) {
  const attachments = [];

  for (const id of attachmentIds) {
    const attachment = await db.query.attachments.findFirst({
      where: {
        id,
        uploaderId,
        channelId,
        status: 'PENDING',
      },
    });
    if (!attachment) return { ok: false as const, error: 'Invalid attachment' };

    try {
      const metadata = await storage.file(attachment.objectKey).stat();
      if (metadata.size !== attachment.size) {
        await storage
          .file(attachment.objectKey)
          .delete()
          .catch(() => {});
        return { ok: false as const, error: `${attachment.filename} has an invalid size` };
      }
    } catch {
      return {
        ok: false as const,
        error: `${attachment.filename} has not finished uploading`,
      };
    }

    attachments.push(attachment);
  }

  return { ok: true as const, value: attachments };
}

export async function getPingRecipients(
  guildId: string,
  content: string,
  replyAuthorId: string | undefined,
  authorId: string
) {
  const mentionedHandles = mentionHandles(content);
  if (!mentionedHandles.size && !replyAuthorId) return [];

  const members = await db.query.guildMembers.findMany({
    where: { guildId },
    with: { user: true },
  });
  return members.flatMap((member) => {
    const handle = `@${member.user.username}:${member.user.homeserver}`;
    return member.userId !== authorId &&
      (member.userId === replyAuthorId || mentionedHandles.has(handle.toLowerCase()))
      ? [{ userId: member.userId, handle }]
      : [];
  });
}
