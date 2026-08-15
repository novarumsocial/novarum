import { createInsertSchema, createSelectSchema } from 'drizzle-orm/zod';
import { z } from 'zod';
import {
  attachments,
  channels,
  friendRelationships,
  guildInvites,
  guildMembers,
  guilds,
  messages,
  mfaMethod,
  users,
} from './schema';
import { publicUserSchema } from '../../utils/publicUser';

const isoDateSchema = z.iso.datetime();

const channelTypeSchema = z.enum(['TEXT', 'VOICE']);
const guildMemberRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
export const userStatusSchema = z.enum(['ONLINE', 'OFFLINE']);
export const friendStatusSchema = z.enum(['NONE', 'PENDING', 'ACCEPTED']);

export const userSelectSchema = createSelectSchema(users, {
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const guildResponseSchema = createSelectSchema(guilds, {
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const federatedGuildResponseSchema = guildResponseSchema
  .pick({ id: true, name: true, description: true, avatarUrl: true })
  .extend({ homeserver: z.string() });

export const guildInviteResponseSchema = createSelectSchema(guildInvites, {
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema.nullable(),
});

export const channelResponseSchema = createSelectSchema(channels, {
  type: channelTypeSchema,
  position: z.number(),
}).pick({
  id: true,
  guildId: true,
  name: true,
  type: true,
  position: true,
});

export const attachmentResponseSchema = createSelectSchema(attachments, { size: z.number() })
  .pick({
    id: true,
    filename: true,
    contentType: true,
    size: true,
  })
  .extend({ url: z.url(), previewUrl: z.url() });

export const messageResponseBaseSchema = createSelectSchema(messages, {
  createdAt: isoDateSchema,
})
  .pick({
    id: true,
    channelId: true,
    content: true,
    nonce: true,
    replyTo: true,
    createdAt: true,
  })
  .extend({ edited: z.boolean().default(false), editedTime: isoDateSchema.optional() });

export const friendRelationshipResponseSchema = createSelectSchema(friendRelationships, {
  status: friendStatusSchema,
  version: z.number().int().positive(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  acceptedAt: isoDateSchema.nullable(),
});

const guildMemberResponseSchema = createSelectSchema(guildMembers, {
  role: guildMemberRoleSchema,
  joinedAt: isoDateSchema,
}).pick({ role: true, joinedAt: true });

export const channelUsersResponseSchema = z.object({
  users: z.array(
    publicUserSchema.extend({
      status: userStatusSchema,
      role: guildMemberResponseSchema.shape.role,
      joinedAt: guildMemberResponseSchema.shape.joinedAt,
    })
  ),
});

export const mfaMethodSchema = createSelectSchema(mfaMethod);

export const guildCreateSchema = createInsertSchema(guilds, {
  name: (schema) => schema.min(1).max(100),
}).pick({ name: true });

export const channelCreateSchema = createInsertSchema(channels, {
  name: (schema) => schema.min(1).max(100),
  type: channelTypeSchema,
}).pick({ name: true, type: true, guildId: true });
