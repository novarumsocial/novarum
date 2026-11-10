import { z } from 'zod';
import { publicUserSchema } from '../../utils/publicUser';
import { maxMessageLength } from '../message/services';
import {
  commandListSchema,
  commandNameSchema,
  commandOptionTypeSchema,
  componentsSchema,
  embedsSchema,
  messageInteractionSchema,
} from '../../utils/botSchemas';

// what a person sends to start an interaction
const optionInputSchema = z.object({
  name: commandNameSchema,
  value: z.union([z.string().max(6000), z.number(), z.boolean()]),
});

export const interactionInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'),
    botId: z.string().min(1).max(128),
    name: commandNameSchema,
    options: z.array(optionInputSchema).max(25).default([]),
  }),
  z.object({
    type: z.literal('autocomplete'),
    botId: z.string().min(1).max(128),
    name: commandNameSchema,
    options: z.array(optionInputSchema).max(25).default([]),
    focused: commandNameSchema,
  }),
  z.object({
    type: z.literal('button'),
    messageId: z.string().min(1).max(128),
    customId: z.string().min(1).max(100),
  }),
]);
export type InteractionInput = z.infer<typeof interactionInputSchema>;

export const autocompleteChoicesSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(100),
      value: z.union([z.string().max(100), z.number()]),
    })
  )
  .max(25);

// what the person's client learns once the bot answered (or didn't)
export const interactionResultSchema = z.object({
  // matches the `interaction.id` of the reply, so a client can swap its "thinking…" for it
  id: z.string(),
  type: z.enum(['message', 'deferred', 'update', 'deferredUpdate', 'autocomplete']),
  ephemeral: z.boolean().optional(),
  choices: autocompleteChoicesSchema.optional(),
});
export type InteractionResult = z.infer<typeof interactionResultSchema>;

// the message a bot answers with
export const responseMessageSchema = z.object({
  content: z.string().max(maxMessageLength).nullish(),
  embeds: embedsSchema.optional(),
  components: componentsSchema.optional(),
  ephemeral: z.boolean().optional(),
});
export type ResponseMessage = z.infer<typeof responseMessageSchema>;

export const callbackSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), data: responseMessageSchema }),
  z.object({
    type: z.literal('deferred'),
    data: z.object({ ephemeral: z.boolean().optional() }).optional(),
  }),
  z.object({ type: z.literal('update'), data: responseMessageSchema }),
  z.object({ type: z.literal('deferredUpdate') }),
  z.object({
    type: z.literal('autocomplete'),
    data: z.object({ choices: autocompleteChoicesSchema }),
  }),
]);
export type Callback = z.infer<typeof callbackSchema>;

export const respondActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('callback'), body: callbackSchema }),
  z.object({ action: z.literal('edit'), body: responseMessageSchema }),
  z.object({ action: z.literal('followup'), body: responseMessageSchema }),
]);
export type RespondAction = z.infer<typeof respondActionSchema>;

// what the bot receives
export const resolvedOptionSchema = z.object({
  name: z.string(),
  type: commandOptionTypeSchema,
  value: z.union([z.string(), z.number(), z.boolean()]),
  focused: z.boolean().optional(),
  user: publicUserSchema.optional(),
});

export const ephemeralMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  guildId: z.string(),
  content: z.string().max(maxMessageLength).nullable(),
  embeds: embedsSchema,
  components: componentsSchema,
  author: publicUserSchema,
  interaction: messageInteractionSchema.nullable(),
  createdAt: z.iso.datetime(),
  ephemeral: z.literal(true),
});
export type EphemeralMessage = z.infer<typeof ephemeralMessageSchema>;

export const interactionPayloadSchema = z.object({
  id: z.string().min(1).max(64),
  token: z.string().min(1).max(128),
  type: z.enum(['command', 'autocomplete', 'button']),
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  user: publicUserSchema,
  data: z.object({
    name: z.string().max(100),
    options: z.array(resolvedOptionSchema).max(25).optional(),
    customId: z.string().max(100).optional(),
  }),
  // the message a button was on
  message: z
    .object({ id: z.string(), ephemeral: z.boolean(), content: z.string().nullable() })
    .optional(),
});
export type InteractionPayload = z.infer<typeof interactionPayloadSchema>;

export const guildCommandsSchema = z.object({
  bots: z.array(z.object({ bot: publicUserSchema, commands: commandListSchema })),
});
