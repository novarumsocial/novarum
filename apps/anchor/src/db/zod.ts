import { createInsertSchema, createSelectSchema } from 'drizzle-orm/zod';
import { z } from 'zod';
import {
  attachments,
  channelMembers,
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

// channels users can create within a guild; DM/GROUP_DM channels are made by the /dm module.
const channelTypeSchema = z.enum(['TEXT', 'VOICE']);
export const dmChannelTypeSchema = z.enum(['DM', 'GROUP_DM']);
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

// this is guild-channel-only: guildId and type are always present for TEXT/VOICE channels.
export const channelResponseSchema = createSelectSchema(channels, {
  type: channelTypeSchema,
  guildId: z.string(),
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
  guildId: z.string(),
}).pick({ name: true, type: true, guildId: true });

const channelMemberResponseSchema = createSelectSchema(channelMembers, {
  joinedAt: isoDateSchema,
}).pick({ joinedAt: true });

export const dmResponseSchema = z.object({
  id: z.string(),
  type: dmChannelTypeSchema,
  participants: z.array(publicUserSchema),
  lastMessageAt: isoDateSchema.nullable(),
  unread: z.boolean(),
  joinedAt: channelMemberResponseSchema.shape.joinedAt,
});

// what a homeserver's POST /federation/dms/open returns: just enough to build a shadow DM locally.
export const dmOpenResponseSchema = dmResponseSchema.pick({ id: true, type: true }).extend({
  participants: z.array(publicUserSchema),
});
