import Elysia from 'elysia';
import type { Server } from 'elysia/universal';
import { z } from 'zod';
import { db } from '../../src/db';
import { getConfig } from '../../utils/config';
import { postSignedFederationJson } from '../../utils/discovery';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import {
  federationUserPayload,
  fetchFederatedUser,
  upsertFederatedUser,
} from '../../utils/federationPayload';
import { publicUser, publicUserSchema } from '../../utils/publicUser';
import { publishRealtime } from '../../utils/publishRealtime';
import { randomString } from '../../utils/randomString';
import { sessionCookieName, validateSessionToken, type SessionWithUser } from '../auth/provider';
import {
  applyFriendSnapshot,
  findFriendship,
  friendAuthority,
  friendIdentitySchema,
  friendSnapshotSchema,
  rememberFriendCommand,
  retryPendingFriendSyncs,
  syncFriendship,
  transitionFriendship,
  type FriendAction,
  type FriendRelationship,
  type User,
} from './model';
import { friendRelationshipResponseSchema, friendStatusSchema } from '../../src/db/zod';

const federationErrorSchema = z.object({ error: z.string() });
const friendEntrySchema = friendRelationshipResponseSchema
  .pick({ createdAt: true, acceptedAt: true })
  .extend({ user: publicUserSchema });
const friendsResponseSchema = z.object({
  accepted: z.array(friendEntrySchema),
  incoming: z.array(friendEntrySchema),
  outgoing: z.array(friendEntrySchema),
});
const friendMutationResponses = {
  200: friendRelationshipResponseSchema,
  400: genericResponseErrorSchema,
  401: genericResponseErrorSchema,
  403: genericResponseErrorSchema,
  404: genericResponseErrorSchema,
  409: genericResponseErrorSchema,
  502: genericResponseErrorSchema,
};

