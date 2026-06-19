import type { DefaultModelRow } from '@prisma-next/sql-orm-client';
import { randomString } from '../../utils/randomString';
import type { Contract } from '../../prisma/contract.d';
import { db } from '../../prisma/db';

const sessionExpiresInSeconds = 60 * 60 * 24 * 30;

export async function createSession(): Promise<SessionWithToken> {
  const now = new Date();

  const id = randomString();
  const secret = randomString();
  const secretHash = await hashSecret(secret);

  const token = id + '.' + secret;

  const session: SessionWithToken = {
    id,
    secretHash,
    createdAt: now,
    token,
  };

  await db.orm.public.Session.create({ id, secretHash, createdAt: now });

  return session;
}

export async function validateSessionToken(token: string): Promise<Session | null> {
  const tokenParts = token.split('.');
  if (tokenParts.length !== 2) {
    return null;
  }

  const [sessionId, sessionSecret] = tokenParts;
  if (!sessionId || !sessionSecret) {
    return null;
  }

  const session = await getSession(sessionId);
  if (!session) {
    return null;
  }

  const tokenSecretHash = await hashSecret(sessionSecret);
  const validSecret = constantTimeEqual(tokenSecretHash, session.secretHash);
  if (!validSecret) {
    return null;
  }

  return session;
}

async function getSession(sessionId: string): Promise<Session | null> {
  const now = new Date();

  const session = await db.orm.public.Session.where({ id: sessionId }).first();
  if (!session) {
    return null;
  }

  if (now.getTime() - session.createdAt.getTime() >= sessionExpiresInSeconds * 1000) {
    await deleteSession(sessionId);
    return null;
  }

  return session;
}

async function deleteSession(sessionId: string): Promise<void> {
  await db.orm.public.Session.where({ id: sessionId }).delete();
}

async function hashSecret(secret: string): Promise<Uint8Array> {
  const secretBytes = new TextEncoder().encode(secret);
  const secretHashBuffer = await crypto.subtle.digest('SHA-256', secretBytes);
  return new Uint8Array(secretHashBuffer);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!;
  }

  return diff === 0;
}

export type Session = DefaultModelRow<Contract, 'Session'>;

export interface SessionWithToken extends Session {
  token: string;
}
