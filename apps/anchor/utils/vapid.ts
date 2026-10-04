import path from 'node:path';
import { mkdirSync } from 'node:fs';
import webpush from 'web-push';
import { z } from 'zod';
import { getConfig } from './config';

const vapidKeysSchema = z.object({ publicKey: z.string(), privateKey: z.string() });

let vapidKeys: Promise<z.infer<typeof vapidKeysSchema>> | null = null;

// generated on first start and kept next to the federation keys, so it survives restarts.
export function getVapidKeys() {
  return (vapidKeys ??= loadVapidKeys().catch((error) => {
    vapidKeys = null;
    throw error;
  }));
}

async function loadVapidKeys() {
  const keyDir = getConfig().federation.key_dir;
  const file = Bun.file(path.join(keyDir, 'vapid.json'));
  const existing = vapidKeysSchema.safeParse(await file.json().catch(() => null));
  if (existing.success) return existing.data;

  console.log('No VAPID keys found, generating new keys...');
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(keyDir, { recursive: true });
  await Bun.write(file, JSON.stringify(keys));
  return keys;
}

export function vapidSubject() {
  const { notifications, email } = getConfig();
  return notifications.vapid_subject ?? `mailto:${email.from_email}`;
}
