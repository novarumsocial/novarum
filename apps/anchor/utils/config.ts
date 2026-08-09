import { TOML } from 'bun';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  server: z.object({
    database_url: z.string().regex(/^postgresql:\/\/.*$/),
    homeserver: z.string(),
    baseUrl: z.string().regex(/^https?:\/\/(?:localhost:\d+|[^\/\s]+)$/),
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
      .default(['*'])
      // https://localhost for the mobile app, app://novarum for the electron app
      .transform((o) => (o.includes('*') ? ['*'] : [...new Set([...o, 'app://novarum', 'https://localhost'])])),
  }),
  email: z.object({
    smtp_host: z.string().min(1),
    smtp_secure: z.boolean().optional().default(true),
    smtp_port: z.number().int().positive().optional().default(465),
    smtp_user: z.string().min(1),
    smtp_pass: z.string().min(1),
    from_email: z.email(),
  }),
  misc: z.object({
    otp_pepper: z.string().min(1),
  }),
});

export type Config = z.infer<typeof schema>;

export function getConfig() {
  // doing readfilesync so its not a pain to work with.
  const config = schema.parse(TOML.parse(readFileSync('./config.toml').toString()));
  return config;
}
