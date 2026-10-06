import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import {
  attachmentPayload,
  attachmentPresignSchema,
  isAllowedAttachmentType,
  maxAttachmentCount,
  presignedUploadSchema,
} from '../../../utils/attachments';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { publishToChannel } from '../../../utils/publishRealtime';
import { publicUser } from '../../../utils/publicUser';
import { dmRecipients, notifyInBackground } from '../../../utils/notify';
import { createMessage, deleteMessage, editMessage, pingedUserIds } from '../../message/store';
import { getPingRecipients, messageEdited, verifyPendingAttachments } from '../../message/services';
import { createPendingAttachment } from '../../upload/services';
import { getFederatedChannelAccess } from '../access';
import { federationAuth } from '../plugin';
import { federatedMessageSchema, federationErrors, successResponseSchema } from '../schemas';

const defaultPageSize = 50;
const maxPageSize = 100;

// what the sender may put in a message; anything else in the body is ignored
const sendBodySchema = z.object({
  content: z.string().nullable(),
  nonce: z.string(),
  replyTo: z.string().nullish(),
});
const attachmentIdsSchema = z
  .array(z.string())
  .max(maxAttachmentCount)
  .refine((ids) => new Set(ids).size === ids.length)
  .default([]);

const pageLimitSchema = z.number().int().min(1).max(maxPageSize).default(defaultPageSize);

// A cursor is the position of the last message of a page: base64url of {"createdAt", "id"}.
// Clients treat it as an opaque string and hand it back to get the next page.
const messageCursorSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      const decoded = z
        .object({ createdAt: z.string(), id: z.string() })
        .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
      const createdAt = new Date(decoded.createdAt);
      if (!Number.isNaN(createdAt.getTime())) return { createdAt, id: decoded.id };
    } catch {}
    ctx.addIssue({ code: 'custom', message: 'Invalid message cursor' });
    return z.NEVER;
  })
  .nullish();

const encodeMessageCursor = (message: { createdAt: Date; id: string }) =>
  Buffer.from(
    JSON.stringify({ createdAt: message.createdAt.toISOString(), id: message.id })
  ).toString('base64url');

type MessageForResponse = {
  id: string;
  channelId: string;
  content: string | null;
  nonce: string;
  replyTo: string | null;
  createdAt: Date;
  updatedAt: Date;
  attachments: Parameters<typeof attachmentPayload>[0][];
  pingedHandles?: string[];
};

function federatedMessageResponse(
  message: MessageForResponse,
  channel: { guildId: string | null },
  author: Parameters<typeof publicUser>[0]
) {
  const edited = messageEdited(message);
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: channel.guildId,
    content: message.content,
    nonce: message.nonce,
    replyTo: message.replyTo,
    edited,
    editedTime: edited ? message.updatedAt.toISOString() : undefined,
    pingedHandles: message.pingedHandles ?? [],
    attachments: message.attachments.map(attachmentPayload),
    createdAt: message.createdAt.toISOString(),
    author: publicUser(author),
  };
}

