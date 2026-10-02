import path from 'node:path';

export const anchorRoot = path.resolve(import.meta.dir, '../..');

// defaults match test/compose.yml; override them when the ports are remapped
export const adminDatabaseUrl =
  process.env.ANCHOR_TEST_PG_URL ?? 'postgresql://novarum:novarum@127.0.0.1:15432/postgres';
export const mailpitUrl = process.env.ANCHOR_TEST_MAILPIT_URL ?? 'http://127.0.0.1:8025';
export const smtpPort = Number(process.env.ANCHOR_TEST_SMTP_PORT ?? 1025);
export const s3Endpoint = process.env.ANCHOR_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:3900';
export const livekitUrl = process.env.ANCHOR_TEST_LIVEKIT_URL ?? 'ws://127.0.0.1:7880';
