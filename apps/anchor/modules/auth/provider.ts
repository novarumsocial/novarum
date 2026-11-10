import { randomString } from '../../utils/randomString';
import { getConfig } from '../../utils/config';
import { db, sessions, users } from '../../src/db';
import { eq } from 'drizzle-orm';

export const sessionCookieName = 'session_token';
export const sessionExpiresInSeconds = 60 * 60 * 24 * 365; // 1 year
export const sessionExpiresInMilliseconds = sessionExpiresInSeconds * 1000;

export async function createSession(
  userId: string,
  expiresAt = new Date(Date.now() + sessionExpiresInMilliseconds)
): Promise<SessionWithToken> {
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
    expiresAt,
    token,
  };

  await db
    .insert(sessions)
    .values({
      id,
      userId,
      secretHash,
      createdAt: now,
      expiresAt,
    })
    .execute();

  return session;
}

// the session cookie is for people only: a bot token pasted into a cookie authenticates nothing
export async function validateSessionToken(token: string | undefined) {
  const session = await validateAnyToken(token);
  return session && !session.user.isBot ? session : null;
}

export async function validateBotToken(token: string | undefined) {
  const session = await validateAnyToken(token);
  return session?.user.isBot ? session : null;
}

/** The session of a request: `Authorization: Bot <token>` for bots, the session cookie for people. */
export function requestSession(
  cookie: Record<string, { value?: unknown } | undefined>,
  request: Request
) {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const [scheme, token] = authorization.split(' ');
    return validateBotToken(scheme === 'Bot' ? token : undefined);
  }
  return validateSessionToken(cookie[sessionCookieName]?.value as string | undefined);
}

// bot tokens don't expire, they are revoked by regenerating them
export const botTokenExpiry = () => new Date('9999-12-31T00:00:00Z');

async function validateAnyToken(token: string | undefined): Promise<SessionWithUser | null> {
  if (!token) {
    return null;
  }

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

export async function getSession(sessionId: string) {
  const now = new Date();

  const session = await db.query.sessions.findFirst({
    where: {
      id: sessionId,
    },
    with: {
      user: true,
    },
  });
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
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export function createSessionCookie(token: string): SessionCookie {
  return {
    name: sessionCookieName,
    value: token,
    attributes: sessionCookieAttributes(sessionExpiresInSeconds),
  };
}

export function createBlankSessionCookie(): SessionCookie {
  return {
    name: sessionCookieName,
    value: '',
    attributes: sessionCookieAttributes(0),
  };
}

function sessionCookieAttributes(maxAge: number): SessionCookie['attributes'] {
  const { protocol, hostname } = new URL(getConfig().server.base_url);
  const https = protocol === 'https:';
  // browsers treat http://localhost as secure, so Secure + SameSite=None works there too
  // (needed for cross-origin clients like the Android app's tauri.localhost webview)
  const secure = https || hostname === 'localhost';

  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    partitioned: https,
    path: '/',
    maxAge,
  };
}

export async function hashSecret(secret: string): Promise<Buffer> {
  const secretBytes = new TextEncoder().encode(secret);
  const secretHashBuffer = await crypto.subtle.digest('SHA-256', secretBytes);
  return Buffer.from(secretHashBuffer);
}

export function parseSessionToken(token: string): SessionTokenParts | null {
  const [sessionId, sessionSecret, ...extraParts] = token.split('.');
  if (!sessionId || !sessionSecret || extraParts.length > 0) {
    return null;
  }

  return { sessionId, sessionSecret };
}

function isSessionExpired(session: Session, now = new Date()): boolean {
  return now >= session.expiresAt;
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

export type Session = typeof sessions.$inferSelect;
export type User = typeof users.$inferSelect;
export type SessionWithUser = Session & { user: User };

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
    sameSite: 'lax' | 'none';
    partitioned: boolean;
    path: '/';
    maxAge: number;
  };
}
