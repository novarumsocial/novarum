import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db, friendRelationships, users } from '../../src/db';
import { getConfig } from '../../utils/config';
import { postSignedFederationJson } from '../../utils/discovery';
import {
  federationUserPayload,
  federationUserSchema,
  upsertFederatedUser,
} from '../../utils/federationPayload';
import { friendStatusSchema } from '../../src/db/zod';

export const friendActionSchema = z.enum(['REQUEST', 'ACCEPT', 'DECLINE', 'CANCEL', 'REMOVE']);
export type FriendAction = z.infer<typeof friendActionSchema>;

export type FriendStatus = z.infer<typeof friendStatusSchema>;

export const friendIdentitySchema = z.object({
  username: z.string().min(2).max(32),
  homeserver: z.string().min(1).max(255),
});

export const friendCommandSchema = z.object({
  commandId: z.string().min(1).max(128),
  actor: federationUserSchema,
  peerUsername: z.string().min(2).max(32),
  action: friendActionSchema,
  expectedVersion: z.number().int().nonnegative(),
});

export const friendSnapshotSchema = z.object({
  commandId: z.string().min(1).max(128).nullable(),
  remoteUser: federationUserSchema,
  localUsername: z.string().min(2).max(32),
  requestedBy: friendIdentitySchema,
  status: friendStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
});

export type FriendSnapshot = z.infer<typeof friendSnapshotSchema>;
export type User = typeof users.$inferSelect;
export type FriendRelationship = typeof friendRelationships.$inferSelect;

type TransitionResult =
  | { ok: true; relationship: FriendRelationship; changed: boolean }
  | { ok: false; status: 400 | 409; error: string; relationship?: FriendRelationship };

export function friendAuthority(firstHomeserver: string, secondHomeserver: string) {
  return [firstHomeserver.toLowerCase(), secondHomeserver.toLowerCase()].sort()[0]!;
}

export async function findFriendship(firstUserId: string, secondUserId: string) {
  const [userOneId, userTwoId] = orderedPair(firstUserId, secondUserId);
  return db.query.friendRelationships.findFirst({ where: { userOneId, userTwoId } });
}

