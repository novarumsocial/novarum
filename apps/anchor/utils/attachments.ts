import crypto from 'node:crypto';
import { z } from 'zod';
import { getConfig } from './config';

export const maxAttachmentCount = 5;
export const maxAttachmentSize = getConfig().files.max_file_size * 1024 * 1024;

const allowedContentTypes = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'audio/mpeg',
  'audio/ogg',
  'audio/flac',
  'audio/wav',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'video/mp4',
]);

export const attachmentPresignSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  size: z.number().int().min(1).max(maxAttachmentSize),
});

export const presignedUploadSchema = z.object({
  attachmentId: z.string(),
  uploadUrl: z.url(),
  headers: z.record(z.string(), z.string()),
});

export function isAllowedAttachmentType(contentType: string) {
  return allowedContentTypes.has(contentType);
}

export function safeAttachmentFilename(filename: string) {
  return (
    filename
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/[^\w.\- ]/g, '_')
      .slice(0, 255) || 'attachment'
  );
}

const attachmentUrlTtlSeconds = 7 * 24 * 60 * 60;

function attachmentSignature(id: string, exp: number) {
  return crypto
    .createHmac('sha256', `attachment:${getConfig().files.s3_secret_key}`)
    .update(`${id}:${exp}`)
    .digest('base64url');
}

export function isValidAttachmentSignature(id: string, exp: number, sig: string) {
  const expected = Buffer.from(attachmentSignature(id, exp));
  const given = Buffer.from(sig);
  return (
    exp > Date.now() / 1000 &&
    expected.length === given.length &&
    crypto.timingSafeEqual(expected, given)
  );
}

// federated viewers have no session here, so the link itself is the credential. it expires
// so a leaked link stops working; the expiry is rounded to the day to keep URLs cacheable.
function signedAttachmentUrl(path: string, id: string) {
  const day = 24 * 60 * 60;
  const exp = Math.floor(Date.now() / 1000 / day) * day + attachmentUrlTtlSeconds;
  const url = new URL(path, getConfig().server.base_url);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', attachmentSignature(id, exp));
  return url.toString();
}

export function attachmentPayload(attachment: {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}) {
  const path = `/attachment/${encodeURIComponent(attachment.id)}`;
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    url: signedAttachmentUrl(path, attachment.id),
    previewUrl: signedAttachmentUrl(`${path}/preview`, attachment.id),
  };
}
