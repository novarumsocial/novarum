import { z } from 'zod';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { publicUserSchema } from '../../utils/publicUser';
import { attachmentResponseSchema, messageResponseBaseSchema } from '../../src/db/zod';

export const okResponseSchema = z.object({ ok: z.boolean() });
export const successResponseSchema = z.object({ success: z.boolean() });

// every signed route can fail the signature check (400 / 401), so routes spread this into
// their `response` and only list the errors that are specific to them
export const federationErrors = {
  400: genericResponseErrorSchema,
  401: genericResponseErrorSchema,
};

export const federatedMessageSchema = messageResponseBaseSchema.extend({
  guildId: z.string().nullable(),
  pingedHandles: z.array(z.string()),
  attachments: z.array(attachmentResponseSchema),
  author: publicUserSchema,
});