export const friends = new Elysia({ prefix: '/friends', tags: ['Friends'] })
  .resolve(async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) return status(401, { error: 'Unauthorized' });
    return { session };
  })
  .get(
    '/',
    async ({ session }) => {
      void retryPendingFriendSyncs(session.userId);

      const relationships = await db.query.friendRelationships.findMany({
        where: {
          OR: [{ userOneId: session.userId }, { userTwoId: session.userId }],
        },
        with: { userOne: true, userTwo: true },
      });

      const response = (relationship: (typeof relationships)[number]) => ({
        user: publicUser(
          relationship.userOneId === session.userId ? relationship.userTwo : relationship.userOne
        ),
        createdAt: relationship.createdAt.toISOString(),
        acceptedAt: relationship.acceptedAt?.toISOString() ?? null,
      });

      return {
        accepted: relationships.filter(({ status }) => status === 'ACCEPTED').map(response),
        incoming: relationships
          .filter(
            ({ status, requestedById }) => status === 'PENDING' && requestedById !== session.userId
          )
          .map(response),
        outgoing: relationships
          .filter(
            ({ status, requestedById }) => status === 'PENDING' && requestedById === session.userId
          )
          .map(response),
      };
    },
    {
      response: {
        200: friendsResponseSchema,
        401: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/request',
    async ({ session, body, server, status }) => {
      const homeserver = body.homeserver.toLowerCase();
      const localHomeserver = getConfig().server.homeserver.toLowerCase();

      let target: User | null = null;
      if (homeserver === localHomeserver) {
        const query = await db.query.users.findFirst({
          where: { username: body.username, homeserver: localHomeserver },
        });
        if (query) target = query;
      } else {
        try {
          const remoteUser = await fetchFederatedUser(homeserver, body.username);
          target = remoteUser ? await upsertFederatedUser(remoteUser) : null;
        } catch {
          return status(502, { error: 'Could not reach the remote homeserver.' });
        }
      }

      if (!target || target.isBot) return status(404, { error: 'User not found.' });
      const result = await performFriendAction(session, target, 'REQUEST', server);
      if (!result.ok) return status(result.status, { error: result.error });
      return friendRelationshipResponse(result.relationship);
    },
    {
      body: friendIdentitySchema,
      response: friendMutationResponses,
    }
  )
  .post(
    '/requests/:userId/accept',
    async ({ session, params, server, status }) => {
      const target = await db.query.users.findFirst({ where: { id: params.userId } });
      if (!target) return status(404, { error: 'User not found.' });

      const result = await performFriendAction(session, target, 'ACCEPT', server);
      if (!result.ok) return status(result.status, { error: result.error });
      return friendRelationshipResponse(result.relationship);
    },
    { response: friendMutationResponses }
  )
  .post(
    '/requests/:userId/decline',
    async ({ session, params, server, status }) => {
      const target = await db.query.users.findFirst({ where: { id: params.userId } });
      if (!target) return status(404, { error: 'User not found.' });

      const result = await performFriendAction(session, target, 'DECLINE', server);
      if (!result.ok) return status(result.status, { error: result.error });
      return friendRelationshipResponse(result.relationship);
    },
    { response: friendMutationResponses }
  )
  .delete(
    '/:userId',
    async ({ session, params, server, status }) => {
      const target = await db.query.users.findFirst({ where: { id: params.userId } });
      if (!target) return status(404, { error: 'User not found.' });

      const existing = await findFriendship(session.userId, target.id);
      const action: FriendAction = existing?.status === 'PENDING' ? 'CANCEL' : 'REMOVE';
      const result = await performFriendAction(session, target, action, server);
      if (!result.ok) return status(result.status, { error: result.error });
      return friendRelationshipResponse(result.relationship);
    },
    { response: friendMutationResponses }
  );

function friendRelationshipResponse(relationship: FriendRelationship) {
  return {
    ...relationship,
    status: friendStatusSchema.parse(relationship.status),
    createdAt: relationship.createdAt.toISOString(),
    updatedAt: relationship.updatedAt.toISOString(),
    acceptedAt: relationship.acceptedAt?.toISOString() ?? null,
  };
}

async function performFriendAction(
  session: SessionWithUser,
  target: User,
  action: FriendAction,
  server: Server | null
) {
  const localHomeserver = getConfig().server.homeserver;
  const isRemote = target.homeserver.toLowerCase() !== localHomeserver.toLowerCase();
  const existing = await findFriendship(session.userId, target.id);
  const expectedVersion = existing?.version ?? 0;
  const commandId = randomString();

  if (
    isRemote &&
    friendAuthority(localHomeserver, target.homeserver) !== localHomeserver.toLowerCase()
  ) {
    const canAccept = action === 'REQUEST' || action === 'ACCEPT';
    if (existing) await rememberFriendCommand(existing, commandId, canAccept);
    const remote = await postSignedFederationJson(
      target.homeserver,
      '/federation/friends/command',
      {
        commandId,
        actor: federationUserPayload(session),
        peerUsername: target.username,
        action,
        expectedVersion,
      }
    ).catch(() => null);
    if (!remote) {
      return {
        ok: false as const,
        status: 502 as const,
        error: 'Could not reach the remote homeserver.',
      };
    }

    const snapshot = friendSnapshotSchema.safeParse(
      remote.data && typeof remote.data === 'object' && 'snapshot' in remote.data
        ? remote.data.snapshot
        : null
    );
    if (snapshot.success) {
      if (
        snapshot.data.remoteUser.username !== target.username ||
        snapshot.data.remoteUser.homeserver.toLowerCase() !== target.homeserver.toLowerCase()
      ) {
        return {
          ok: false as const,
          status: 502 as const,
          error: 'The remote homeserver returned the wrong user.',
        };
      }
      const applied = await applyFriendSnapshot(
        session.user,
        snapshot.data,
        canAccept && remote.response.ok ? commandId : undefined
      );
      if (!applied.ok) return applied;
      if (applied.changed && server) notify(server, session.userId);
      if (!remote.response.ok) {
        return {
          ok: false as const,
          status: 409 as const,
          error: federationErrorSchema.safeParse(remote.data).data?.error ?? 'Friendship changed.',
        };
      }
      return { ok: true as const, relationship: applied.relationship };
    }

    return {
      ok: false as const,
      status: remote.response.status === 404 ? (404 as const) : (502 as const),
      error:
        federationErrorSchema.safeParse(remote.data).data?.error ??
        'The remote homeserver returned an invalid response.',
    };
  }

  const result = await transitionFriendship(
    session.user,
    target,
    session.userId,
    action,
    expectedVersion,
    isRemote,
    commandId
  );
  if (!result.ok) return result;

  if (result.changed && server) {
    notify(server, session.userId);
    if (!isRemote) notify(server, target.id);
  }
  if (isRemote) await syncFriendship(result.relationship);

  return result;
}

function notify(server: Server, userId: string) {
  publishRealtime(server, `userEvents:${userId}`, { type: 'friends.changed', data: {} });
}

const syncTimer = setInterval(() => void retryPendingFriendSyncs(), 30_000);
syncTimer.unref();
