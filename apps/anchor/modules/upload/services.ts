import Elysia, { t } from 'elysia';
import {
  isAllowedAttachmentType,
  isValidAttachmentSignature,
  maxAttachmentSize,
  presignedUploadSchema,
  safeAttachmentFilename,
} from '../../utils/attachments';
import { parseFederatedChannelId } from '../../utils/federationIds';
import { callRemote, federationChannelPath, passThrough } from '../../utils/federationClient';
import { randomString } from '../../utils/randomString';
import {
  storage,
  publicPresign,
  uploadPresign,
  noStoreRedirect,
} from '../../utils/services/storage';
import { requestSession, type SessionWithUser } from '../auth/provider';
import { canAccessChannel } from '../../utils/channelAccess';
import { attachments, db } from '../../src/db';
import { z } from 'zod';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import sharp from 'sharp';
import { sniffAudioVideo } from '../../utils/sniffAudioVideo';
import { Demuxer, Decoder, Scaler } from 'node-av/api';
import { getConfig } from '../../utils/config';
import { maxInputPixels } from '../../utils/optimizeWebp';
import { uploadQuotaExceeded } from '../../utils/uploadQuota';

const attachmentQuery = t.Object({ exp: t.Numeric(), sig: t.String() });

// each decode can take a few hundred MB, so only a couple run at once and the rest wait their turn
const maxConcurrentPreviews = 2;
const maxQueuedPreviews = 200;
let previewsInFlight = 0;
const previewQueue: (() => void)[] = [];

async function acquirePreviewSlot() {
  if (previewsInFlight < maxConcurrentPreviews) {
    previewsInFlight++;
    return true;
  }
  if (previewQueue.length >= maxQueuedPreviews) return false;
  await new Promise<void>((resolve) => previewQueue.push(resolve));
  return true;
}

// hands the slot straight to the next waiting request
function releasePreviewSlot() {
  const next = previewQueue.shift();
  if (next) next();
  else previewsInFlight--;
}
// attachments are immutable, so a file that failed once will always fail
const failedPreviews = new Set<string>();

async function renderPreview(file: ArrayBuffer) {
  const type = sniffAudioVideo(file);
  if (type === 'image') {
    const data = await sharp(file, { limitInputPixels: maxInputPixels })
      .rotate()
      .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return { data, type: 'image/webp' };
  }
  if (type !== 'video') return null;

  await using input = await Demuxer.open(Buffer.from(file));
  const video = input.video();
  if (!video || video.codecpar.width * video.codecpar.height > maxInputPixels) return null;

  using decoder = await Decoder.create(video);
  using scaler = new Scaler();
  for await (const frame of decoder.frames(input.packets(video.index))) {
    if (!frame) continue;
    const scale = Math.min(1, 320 / frame.width, 240 / frame.height);
    // the scaler can only really do jpeg so we're going with that for a bit
    const data = await scaler.toJpeg(frame, {
      resize: {
        width: Math.round(frame.width * scale),
        height: Math.round(frame.height * scale),
      },
      quality: 75,
    });
    return { data, type: 'image/jpeg' };
  }
  return null;
}

async function requireUploadAccess(
  channelId: string,
  contentType: string,
  session: SessionWithUser | null
) {
  if (!session) return { ok: false as const, status: 401 as const, error: 'Unauthorized' };
  if (!isAllowedAttachmentType(contentType)) {
    return { ok: false as const, status: 415 as const, error: 'Unsupported file type' };
  }

  const channel = await db.query.channels.findFirst({
    where: { id: channelId },
  });
  if (!channel) return { ok: false as const, status: 404 as const, error: 'Channel not found' };

  if (!(await canAccessChannel(channel, session.userId, true))) {
    return { ok: false as const, status: 403 as const, error: 'Forbidden' };
  }

  return { ok: true as const, session, channel };
}

