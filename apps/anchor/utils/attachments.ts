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
  uploadUrl: z.string().url(),
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

export function attachmentPayload(attachment: {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    url: new URL(
      `/attachment/${encodeURIComponent(attachment.id)}`,
      getConfig().server.baseUrl
    ).toString(),
  };
}
