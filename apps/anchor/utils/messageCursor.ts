import { z } from 'zod';

export type MessageCursor = { createdAt: Date | string; id: string };

export function isMessageAfter(message: MessageCursor, cursor?: MessageCursor) {
  if (!cursor) return true;

  const messageTime = new Date(message.createdAt).getTime();
  const cursorTime = new Date(cursor.createdAt).getTime();
  return messageTime > cursorTime || (messageTime === cursorTime && message.id > cursor.id);
}

// A cursor is the position of the last message of a page: base64url of {"createdAt", "id"}.
// Clients treat it as an opaque string and hand it back to get the next page.
export const messageCursorSchema = z
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

export const encodeMessageCursor = (message: { createdAt: Date; id: string }) =>
  Buffer.from(
    JSON.stringify({ createdAt: message.createdAt.toISOString(), id: message.id })
  ).toString('base64url');
