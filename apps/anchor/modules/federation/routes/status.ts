import Elysia from 'elysia';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, users } from '../../../src/db';
import { userStatusSchema } from '../../../src/db/zod';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { userProfile } from '../../../utils/publicUser';
import { publishRealtime } from '../../../utils/publishRealtime';
import { getFederatedGuildAccess } from '../access';
import { federationAuth } from '../plugin';
import { federationErrors, okResponseSchema } from '../schemas';

const maxGuildsPerRequest = 1000;

// When someone goes online or offline, every homeserver where they have friends or guilds is told.
// There is a route for each of the two, and one that does both at once (`status-batch`).
const statusError = { error: 'Invalid federation user status' };

type RemoteUser = typeof users.$inferSelect;
type Server = Parameters<typeof publishRealtime>[0];

// tells the friends this homeserver has of a remote user that they went online or offline
async function tellFriends(
  remote: RemoteUser,
  status: 'ONLINE' | 'OFFLINE',
  server: Server | null
) {
  const friendships = await db.query.friendRelationships.findMany({
    where: { status: 'ACCEPTED', OR: [{ userOneId: remote.id }, { userTwoId: remote.id }] },
  });
  if (!server) return;

  for (const { userOneId, userTwoId } of friendships) {
    const friendId = userOneId === remote.id ? userTwoId : userOneId;
    publishRealtime(server, `userEvents:${friendId}`, {
      type: 'user.status.changed',
      data: { userId: remote.id, status },
    });
  }
}

// the remote user as we know them. The match ignores case on purpose: the homeserver name is
// stored the way the remote spelled it.
async function findRemoteUser(username: string, homeserver: string) {
  const [remote] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username), sql`lower(${users.homeserver}) = ${homeserver}`))
    .limit(1);
  return remote;
}

export const userStatus = new Elysia()
  .use(federationAuth)
  // a friend of one of our users went online or offline
  .post(
    '/friends/status',
    async ({ payload, remoteUser, origin, server, status }) => {
      const nextStatus = userStatusSchema.safeParse(payload.status);
      if (!nextStatus.success) return status(400, statusError);

      const remote = await findRemoteUser(remoteUser.username, origin.homeserver);
      if (!remote) return status(404, { error: 'Unknown user' });

      await db.update(users).set({ status: nextStatus.data }).where(eq(users.id, remote.id));
      await tellFriends(remote, nextStatus.data, server);

      return { ok: true };
    },
    {
      federatedUser: true,
      response: { 200: okResponseSchema, ...federationErrors, 404: genericResponseErrorSchema },
    }
  )
  // a member of one of our guilds went online or offline
  .post(
    '/guilds/:id/users/status',
    async ({ params, payload, remoteUser, server, status }) => {
      const nextStatus = userStatusSchema.safeParse(payload.status);
      if (!nextStatus.success) return status(400, statusError);

      const access = await getFederatedGuildAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });

      await db
        .update(users)
        .set({ ...userProfile(remoteUser), status: nextStatus.data, updatedAt: new Date() })
        .where(eq(users.id, access.user.id));

      if (server) {
        publishRealtime(server, `guildEvents:${params.id}`, {
          type: 'user.status.changed',
          data: { userId: access.user.id, status: nextStatus.data },
        });
      }

      return { ok: true };
    },
    {
      federatedUser: true,
      response: {
        200: okResponseSchema,
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  // both of the above in one request: the user went online or offline, for their friends here
  // and for the guilds of ours they are in (`status-batch`)
  .post(
    '/users/status',
    async ({ payload, remoteUser, origin, server, status }) => {
      const body = z
        .object({
          status: userStatusSchema,
          guildIds: z.array(z.string()).max(maxGuildsPerRequest),
        })
        .safeParse(payload);
      if (!body.success) return status(400, statusError);

      const remote = await findRemoteUser(remoteUser.username, origin.homeserver);
      if (!remote) return status(404, { error: 'Unknown user' });

      // guilds the user isn't in are skipped, like their own request would have been refused
      const memberships = await db.query.guildMembers.findMany({
        where: { userId: remote.id, guildId: { in: body.data.guildIds } },
      });

      // being in one of our guilds is what lets a remote update the profile we have of them
      await db
        .update(users)
        .set({
          status: body.data.status,
          ...(memberships.length ? { ...userProfile(remoteUser), updatedAt: new Date() } : {}),
        })
        .where(eq(users.id, remote.id));

      await tellFriends(remote, body.data.status, server);
      if (server) {
        for (const { guildId } of memberships) {
          publishRealtime(server, `guildEvents:${guildId}`, {
            type: 'user.status.changed',
            data: { userId: remote.id, status: body.data.status },
          });
        }
      }

      return { ok: true };
    },
    {
      federatedUser: true,
      response: { 200: okResponseSchema, ...federationErrors, 404: genericResponseErrorSchema },
    }
  );
