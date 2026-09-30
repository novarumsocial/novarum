import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, users } from '../src/db';
import { discoverRemoteAnchor, federationRequestTimeoutMs } from './discovery';
import { publicUser, publicUserSchema, userProfile } from './publicUser';
import { randomString } from './randomString';

export const federationUserSchema = publicUserSchema.omit({ userId: true });
export type FederationUserPayload = z.infer<typeof federationUserSchema>;

export function federationUserPayload(session: { user: Parameters<typeof publicUser>[0] }) {
  const { userId: _, ...user } = publicUser(session.user);
  return { ...user, homeserver: user.homeserver.toLowerCase() };
}

export async function fetchFederatedUser(homeserver: string, username: string) {
  const expectedHomeserver = homeserver.toLowerCase();
  const remote = await discoverRemoteAnchor(expectedHomeserver);
  const url = new URL(`/federation/users/${encodeURIComponent(username)}`, remote.baseUrl);
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(federationRequestTimeoutMs),
  });
  if (!response.ok) return null;

  const result = z.object({ user: federationUserSchema }).safeParse(await response.json());
  if (
    !result.success ||
    result.data.user.username !== username ||
    result.data.user.homeserver.toLowerCase() !== expectedHomeserver
  ) {
    return null;
  }
  return { ...result.data.user, homeserver: expectedHomeserver };
}

export async function upsertFederatedUser(input: FederationUserPayload) {
  const now = new Date();
  const userInput = { ...input, homeserver: input.homeserver.toLowerCase() };
  const [existing] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.username, userInput.username),
        sql`lower(${users.homeserver}) = ${userInput.homeserver}`
      )
    )
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(users)
      .set({ ...userProfile(userInput), updatedAt: now })
      .where(eq(users.id, existing.id))
      .returning();
    if (!updated) throw new Error('Could not update federated user');
    return updated;
  }

  const [user] = await db
    .insert(users)
    .values({
      id: randomString(),
      ...userInput,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [users.username, users.homeserver],
      set: { ...userProfile(userInput), updatedAt: now },
    })
    .returning();

  if (!user) throw new Error('Could not upsert federated user');
  return user;
}
