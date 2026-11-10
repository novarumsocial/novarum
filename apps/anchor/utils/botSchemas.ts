import { z } from 'zod';
import { publicUserSchema } from './publicUser';

// What bots can put on messages and register as commands. Everything here ends up rendered by
// other people's clients (possibly on other homeservers), so links are http(s) only and every
// string has a length limit.

const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);

export const embedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  url: httpUrl.optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  timestamp: z.iso.datetime({ offset: true }).optional(),
  author: z
    .object({
      name: z.string().min(1).max(256),
      url: httpUrl.optional(),
      iconUrl: httpUrl.optional(),
    })
    .optional(),
  footer: z.object({ text: z.string().min(1).max(2048), iconUrl: httpUrl.optional() }).optional(),
  image: z.object({ url: httpUrl }).optional(),
  thumbnail: z.object({ url: httpUrl }).optional(),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        value: z.string().min(1).max(1024),
        inline: z.boolean().optional(),
      })
    )
    .max(25)
    .optional(),
});

const customIdSchema = z.string().min(1).max(100);

const buttonSchema = z.discriminatedUnion('style', [
  z.object({
    type: z.literal('button'),
    style: z.enum(['primary', 'secondary', 'success', 'danger']),
    label: z.string().min(1).max(80),
    customId: customIdSchema,
    disabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('button'),
    style: z.literal('link'),
    label: z.string().min(1).max(80),
    url: httpUrl,
    disabled: z.boolean().optional(),
  }),
]);

export const actionRowSchema = z.object({
  type: z.literal('actionRow'),
  components: z.array(buttonSchema).min(1).max(5),
});

export const embedsSchema = z.array(embedSchema).max(10);
export const componentsSchema = z
  .array(actionRowSchema)
  .max(5)
  .refine(
    (rows) => {
      const ids = rows.flatMap((row) =>
        row.components.flatMap((button) => ('customId' in button ? [button.customId] : []))
      );
      return new Set(ids).size === ids.length;
    },
    { message: 'Button customIds must be unique within a message' }
  );

// shown above a message a bot sent in answer to a slash command
export const messageInteractionSchema = z.object({
  id: z.string(),
  name: z.string(),
  user: publicUserSchema,
});

export type Embed = z.infer<typeof embedSchema>;
export type ActionRow = z.infer<typeof actionRowSchema>;
export type MessageInteraction = z.infer<typeof messageInteractionSchema>;

export const commandNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/);

const choiceSchema = z.object({
  name: z.string().min(1).max(100),
  value: z.union([z.string().max(100), z.number()]),
});

export const commandOptionTypeSchema = z.enum(['string', 'integer', 'number', 'boolean', 'user']);

export const commandOptionSchema = z
  .object({
    name: commandNameSchema,
    description: z.string().min(1).max(100),
    type: commandOptionTypeSchema,
    required: z.boolean().default(false),
    choices: z.array(choiceSchema).max(25).optional(),
    autocomplete: z.boolean().optional(),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    minLength: z.number().int().min(0).max(6000).optional(),
    maxLength: z.number().int().min(1).max(6000).optional(),
  })
  .refine((option) => !(option.choices && option.autocomplete), {
    message: 'An option cannot have both choices and autocomplete',
  });

export const commandSchema = z.object({
  name: commandNameSchema,
  description: z.string().min(1).max(100),
  options: z
    .array(commandOptionSchema)
    .max(25)
    .default([])
    .refine((options) => new Set(options.map((o) => o.name)).size === options.length, {
      message: 'Option names must be unique',
    })
    .refine(
      (options) => {
        const firstOptional = options.findIndex((o) => !o.required);
        return firstOptional === -1 || options.slice(firstOptional).every((o) => !o.required);
      },
      { message: 'Required options must come before optional ones' }
    ),
});

export const maxCommandsPerBot = 100;
export const commandListSchema = z
  .array(commandSchema)
  .max(maxCommandsPerBot)
  .refine((commands) => new Set(commands.map((c) => c.name)).size === commands.length, {
    message: 'Command names must be unique',
  });

export type Command = z.infer<typeof commandSchema>;
export type CommandOption = z.infer<typeof commandOptionSchema>;