export const messageRoutes = new Elysia()
  .use(federationAuth)
  .post(
    '/channels/:id/messages/send',
    async ({ params, payload, remoteUser, server, status }) => {
      const body = sendBodySchema.safeParse(payload);
      if (!body.success) return status(400, { error: 'Invalid federation message' });
      const attachmentIds = attachmentIdsSchema.safeParse(payload.attachmentIds);
      if (!attachmentIds.success) return status(400, { error: 'Invalid attachment IDs' });
      const { content, nonce } = body.data;
      const replyTo = body.data.replyTo ?? null;
      if (content === null && attachmentIds.data.length === 0) {
        return status(400, { error: 'Message content or an attachment is required' });
      }

      const access = await getFederatedChannelAccess(params.id, remoteUser, true);
      if (!access.ok) return status(access.status, { error: access.error });

      const replyTarget = replyTo
        ? await db.query.messages.findFirst({ where: { id: replyTo, channelId: params.id } })
        : null;
      if (replyTo && !replyTarget) return status(400, { error: 'Invalid reply target' });

      // the sender retries with the same nonce when it didn't get our answer, so a message
      // that already exists is answered again instead of being created twice
      const prior = await db.query.messages.findFirst({
        where: { authorId: access.user.id, nonce },
        with: { attachments: true },
      });
      if (prior) {
        if (
          prior.channelId !== params.id ||
          prior.content !== content ||
          prior.replyTo !== replyTo
        ) {
          return status(409, { error: 'Nonce already used for a different message' });
        }
        return { message: federatedMessageResponse(prior, access.channel, access.user) };
      }

      const attachments = await verifyPendingAttachments(
        attachmentIds.data,
        access.user.id,
        params.id
      );
      if (!attachments.ok) return status(400, { error: attachments.error });
      const pingRecipients = await getPingRecipients(
        access.channel.guildId,
        content,
        replyTarget?.authorId,
        access.user.id
      );

      const created = await createMessage({
        channel: access.channel,
        authorId: access.user.id,
        content,
        replyTo,
        nonce,
        pingRecipients,
        attachments: attachments.value,
      });
      const message = {
        ...created,
        attachments: attachments.value,
        pingedHandles: pingRecipients.map((recipient) => recipient.handle),
      };

      const response = federatedMessageResponse(message, access.channel, access.user);
      if (server) {
        await publishToChannel(server, access.channel, { type: 'message.created', data: response });
      }
      notifyInBackground(
        { ...created, author: access.user },
        access.channel,
        access.channel.guildId ? pingRecipients : dmRecipients(access.channel.id)
      );

      return { message: response };
    },
    {
      federatedUser: true,
      response: {
        200: z.object({ message: federatedMessageSchema }),
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/messages/edit',
    async ({ params, payload, remoteUser, server, status }) => {
      const messageId = z.string().safeParse(payload.messageId);
      if (!messageId.success) return status(400, { error: 'Invalid message ID' });
      const content = z.string().nullable().safeParse(payload.content);
      if (!content.success) return status(400, { error: 'Invalid federation message' });

      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });

      const existing = await db.query.messages.findFirst({
        where: { id: messageId.data, channelId: params.id },
        with: { attachments: true },
      });
      if (!existing) return status(404, { error: 'Message not found' });
      if (existing.authorId !== access.user.id) return status(403, { error: 'Forbidden' });
      if (content.data === null && existing.attachments.length === 0) {
        return status(400, { error: 'Message content or an attachment is required' });
      }

      const replyTarget = existing.replyTo
        ? await db.query.messages.findFirst({
            where: { id: existing.replyTo, channelId: params.id },
          })
        : null;
      const pingRecipients = await getPingRecipients(
        access.channel.guildId,
        content.data,
        replyTarget?.authorId,
        access.user.id
      );

      const alreadyPinged = await pingedUserIds(existing.id);
      const updated = await editMessage(existing.id, content.data, pingRecipients);

      const response = federatedMessageResponse(
        {
          ...updated,
          attachments: existing.attachments,
          pingedHandles: pingRecipients.map((recipient) => recipient.handle),
        },
        access.channel,
        access.user
      );
      if (server) {
        await publishToChannel(server, access.channel, { type: 'message.updated', data: response });
      }
      notifyInBackground(
        { ...updated, author: access.user },
        access.channel,
        pingRecipients.filter((recipient) => !alreadyPinged.has(recipient.userId))
      );

      return { message: response };
    },
    {
      federatedUser: true,
      response: {
        200: z.object({ message: federatedMessageSchema }),
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/messages/delete',
    async ({ params, payload, remoteUser, server, status }) => {
      const messageId = z.string().safeParse(payload.messageId);
      if (!messageId.success) return status(400, { error: 'Invalid message ID' });

      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });

      const existing = await db.query.messages.findFirst({
        where: { id: messageId.data, channelId: params.id },
        with: { attachments: true },
      });
      if (!existing) return status(404, { error: 'Message not found' });
      if (existing.authorId !== access.user.id) return status(403, { error: 'Forbidden' });

      await deleteMessage(existing);

      if (server) {
        await publishToChannel(server, access.channel, {
          type: 'message.deleted',
          data: { id: existing.id, channelId: access.channel.id, guildId: access.channel.guildId },
        });
      }

      return { success: true };
    },
    {
      federatedUser: true,
      response: {
        200: successResponseSchema,
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  // one page of a channel's messages, oldest first; keep asking with `nextCursor` for the rest
  .post(
    '/channels/:id/messages',
    async ({ params, payload, remoteUser, status }) => {
      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });

      const limit = pageLimitSchema.safeParse(payload.limit);
      if (!limit.success) return status(400, { error: 'Invalid message page limit' });
      const cursor = messageCursorSchema.safeParse(payload.cursor);
      if (!cursor.success) return status(400, { error: 'Invalid message cursor' });

      // one more than asked for tells us whether there is a next page
      const found = await db.query.messages.findMany({
        where: cursor.data
          ? {
              channelId: params.id,
              OR: [
                { createdAt: { gt: cursor.data.createdAt } },
                { createdAt: { eq: cursor.data.createdAt }, id: { gt: cursor.data.id } },
              ],
            }
          : { channelId: params.id },
        with: { author: true, attachments: true },
        orderBy: { createdAt: 'asc', id: 'asc' },
        limit: limit.data + 1,
      });
      const page = found.slice(0, limit.data);
      const lastMessage = page.at(-1);

      return {
        messages: page.map((message) =>
          federatedMessageResponse(message, access.channel, message.author)
        ),
        nextCursor:
          found.length > limit.data && lastMessage ? encodeMessageCursor(lastMessage) : null,
      };
    },
    {
      federatedUser: true,
      response: {
        200: z.object({
          messages: z.array(federatedMessageSchema),
          nextCursor: z.string().nullable(),
        }),
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/attachments/presign',
    async ({ params, payload, remoteUser, status }) => {
      const upload = attachmentPresignSchema.safeParse(payload);
      if (!upload.success) return status(400, { error: 'Invalid attachment metadata' });
      if (!isAllowedAttachmentType(upload.data.contentType)) {
        return status(415, { error: 'Unsupported file type' });
      }

      const access = await getFederatedChannelAccess(params.id, remoteUser, true);
      if (!access.ok) return status(access.status, { error: access.error });

      return createPendingAttachment({
        channelId: access.channel.id,
        guildId: access.channel.guildId,
        uploaderId: access.user.id,
        ...upload.data,
      });
    },
    {
      federatedUser: true,
      response: {
        200: presignedUploadSchema,
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
      },
    }
  );
