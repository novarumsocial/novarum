import toml from 'toml';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  server: z.object({
    database_url: z.string().regex(/^postgresql:\/\/.*$/),
    homeserver: z.string(),
    baseUrl: z.string(),
    listen_port: z.number().int().positive().optional().default(5049),
  }),
  federation: z.object({
    key_dir: z.string().optional().default('./keys'),
    nonce_max_age_seconds: z.number().positive().optional().default(300),
  }),
  voice: z.object({
    livekit_url: z.string().refine((val) => val.startsWith('wss://') || val.startsWith('ws://'), {
      error: 'livekit_url must start with ws:// or wss://',
    }),
    livekit_key: z.string().min(1, 'livekit_key must be a non-empty string'),
    livekit_secret: z.string().min(1, 'livekit_secret must be a non-empty string'),
  }),
  files: z.object({
    max_file_size: z.number().positive().optional().default(10),
    max_avatar_size: z.number().positive().optional().default(2),
    s3_access_key: z.string().min(1),
    s3_secret_key: z.string().min(1),
    // apparently the rest is optional if you use amazon s3
    s3_bucket: z.string().min(1).optional(),
    s3_endpoint: z.string().min(1).optional(),
    s3_region: z.string().min(1).optional(),
    s3_virtual_hosted_style: z.boolean().optional().default(false),
    s3_cors_origins: z
      .array(z.union([z.url(), z.literal('*')]))
      .min(1)
      .optional()
      .default(['*']),
  }),
});

export type Config = z.infer<typeof schema>;

export function getConfig() {
  // doing readfilesync so its not a pain to work with.
  // also, you might be asking yourself: "why the hell is he using the toml package instead of bun's integrated parser?"
  // the answer is pretty simple: for some reason, prisma-next has a strange runtime which is not bun to read the prisma-next.config.ts file, and it does not have the toml parser integrated. so we need to use the toml package to parse the config.toml file,
  // so this might do the trick
  const config = schema.parse(toml.parse(readFileSync('./config.toml').toString()));
  return config;
}
