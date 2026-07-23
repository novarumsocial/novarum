import Elysia, { t } from 'elysia';
import {
  isAllowedAttachmentType,
  maxAttachmentSize,
  presignedUploadSchema,
  safeAttachmentFilename,
} from '../../utils/attachments';
import { postSignedFederationJson } from '../../utils/discovery';
import { parseFederatedChannelId } from '../../utils/federationIds';
import { federationUserPayload } from '../../utils/federationPayload';
import { randomString } from '../../utils/randomString';
import { storage } from '../../utils/services/storage';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { attachments, db } from '../../src/db';

export const upload = new Elysia()
  .get('/attachment/:id', async ({ params, status }) => {
    const attachment = await db.query.attachments.findFirst({
      where: { id: params.id, status: 'ATTACHED' },
    });
    if (!attachment) return status(404, { error: 'Attachment not found' });

    const url = storage.presign(attachment.objectKey, {
      method: 'GET',
      expiresIn: 5 * 60,
      contentDisposition: `inline; filename="${safeAttachmentFilename(attachment.filename)}"`,
    });

    return Response.redirect(url);
  })
  .post(
    '/upload/presign',
    async ({ body, cookie, status }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) return status(401, { error: 'Unauthorized' });
      if (!isAllowedAttachmentType(body.contentType)) {
        return status(415, { error: 'Unsupported file type' });
      }

      const channel = await db.query.channels.findFirst({
        where: { id: body.channelId },
      });
      if (!channel) return status(404, { error: 'Channel not found' });

      const membership = await db.query.guildMembers.findFirst({
        where: { guildId: channel.guildId, userId: session.userId },
      });
      if (!membership) return status(403, { error: 'Forbidden' });

      const federatedChannel = parseFederatedChannelId(body.channelId);
      if (federatedChannel) {
        const result = await postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/attachments/presign`,
          {
            user: federationUserPayload(session),
            filename: body.filename,
            contentType: body.contentType,
            size: body.size,
          }
        ).catch(() => null);

        if (!result) return status(502, { error: 'Could not reach remote homeserver' });
        if (!result.response.ok) {
          return status(result.response.status, result.data ?? { error: 'Remote upload failed' });
        }
        const remoteUpload = presignedUploadSchema.safeParse(result.data);
        if (!remoteUpload.success) {
          return status(502, { error: 'Remote homeserver returned an invalid upload' });
        }
        return remoteUpload.data;
      }

      return createPendingAttachment({
        channelId: channel.id,
        guildId: channel.guildId,
        uploaderId: session.userId,
        filename: body.filename,
        contentType: body.contentType,
        size: body.size,
      });
    },
    {
      body: t.Object({
        channelId: t.String({ minLength: 1 }),
        filename: t.String({ minLength: 1, maxLength: 255 }),
        contentType: t.String({ minLength: 1, maxLength: 255 }),
        size: t.Integer({ minimum: 1, maximum: maxAttachmentSize }),
      }),
    }
  );

export async function createPendingAttachment(input: {
  channelId: string;
  guildId: string;
  uploaderId: string;
  filename: string;
  contentType: string;
  size: number;
}) {
  const attachmentId = randomString();
  const objectKey = `attachments/${input.guildId}/${input.channelId}/${attachmentId}`;
  const filename = safeAttachmentFilename(input.filename);

  await db.insert(attachments).values({
    id: attachmentId,
    objectKey,
    filename,
    contentType: input.contentType,
    size: input.size,
    status: 'PENDING',
    uploaderId: input.uploaderId,
    channelId: input.channelId,
    messageId: null,
  });

  return {
    attachmentId,
    uploadUrl: storage.presign(objectKey, {
      method: 'PUT',
      expiresIn: 5 * 60,
      type: input.contentType,
    }),
    headers: { 'content-type': input.contentType },
  };
}
