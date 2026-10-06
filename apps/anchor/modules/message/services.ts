import Elysia, { t } from 'elysia';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { publishToChannel } from '../../utils/publishRealtime';
import { parseFederatedChannelId } from '../../utils/federationIds';
import { callRemote, federationChannelPath, passThrough } from '../../utils/federationClient';
import { attachmentPayload, maxAttachmentCount } from '../../utils/attachments';
import { storage } from '../../utils/services/storage';
import { mentionHandles } from '../../utils/mentions';
import { canAccessChannel } from '../../utils/channelAccess';
import { dmRecipients, notifyInBackground } from '../../utils/notify';
import { db } from '../../src/db';
import { createMessage, deleteMessage, editMessage, pingedUserIds } from './store';
import { publicUser, publicUserSchema } from '../../utils/publicUser';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { z } from 'zod';
import { attachmentResponseSchema, messageResponseBaseSchema } from '../../src/db/zod';

const messageSchema = messageResponseBaseSchema.extend({
  guildId: z.string().nullable(),
  pingedHandles: z.array(z.string()).optional(),
  attachments: z.array(attachmentResponseSchema),
  author: publicUserSchema,
});
const messageListResponseSchema = z.object({ messages: z.array(messageSchema) });
const federatedMessageListResponseSchema = messageListResponseSchema.extend({
  nextCursor: z.string().nullable(),
});
const messageResponseSchema = z.object({ message: messageSchema });
const successResponseSchema = z.object({ success: z.boolean() });

