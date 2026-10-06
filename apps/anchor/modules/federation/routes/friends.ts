import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import { getConfig } from '../../../utils/config';
import { upsertFederatedUser } from '../../../utils/federationPayload';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { publishRealtime } from '../../../utils/publishRealtime';
import {
  applyFriendSnapshot,
  friendAuthority,
  friendCommandSchema,
  friendSnapshotSchema,
  snapshotFor,
  syncFriendship,
  transitionFriendship,
} from '../../friends/model';
import { federationAuth } from '../plugin';
import { federationErrors } from '../schemas';

const friendCommandErrorSchema = z.object({
  error: z.string(),
  snapshot: friendSnapshotSchema.optional(),
});

// A friendship between users of two homeservers is owned by one of them (see friendAuthority).
// The other one sends it commands, and the owner sends back snapshots to keep it in sync.
export const friends = new Elysia()
  .use(federationAuth)
  .post(
    '/friends/command',
    async ({ payload, origin, server, status }) => {
      const parsed = friendCommandSchema.safeParse(payload);
      if (!parsed.success) return status(400, { error: 'Invalid friendship command.' });

      const command = parsed.data;
      const localHomeserver = getConfig().server.homeserver;
      if (
        command.actor.homeserver.toLowerCase() !== origin.homeserver.toLowerCase() ||
        command.actor.isBot
      ) {
        return status(403, { error: 'Friend actor does not belong to the sending homeserver.' });
      }
      if (friendAuthority(origin.homeserver, localHomeserver) !== localHomeserver.toLowerCase()) {
        return status(400, { error: 'This homeserver is not authoritative for this friendship.' });
      }

      const peer = await db.query.users.findFirst({
        where: { username: command.peerUsername, homeserver: localHomeserver },
      });
      if (!peer || peer.isBot) return status(404, { error: 'User not found.' });

      const actor = await upsertFederatedUser(command.actor);
      const result = await transitionFriendship(
        actor,
        peer,
        actor.id,
        command.action,
        command.expectedVersion,
        true,
        command.commandId
      );
      // a refused command without a relationship has nothing to report back
      if (!result.ok && !result.relationship) return status(result.status, { error: result.error });
      // accepted commands always come with their relationship; refusals without one returned above
      const relationship = result.relationship!;

      const requestedBy = await db.query.users.findFirst({
        where: { id: relationship.requestedById },
      });
      if (!requestedBy) return status(500, { error: 'Friendship requester not found.' });

      // even when the command is refused the sender gets our snapshot, so it can catch up
      const snapshot = snapshotFor(relationship, peer, actor, requestedBy);
      if (!result.ok) return status(result.status, { error: result.error, snapshot });

      if (result.changed && server) {
        publishRealtime(server, `userEvents:${peer.id}`, { type: 'friends.changed', data: {} });
      }
      await syncFriendship(relationship);

      return { snapshot };
    },
    {
      federated: true,
      response: {
        200: z.object({ snapshot: friendSnapshotSchema }),
        ...federationErrors,
        400: friendCommandErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: friendCommandErrorSchema,
        500: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/friends/sync',
    async ({ payload, origin, server, status }) => {
      const parsed = friendSnapshotSchema.safeParse(payload);
      if (!parsed.success) return status(400, { error: 'Invalid friendship snapshot.' });

      const snapshot = parsed.data;
      const localHomeserver = getConfig().server.homeserver;
      // only the homeserver that owns the friendship may push its state to us
      if (
        snapshot.remoteUser.homeserver.toLowerCase() !== origin.homeserver.toLowerCase() ||
        friendAuthority(origin.homeserver, localHomeserver) !== origin.homeserver.toLowerCase()
      ) {
        return status(403, { error: 'Invalid friendship authority.' });
      }

      const localUser = await db.query.users.findFirst({
        where: { username: snapshot.localUsername, homeserver: localHomeserver },
      });
      if (!localUser || localUser.isBot) return status(404, { error: 'User not found.' });

      const result = await applyFriendSnapshot(localUser, snapshot);
      if (!result.ok) return status(result.status, { error: result.error });

      if (result.changed && server) {
        publishRealtime(server, `userEvents:${localUser.id}`, {
          type: 'friends.changed',
          data: {},
        });
      }
      return { version: result.relationship.version };
    },
    {
      federated: true,
      response: {
        200: z.object({ version: friendSnapshotSchema.shape.version }),
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  );
