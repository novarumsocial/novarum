import crypto from 'node:crypto';
import { getConfig } from './config';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { db, federationNonces, homeserverKeys } from '../src/db';
import { eq, lt } from 'drizzle-orm';

type KeyMaterial = {
  publicKey: string;
  privateKey: string;
  id: string;
};

const federationNonceCleanupIntervalMs = 60 * 1000;

let keyLoadPromise: Promise<KeyMaterial> | null = null;
let nextFederationNonceCleanupAt = 0;
let federationNonceCleanupPromise: Promise<void> | null = null;

export async function generateKeys(keyDir: string) {
  const homeserver = getConfig().server.homeserver;
  const date = new Date().toISOString().split('T')[0];
  const id = crypto.randomUUID();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const exportedPublicKey = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBase64 = Buffer.from(exportedPublicKey).toString('base64');

  const exportedPrivateKey = privateKey.export({ format: 'der', type: 'pkcs8' });
  const privateKeyBase64 = Buffer.from(exportedPrivateKey).toString('base64');

  const privateKeyFilename = `${date}_${id}_pkey.der.b64`;
  mkdirSync(keyDir, { recursive: true });
  await Bun.write(path.join(keyDir, privateKeyFilename), privateKeyBase64);

  await db.transaction(async (tx) => {
    await tx
      .update(homeserverKeys)
      .set({ active: false })
      .where(eq(homeserverKeys.homeserver, homeserver));
    await tx.insert(homeserverKeys).values({
      id,
      homeserver,
      publicKey: publicKeyBase64,
      privateKeyFilename,
      active: true,
    });
  });

  return {
    publicKey: publicKeyBase64,
    privateKey: privateKeyBase64,
    privateKeyFilename,
    id,
  };
}

export async function getKeys() {
  if (keyLoadPromise) return keyLoadPromise;

  keyLoadPromise = loadKeys();
  try {
    return await keyLoadPromise;
  } finally {
    keyLoadPromise = null;
  }
}

async function loadKeys(): Promise<KeyMaterial> {
  const activeKey = await db.query.homeserverKeys.findFirst({
    where: {
      active: true,
      homeserver: getConfig().server.homeserver,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!activeKey) {
    console.log('No active keys found for the homeserver, generating new keys...');
    const newKeys = await generateKeys(getConfig().federation.key_dir);
    return {
      publicKey: newKeys.publicKey,
      privateKey: newKeys.privateKey,
      id: newKeys.id,
    };
  }

  const privateKeyFile = Bun.file(
    path.join(getConfig().federation.key_dir, activeKey.privateKeyFilename)
  );
  if (!(await privateKeyFile.exists())) {
    console.warn('Active homeserver key file is missing, generating a replacement key...');
    const newKeys = await generateKeys(getConfig().federation.key_dir);
    return {
      publicKey: newKeys.publicKey,
      privateKey: newKeys.privateKey,
      id: newKeys.id,
    };
  }

  const privateKey = await privateKeyFile.text();

  return {
    publicKey: activeKey.publicKey,
    privateKey,
    id: activeKey.id,
  };
}

export async function signMessage(message: string) {
  const { privateKey } = await getKeys();
  const privateKeyObject = crypto.createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKeyObject);

  return signature.toString('base64');
}

export function verifyMessage(message: string, signature: string, publicKey: string) {
  const publicKeyObject = crypto.createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });

  return crypto.verify(
    null,
    Buffer.from(message, 'utf8'),
    publicKeyObject,
    Buffer.from(signature, 'base64')
  );
}

function federationNonceMaxAgeMs() {
  return getConfig().federation.nonce_max_age_seconds * 1000;
}

async function deleteExpiredFederationNonces() {
  const cutoff = new Date(Date.now() - federationNonceMaxAgeMs());
  await db.delete(federationNonces).where(lt(federationNonces.createdAt, cutoff));
}

async function maybeDeleteExpiredFederationNonces() {
  const now = Date.now();
  if (now < nextFederationNonceCleanupAt) return;
  if (federationNonceCleanupPromise) return federationNonceCleanupPromise;

  nextFederationNonceCleanupAt = now + federationNonceCleanupIntervalMs;
  federationNonceCleanupPromise = deleteExpiredFederationNonces().finally(() => {
    federationNonceCleanupPromise = null;
  });

  return federationNonceCleanupPromise;
}

export async function storeNonce(nonce: string, homeserver: string) {
  await maybeDeleteExpiredFederationNonces();

  const existingNonce = await db.query.federationNonces.findFirst({
    where: { nonce },
  });
  if (existingNonce) return false;

  try {
    await db.insert(federationNonces).values({
      id: crypto.randomUUID(),
      nonce,
      homeserver,
    });
  } catch {
    return false;
  }

  return true;
}

export async function isNonceUsed(nonce: string, _homeserver?: string) {
  await maybeDeleteExpiredFederationNonces();

  const existingNonce = await db.query.federationNonces.findFirst({
    where: { nonce },
  });
  return !!existingNonce;
}