export const message = new Elysia({ prefix: '/message', tags: ['Message'] })
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
      const { channelId, amount, cursor } = query;

      const channel = await db.query.channels.findFirst({
        where: { id: channelId },
      });
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      if (!(await canAccessChannel(channel, session.userId))) {
        return status(403, { error: 'Forbidden' });
      }

      const federatedChannel = parseFederatedChannelId(channelId);
      if (federatedChannel) {
        const remoteMessages: z.infer<typeof messageSchema>[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;

        // the remote sends the channel one page at a time
        do {
          const page = await fetchRemoteMessagePage(federatedChannel, session, cursor);
          if (!page.ok) return status(page.status, page.error);

          // a cursor we have seen before would make us loop forever
          if (page.data.nextCursor && seenCursors.has(page.data.nextCursor)) {
            return status(502, { error: 'Remote messages returned an invalid response' });
          }

          remoteMessages.push(...page.data.messages);
          cursor = page.data.nextCursor;
          if (cursor) seenCursors.add(cursor);
        } while (cursor);

        return {
          messages: remoteMessages.map((message) =>
            mapFederatedMessage(message, channel.id, channel.guildId)
          ),
        };
      }

      const messages = await db.query.messages.findMany({
        where: { channelId },
        orderBy: { createdAt: 'desc' },
        with: {
          author: true,
          attachments: true,
        },
        limit: amount,
        offset: cursor,
      });
      messages.reverse();

      return {
        messages: messages.map((message) => {
          const edit = messageEdited(message);
          return {
            id: message.id,
            channelId: message.channelId,
            guildId: channel.guildId,
            content: message.content,
            nonce: message.nonce,
            replyTo: message.replyTo ?? null,
            edited: edit,
            editedTime: edit ? message.updatedAt.toISOString() : undefined,
            attachments: message.attachments.map((attachment) =>
              attachmentPayload(attachment as Parameters<typeof attachmentPayload>[0])
            ),
            createdAt:
              message.createdAt instanceof Date
                ? message.createdAt.toISOString()
                : message.createdAt,
            author: publicUser(message.author),
          };
        }),
      };
    },
    {
      query: t.Object({
        channelId: t.String(),
        cursor: t.Number(),
        amount: t.Number({ min: 20, max: 100, default: 50 }),
      }),
      response: {
        200: messageListResponseSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/send',
    async ({ body, session, status, server }) => {
      const { channelId, content, nonce, replyTo, attachmentIds = [] } = body;
      if (content === null && attachmentIds.length === 0) {
        return status(400, { error: 'Message content or an attachment is required' });
      }

      const channel = await db.query.channels.findFirst({
        where: { id: channelId },
      });
      if (!channel) {
        return status(404, { error: 'Channel not found' });
      }

      if (!(await canAccessChannel(channel, session.userId, true))) {
        return status(403, { error: 'Forbidden' });
      }

      const federatedChannel = parseFederatedChannelId(channelId);
      if (federatedChannel) {
        const sent = await callRemote(
          federatedChannel.homeserver,
          federationChannelPath(federatedChannel, 'messages/send'),
          session,
          { content, nonce, replyTo, attachmentIds },
          {
            response: messageResponseSchema,
            forward: passThrough(400, 401, 403, 404, 409),
            errors: {
              failed: 'Remote send failed',
              invalid: 'Remote send returned an invalid response',
            },
          }
        );
        if (!sent.ok) return status(sent.status, sent.error);

        const mappedMessage = mapFederatedMessage(sent.data.message, channel.id, channel.guildId);
        if (server) {
          await publishToChannel(server, channel, {
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
            id: priorMsg.id,
            channelId: priorMsg.channelId,
            guildId: channel.guildId,
            content: priorMsg.content,
            nonce: priorMsg.nonce,
            replyTo: priorMsg.replyTo ?? null,
            edited: messageEdited(priorMsg),
            pingedHandles: [],
            attachments: priorMsg.attachments.map((attachment) =>
              attachmentPayload(attachment as Parameters<typeof attachmentPayload>[0])
            ),
            createdAt:
              priorMsg.createdAt instanceof Date
                ? priorMsg.createdAt.toISOString()
                : priorMsg.createdAt,
            author: publicUser(session.user),
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

      const message = await createMessage({
        channel,
        authorId: session.userId,
        content,
        replyTo: replyTo ?? null,
        nonce,
        pingRecipients,
        attachments: attachments.value,
      });
      const responseAttachments = attachments.value.map(attachmentPayload);
      const responseMessage = {
        id: message.id,
        channelId: message.channelId,
        guildId: channel.guildId,
        content: message.content,
        nonce: message.nonce,
        replyTo: message.replyTo ?? null,
        edited: messageEdited(message),
        pingedHandles: pingRecipients.map((recipient) => recipient.handle),
        attachments: responseAttachments,
        createdAt:
          message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
        author: publicUser(session.user),
      };

      if (server) {
        await publishToChannel(server, channel, {
          type: 'message.created',
          data: responseMessage,
        });
      }
      notifyInBackground(
        { ...message, author: session.user },
        channel,
        channel.guildId ? pingRecipients : dmRecipients(channel.id)
      );

      return { message: responseMessage };
    },
    {
      body: t.Object({
        channelId: t.String(),
        content: t.Nullable(t.String()),
        nonce: t.String(),
        replyTo: t.Optional(t.String()),
        attachmentIds: t.Optional(
          t.Array(t.String(), { maxItems: maxAttachmentCount, uniqueItems: true })
        ),
      }),
      response: {
        200: messageResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/edit',
    async ({ body, session, status, server }) => {
      const { channelId, messageId, content } = body;
      const channel = await db.query.channels.findFirst({
        where: { id: channelId },
      });
      if (!channel) return status(404, { error: 'Channel not found' });

      if (!(await canAccessChannel(channel, session.userId)))
        return status(403, { error: 'Forbidden' });

      const federatedChannel = parseFederatedChannelId(channelId);
      if (federatedChannel) {
        const edited = await callRemote(
          federatedChannel.homeserver,
          federationChannelPath(federatedChannel, 'messages/edit'),
          session,
          { messageId, content },
          {
            response: messageResponseSchema,
            forward: passThrough(400, 401, 403, 404),
            errors: {
              failed: 'Remote edit failed',
              invalid: 'Remote edit returned an invalid response',
            },
          }
        );
        if (!edited.ok) return status(edited.status, edited.error);

        const mappedMessage = mapFederatedMessage(edited.data.message, channel.id, channel.guildId);
        if (server) {
          await publishToChannel(server, channel, {
            type: 'message.updated',
            data: mappedMessage,
          });
        }

        return { message: mappedMessage };
      }

      const existing = await db.query.messages.findFirst({
        where: { id: messageId, channelId },
        with: { attachments: true },
      });
      if (!existing) return status(404, { error: 'Message not found' });
      if (existing.authorId !== session.userId) return status(403, { error: 'Forbidden' });
      if (content === null && existing.attachments.length === 0) {
        return status(400, { error: 'Message content or an attachment is required' });
      }

      const replyTarget = existing.replyTo
        ? await db.query.messages.findFirst({ where: { id: existing.replyTo, channelId } })
        : null;
      const pingRecipients = await getPingRecipients(
        channel.guildId,
        content,
        replyTarget?.authorId,
        session.userId
      );

      const alreadyPinged = await pingedUserIds(existing.id);
      const updated = await editMessage(existing.id, content, pingRecipients);

      const responseMessage = {
        id: updated.id,
        channelId: updated.channelId,
        guildId: channel.guildId,
        content: updated.content,
        nonce: updated.nonce,
        replyTo: updated.replyTo ?? null,
        edited: true,
        editedTime: updated.updatedAt.toISOString(),
        pingedHandles: pingRecipients.map((recipient) => recipient.handle),
        attachments: existing.attachments.map((attachment) =>
          attachmentPayload(attachment as Parameters<typeof attachmentPayload>[0])
        ),
        createdAt:
          updated.createdAt instanceof Date ? updated.createdAt.toISOString() : updated.createdAt,
        author: publicUser(session.user),
      };

      if (server) {
        await publishToChannel(server, channel, {
          type: 'message.updated',
          data: responseMessage,
        });
      }
      // anyone already pinged by the original message was already notified
      notifyInBackground(
        { ...updated, author: session.user },
        channel,
        pingRecipients.filter((recipient) => !alreadyPinged.has(recipient.userId))
      );

      return { message: responseMessage };
    },
    {
      body: t.Object({
        channelId: t.String(),
        messageId: t.String(),
        content: t.Nullable(t.String()),
      }),
      response: {
        200: messageResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
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

      if (!(await canAccessChannel(channel, session.userId)))
        return status(403, { error: 'Forbidden' });

      const federatedChannel = parseFederatedChannelId(channelId);
      if (federatedChannel) {
        const deleted = await callRemote(
          federatedChannel.homeserver,
          federationChannelPath(federatedChannel, 'messages/delete'),
          session,
          { messageId },
          {
            // nothing to read from a successful answer
            response: z.unknown(),
            forward: passThrough(401, 403, 404),
            errors: { failed: 'Remote delete failed', invalid: 'Remote delete failed' },
          }
        );
        if (!deleted.ok) return status(deleted.status, deleted.error);

        return { success: true };
      }

      const existing = await db.query.messages.findFirst({
        where: { id: messageId, channelId },
        with: { attachments: true },
      });
      if (!existing) return status(404, { error: 'Message not found' });
      if (existing.authorId !== session.userId) return status(403, { error: 'Forbidden' });

      await deleteMessage(existing);

      if (server) {
        await publishToChannel(server, channel, {
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
      response: {
        200: successResponseSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  );

function fetchRemoteMessagePage(
  channel: { homeserver: string; id: string },
  session: Parameters<typeof callRemote>[2],
  cursor: string | null
) {
  return callRemote(
    channel.homeserver,
    federationChannelPath(channel, 'messages'),
    session,
    { limit: 100, ...(cursor ? { cursor } : {}) },
    {
      response: federatedMessageListResponseSchema,
      forward: passThrough(401, 403, 404),
      errors: {
        failed: 'Remote messages failed',
        invalid: 'Remote messages returned an invalid response',
      },
    }
  );
}

function mapFederatedMessage(
  message: z.infer<typeof messageSchema>,
  channelId: string,
  guildId: string | null
) {
  return {
    ...message,
    channelId,
    guildId,
    pingedHandles: message.pingedHandles ?? [],
  };
}

export function messageEdited(message: { createdAt: Date | string; updatedAt?: Date | string }) {
  return (
    new Date(message.updatedAt ?? message.createdAt).getTime() >
    new Date(message.createdAt).getTime()
  );
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
    } catch (e) {
      console.log('meow', e);
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
  guildId: string | null,
  content: string | null,
  replyAuthorId: string | undefined,
  authorId: string
) {
  // DMs have no @mentions to resolve; every message already goes straight to the other participant.
  if (!guildId) return [];

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
      ? [{ userId: member.userId, homeserver: member.user.homeserver, handle }]
      : [];
  });
}
