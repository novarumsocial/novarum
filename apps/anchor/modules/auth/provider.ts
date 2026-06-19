import type { DefaultModelRow } from '@prisma-next/sql-orm-client';
import { randomString } from '../../utils/randomString';
import type { Contract } from '../../prisma/contract.d';
import { db } from '../../prisma/db';

export const sessionCookieName = 'session_token';
export const sessionExpiresInSeconds = 60 * 60 * 24 * 30;
export const sessionExpiresInMilliseconds = sessionExpiresInSeconds * 1000;

export async function createSession(userId: string): Promise<SessionWithToken> {
  const now = new Date();

  const id = randomString();
  const secret = randomString();
  const secretHash = await hashSecret(secret);

  const token = id + '.' + secret;

  const session: SessionWithToken = {
    id,
    userId,
    secretHash,
    createdAt: now,
    token,
  };

  await db.orm.public.Session.create({ id, userId, secretHash, createdAt: now });

  return session;
}

export async function validateSessionToken(token: string): Promise<Session | null> {
  const tokenParts = parseSessionToken(token);
  if (!tokenParts) {
    return null;
  }

  const { sessionId, sessionSecret } = tokenParts;

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

export async function deleteSessionToken(token: string): Promise<void> {
  const tokenParts = parseSessionToken(token);
  if (!tokenParts) {
    return;
  }

  await deleteSession(tokenParts.sessionId);
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const now = new Date();

  const session = await db.orm.public.Session.where({ id: sessionId }).first();
  if (!session) {
    return null;
  }

  if (isSessionExpired(session, now)) {
    await deleteSession(sessionId);
    return null;
  }

  return session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.orm.public.Session.where({ id: sessionId }).delete();
}

export function createSessionCookie(token: string): SessionCookie {
  return {
    name: sessionCookieName,
    value: token,
    attributes: {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: sessionExpiresInSeconds,
    },
  };
}

export function createBlankSessionCookie(): SessionCookie {
  return {
    name: sessionCookieName,
    value: '',
    attributes: {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    },
  };
}

export async function hashSecret(secret: string): Promise<Uint8Array> {
  const secretBytes = new TextEncoder().encode(secret);
  const secretHashBuffer = await crypto.subtle.digest('SHA-256', secretBytes);
  return new Uint8Array(secretHashBuffer);
}

function parseSessionToken(token: string): SessionTokenParts | null {
  const [sessionId, sessionSecret, ...extraParts] = token.split('.');
  if (!sessionId || !sessionSecret || extraParts.length > 0) {
    return null;
  }

  return { sessionId, sessionSecret };
}

function isSessionExpired(session: Session, now = new Date()): boolean {
  return now.getTime() - session.createdAt.getTime() >= sessionExpiresInMilliseconds;
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
export type User = DefaultModelRow<Contract, 'User'>;

export interface SessionWithToken extends Session {
  token: string;
}

interface SessionTokenParts {
  sessionId: string;
  sessionSecret: string;
}

export interface SessionCookie {
  name: typeof sessionCookieName;
  value: string;
  attributes: {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: '/';
    maxAge: number;
  };
}