export const upload = new Elysia({ tags: ['Upload'] })
  .get(
    '/attachment/:id',
    async ({ params, query, status }) => {
      const attachment = await db.query.attachments.findFirst({
        where: { id: params.id, status: 'ATTACHED' },
      });
      if (!attachment || !isValidAttachmentSignature(attachment.id, query.exp, query.sig)) {
        return status(404, { error: 'Attachment not found' });
      }

      const url = publicPresign(attachment.objectKey, {
        method: 'GET',
        expiresIn: 5 * 60,
        contentDisposition: `inline; filename="${safeAttachmentFilename(attachment.filename)}"`,
      });

      return noStoreRedirect(url);
    },
    {
      query: attachmentQuery,
      response: {
        302: t.Void(),
        404: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/attachment/:id/preview',
    async ({ params, query, set, status }) => {
      const saveStorage = getConfig().misc.save_attachment_thumbnails;
      const attachment = await db.query.attachments.findFirst({
        where: { id: params.id, status: 'ATTACHED' },
      });
      if (!attachment || !isValidAttachmentSignature(attachment.id, query.exp, query.sig)) {
        return status(404, { error: 'Attachment not found' });
      }
      if (failedPreviews.has(attachment.id)) return status(404, { error: 'No preview available' });

      // an empty object marks a file that has no preview
      const key = `attachment-previews/${attachment.objectKey}`;
      const cached = saveStorage
        ? await storage
            .file(key)
            .stat()
            .catch(() => null)
        : null;
      if (cached) {
        if (!cached.size) return status(404, { error: 'No preview available' });
        return new Response(await storage.file(key).arrayBuffer(), {
          headers: { 'content-type': cached.type },
        });
      }

      if (!(await acquirePreviewSlot())) {
        set.headers['retry-after'] = '5';
        return status(503, { error: 'Preview busy, try again later' });
      }
      const preview = await (async () => {
        try {
          const url = publicPresign(attachment.objectKey, { method: 'GET', expiresIn: 5 * 60 });
          return await renderPreview(await (await fetch(url)).arrayBuffer());
        } catch {
          return null;
        } finally {
          releasePreviewSlot();
        }
      })();

      if (!preview) {
        if (failedPreviews.size >= 10_000) failedPreviews.clear();
        failedPreviews.add(attachment.id);
        if (saveStorage)
          await storage.write(key, new Uint8Array(), { type: 'application/x-no-preview' });
        return status(404, { error: 'No preview available' });
      }

      if (saveStorage) await storage.write(key, preview.data, { type: preview.type });
      return new Response(new Uint8Array(preview.data), {
        headers: { 'content-type': preview.type },
      });
    },
    { query: attachmentQuery }
  )
  .post(
    '/upload/presign',
    async ({ body, cookie, request, status }) => {
      const access = await requireUploadAccess(
        body.channelId,
        body.contentType,
        await requestSession(cookie, request)
      );
      if (!access.ok) return status(access.status, { error: access.error });

      const session = access.session;
      const federatedChannel = parseFederatedChannelId(body.channelId);
      if (federatedChannel) {
        const remoteUpload = await callRemote(
          federatedChannel.homeserver,
          federationChannelPath(federatedChannel, 'attachments/presign'),
          session,
          { filename: body.filename, contentType: body.contentType, size: body.size },
          {
            response: presignedUploadSchema,
            forward: passThrough(400, 401, 403, 404, 415, 429),
            errors: {
              failed: 'Remote upload failed',
              invalid: 'Remote homeserver returned an invalid upload',
            },
          }
        );
        if (!remoteUpload.ok) return status(remoteUpload.status, remoteUpload.error);
        return remoteUpload.data;
      }
      if (await uploadQuotaExceeded(session.userId, body.size)) {
        return status(429, { error: 'Upload limit reached, try again later' });
      }

      return createPendingAttachment({
        channelId: access.channel.id,
        guildId: access.channel.guildId,
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
        429: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  );

export async function createPendingAttachment(input: {
  channelId: string;
  guildId: string | null;
  uploaderId: string;
  filename: string;
  contentType: string;
  size: number;
}) {
  const attachmentId = randomString();
  const objectKey = `attachments/${input.guildId ?? 'dm'}/${input.channelId}/${attachmentId}`;
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
    uploadUrl: uploadPresign(objectKey, {
      method: 'PUT',
      expiresIn: 5 * 60,
      type: input.contentType,
    }),
    headers: { 'content-type': input.contentType },
  };
}
