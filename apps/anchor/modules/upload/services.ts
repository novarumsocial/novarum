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
import { storage, publicPresign, noStoreRedirect } from '../../utils/services/storage';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { attachments, db } from '../../src/db';
import { z } from 'zod';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import sharp from 'sharp';
import { sniffAudioVideo } from '../../utils/sniffAudioVideo';
import { Demuxer, Decoder, Scaler } from 'node-av/api';
import { getConfig } from '../../utils/config';

const remoteErrorSchema = z.object({ error: z.string() });

export const upload = new Elysia({ tags: ['Upload'] })
  .get(
    '/attachment/:id',
    async ({ params, status }) => {
      const attachment = await db.query.attachments.findFirst({
        where: { id: params.id, status: 'ATTACHED' },
      });
      if (!attachment) return status(404, { error: 'Attachment not found' });

      const url = publicPresign(attachment.objectKey, {
        method: 'GET',
        expiresIn: 5 * 60,
        contentDisposition: `inline; filename="${safeAttachmentFilename(attachment.filename)}"`,
      });

      return noStoreRedirect(url);
    },
    {
      response: {
        302: t.Void(),
        404: genericResponseErrorSchema,
      },
    }
  )
  .get('/attachment/:id/preview', async ({ params, status }) => {
    const saveStorage = getConfig().misc.save_attachment_thumbnails;
    const attachment = await db.query.attachments.findFirst({
      where: { id: params.id, status: 'ATTACHED' },
    });
    if (!attachment) return status(404, { error: 'Attachment not found' });

    const exists =
      saveStorage && (await storage.exists(`attachment-previews/${attachment.objectKey}`));
    if (exists) {
      const file = storage.file(`attachment-previews/${attachment.objectKey}`);
      return new Response(Buffer.from(await file.arrayBuffer()), {
        headers: {
          'content-type': file.type,
        },
      });
    }

    const url = publicPresign(attachment.objectKey, {
      method: 'GET',
      expiresIn: 5 * 60,
      contentDisposition: `inline; filename="${safeAttachmentFilename(attachment.filename)}"`,
    });
    const file = await (await fetch(url)).arrayBuffer();
    const type = sniffAudioVideo(file);

    let thumbnail: Buffer | undefined;
    if (type === 'image') {
      const img = sharp(file);
      const { width, height } = await img.metadata();
      thumbnail = await img
        .resize({
          width: width / 4,
          height: height / 4,
          fit: 'inside',
        })
        .webp({ quality: 75 })
        .toBuffer();
    } else if (type === 'video') {
      await using input = await Demuxer.open(Buffer.from(file));

      const video = input.video();
      if (!video) throw new Error('no video stream found');

      using decoder = await Decoder.create(video);
      using scaler = new Scaler();

      if (input.duration > 0) await input.seek(input.duration * 0.1, video.index);

      for await (const frame of decoder.frames(input.packets(video.index))) {
        if (!frame) continue;
        const scale = Math.min(1, 320 / frame.width, 240 / frame.height);

        // the scaler can only really do jpeg so we're going with that for a bit
        thumbnail = await scaler.toJpeg(frame, {
          resize: {
            width: Math.round(frame.width * scale),
            height: Math.round(frame.height * scale),
          },
          quality: 75,
        });
        break;
      }
    }

    if (saveStorage && thumbnail) {
      await storage.write(`attachment-previews/${attachment.objectKey}`, thumbnail, {
        type: type === 'video' ? 'image/jpeg' : 'image/webp',
      });
    }

    if (!thumbnail) return status(404, { error: 'No preview available' });
    return new Response(thumbnail, {
      headers: {
        'content-type': type === 'video' ? 'image/jpeg' : 'image/webp',
      },
    });
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
          const remoteError = remoteErrorSchema.safeParse(result.data);
          const remoteStatus = [400, 401, 403, 404, 415].includes(result.response.status)
            ? (result.response.status as 400 | 401 | 403 | 404 | 415)
            : 502;
          return status(
            remoteStatus,
            remoteError.success ? remoteError.data : { error: 'Remote upload failed' }
          );
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
      response: {
        200: presignedUploadSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
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
    uploadUrl: publicPresign(objectKey, {
      method: 'PUT',
      expiresIn: 5 * 60,
      type: input.contentType,
    }),
    headers: { 'content-type': input.contentType },
  };
}