export async function transitionFriendship(
  firstUser: User,
  secondUser: User,
  actorId: string,
  action: FriendAction,
  expectedVersion: number,
  syncPending: boolean,
  commandId: string
): Promise<TransitionResult> {
  if (firstUser.id === secondUser.id) {
    return { ok: false, status: 400, error: 'You cannot add yourself as a friend.' };
  }
  if (actorId !== firstUser.id && actorId !== secondUser.id) {
    return { ok: false, status: 400, error: 'Invalid friendship actor.' };
  }

  const [userOneId, userTwoId] = orderedPair(firstUser.id, secondUser.id);

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.query.friendRelationships.findFirst({
      where: { userOneId, userTwoId },
    });

    if (existing?.lastCommandId === commandId) {
      return { ok: true, relationship: existing, changed: false };
    }

    if ((existing?.version ?? 0) !== expectedVersion) {
      return {
        ok: false,
        status: 409,
        error: 'Friendship changed. Please try again.',
        relationship: existing,
      };
    }

    const next = nextFriendshipState(existing, actorId, action);
    if (!next.ok) return next;
    if (!next.changed && existing) return { ok: true, relationship: existing, changed: false };

    const now = new Date();
    if (!existing) {
      const [inserted] = await db
        .insert(friendRelationships)
        .values({
          userOneId,
          userTwoId,
          requestedById: actorId,
          status: next.status,
          syncPending,
          version: 1,
          lastCommandId: commandId,
          createdAt: now,
          updatedAt: now,
          acceptedAt: next.status === 'ACCEPTED' ? now : null,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return { ok: true, relationship: inserted, changed: true };
      continue;
    }

    const [updated] = await db
      .update(friendRelationships)
      .set({
        status: next.status,
        requestedById: next.requestedById ?? existing.requestedById,
        syncPending,
        version: existing.version + 1,
        lastCommandId: commandId,
        updatedAt: now,
        acceptedAt: next.status === 'ACCEPTED' ? now : null,
      })
      .where(
        and(
          eq(friendRelationships.userOneId, userOneId),
          eq(friendRelationships.userTwoId, userTwoId),
          eq(friendRelationships.version, existing.version)
        )
      )
      .returning();
    if (updated) return { ok: true, relationship: updated, changed: true };
  }

  return { ok: false, status: 409, error: 'Friendship changed. Please try again.' };
}

export function snapshotFor(
  relationship: FriendRelationship,
  sender: User,
  recipient: User,
  requestedBy: User
): FriendSnapshot {
  return {
    commandId: relationship.lastCommandId,
    remoteUser: federationUserPayload({ user: sender }),
    localUsername: recipient.username,
    requestedBy: {
      username: requestedBy.username,
      homeserver: requestedBy.homeserver,
    },
    status: friendStatusSchema.parse(relationship.status),
    version: relationship.version,
    createdAt: relationship.createdAt.toISOString(),
    updatedAt: relationship.updatedAt.toISOString(),
    acceptedAt: relationship.acceptedAt?.toISOString() ?? null,
  };
}

export async function applyFriendSnapshot(
  localUser: User,
  snapshot: FriendSnapshot,
  localAcceptanceCommandId?: string
) {
  const localHomeserver = getConfig().server.homeserver;
  if (
    localUser.username !== snapshot.localUsername ||
    localUser.homeserver.toLowerCase() !== localHomeserver.toLowerCase()
  ) {
    return { ok: false as const, status: 400 as const, error: 'Invalid local friend identity.' };
  }

  const remoteUser = await upsertFederatedUser(snapshot.remoteUser);
  const requestedById =
    snapshot.requestedBy.username === localUser.username &&
    snapshot.requestedBy.homeserver.toLowerCase() === localUser.homeserver.toLowerCase()
      ? localUser.id
      : snapshot.requestedBy.username === remoteUser.username &&
          snapshot.requestedBy.homeserver.toLowerCase() === remoteUser.homeserver.toLowerCase()
        ? remoteUser.id
        : null;
  if (!requestedById) {
    return { ok: false as const, status: 400 as const, error: 'Invalid friendship requester.' };
  }

  const [userOneId, userTwoId] = orderedPair(localUser.id, remoteUser.id);
  const values = {
    requestedById,
    status: snapshot.status,
    syncPending: false,
    version: snapshot.version,
    lastCommandId: snapshot.commandId,
    acceptCommandId: null,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
    acceptedAt: snapshot.acceptedAt ? new Date(snapshot.acceptedAt) : null,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.query.friendRelationships.findFirst({
      where: { userOneId, userTwoId },
    });
    if (
      snapshot.status === 'ACCEPTED' &&
      !(
        snapshot.commandId &&
        (existing?.acceptCommandId === snapshot.commandId ||
          localAcceptanceCommandId === snapshot.commandId)
      ) &&
      (!existing ||
        existing.status === 'NONE' ||
        (existing.status === 'PENDING' &&
          existing.requestedById === remoteUser.id &&
          existing.lastCommandId !== snapshot.commandId))
    ) {
      return {
        ok: false as const,
        status: 403 as const,
        error: 'The remote homeserver cannot accept a request for a local user.',
      };
    }
    if (existing && existing.version > snapshot.version) {
      return { ok: true as const, relationship: existing, changed: false };
    }
    if (existing?.version === snapshot.version) {
      const same = existing.status === snapshot.status && existing.requestedById === requestedById;
      return same
        ? { ok: true as const, relationship: existing, changed: false }
        : { ok: false as const, status: 409 as const, error: 'Conflicting friendship state.' };
    }

    if (!existing) {
      const [inserted] = await db
        .insert(friendRelationships)
        .values({ userOneId, userTwoId, ...values })
        .onConflictDoNothing()
        .returning();
      if (inserted) return { ok: true as const, relationship: inserted, changed: true };
      continue;
    }

    const [updated] = await db
      .update(friendRelationships)
      .set(values)
      .where(
        and(
          eq(friendRelationships.userOneId, userOneId),
          eq(friendRelationships.userTwoId, userTwoId),
          lt(friendRelationships.version, snapshot.version)
        )
      )
      .returning();
    if (updated) return { ok: true as const, relationship: updated, changed: true };
  }

  return { ok: false as const, status: 409 as const, error: 'Could not apply friendship state.' };
}

export async function syncFriendship(relationship: FriendRelationship) {
  const [userOne, userTwo, requestedBy] = await Promise.all([
    db.query.users.findFirst({ where: { id: relationship.userOneId } }),
    db.query.users.findFirst({ where: { id: relationship.userTwoId } }),
    db.query.users.findFirst({ where: { id: relationship.requestedById } }),
  ]);
  if (!userOne || !userTwo || !requestedBy) return false;

  const localHomeserver = getConfig().server.homeserver;
  const sender = userOne.homeserver === localHomeserver ? userOne : userTwo;
  const recipient = sender.id === userOne.id ? userTwo : userOne;
  if (
    sender.homeserver !== localHomeserver ||
    recipient.homeserver === localHomeserver ||
    friendAuthority(sender.homeserver, recipient.homeserver) !== localHomeserver.toLowerCase()
  ) {
    return false;
  }

  const result = await postSignedFederationJson(
    recipient.homeserver,
    '/federation/friends/sync',
    snapshotFor(relationship, sender, recipient, requestedBy)
  ).catch(() => null);
  if (!result?.response.ok) return false;

  await db
    .update(friendRelationships)
    .set({ syncPending: false })
    .where(
      and(
        eq(friendRelationships.userOneId, relationship.userOneId),
        eq(friendRelationships.userTwoId, relationship.userTwoId),
        eq(friendRelationships.version, relationship.version)
      )
    );
  return true;
}

export async function retryPendingFriendSyncs(userId?: string) {
  const pending = await db.query.friendRelationships.findMany({
    where: userId
      ? {
          syncPending: true,
          OR: [{ userOneId: userId }, { userTwoId: userId }],
        }
      : { syncPending: true },
  });
  await Promise.allSettled(pending.map(syncFriendship));
}

export async function rememberFriendCommand(
  relationship: FriendRelationship,
  commandId: string,
  canAccept: boolean
) {
  await db
    .update(friendRelationships)
    .set({
      lastCommandId: commandId,
      acceptCommandId: canAccept ? commandId : null,
    })
    .where(
      and(
        eq(friendRelationships.userOneId, relationship.userOneId),
        eq(friendRelationships.userTwoId, relationship.userTwoId),
        eq(friendRelationships.version, relationship.version)
      )
    );
}

function orderedPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

export function nextFriendshipState(
  existing: Pick<FriendRelationship, 'status' | 'requestedById'> | undefined,
  actorId: string,
  action: FriendAction
):
  | { ok: true; changed: boolean; status: FriendStatus; requestedById?: string }
  | { ok: false; status: 400; error: string } {
  const current = (existing?.status ?? 'NONE') as FriendStatus;

  if (action === 'REQUEST') {
    if (current === 'NONE') {
      return { ok: true, changed: true, status: 'PENDING', requestedById: actorId };
    }
    if (current === 'PENDING' && existing?.requestedById !== actorId) {
      return { ok: true, changed: true, status: 'ACCEPTED' };
    }
    return { ok: true, changed: false, status: current };
  }

  if (!existing || current === 'NONE') {
    return { ok: true, changed: false, status: 'NONE' };
  }
  if (action === 'ACCEPT') {
    if (current === 'ACCEPTED') return { ok: true, changed: false, status: current };
    if (existing.requestedById === actorId) {
      return { ok: false, status: 400, error: 'You cannot accept your own friend request.' };
    }
    return { ok: true, changed: true, status: 'ACCEPTED' };
  }
  if (action === 'DECLINE') {
    if (current !== 'PENDING' || existing.requestedById === actorId) {
      return { ok: false, status: 400, error: 'Only the recipient can decline this request.' };
    }
    return { ok: true, changed: true, status: 'NONE' };
  }
  if (action === 'CANCEL') {
    if (current !== 'PENDING' || existing.requestedById !== actorId) {
      return { ok: false, status: 400, error: 'Only the requester can cancel this request.' };
    }
    return { ok: true, changed: true, status: 'NONE' };
  }
  if (current !== 'ACCEPTED') {
    return { ok: false, status: 400, error: 'No friendship found to remove.' };
  }
  return { ok: true, changed: true, status: 'NONE' };
}
