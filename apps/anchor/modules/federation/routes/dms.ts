import Elysia from 'elysia';
import { z } from 'zod';
import { dmLatestResponseSchema, dmOpenResponseSchema } from '../../../src/db/zod';
import { db } from '../../../src/db';
import { getConfig } from '../../../utils/config';
import { makeFederatedChannelId } from '../../../utils/federationIds';
import { federationUserSchema, upsertFederatedUser } from '../../../utils/federationPayload';
import { ensureFederatedDmRealtimeBridge } from '../../../utils/federationRealtime';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { publicUser } from '../../../utils/publicUser';
import { publishRealtime } from '../../../utils/publishRealtime';
import { dmResponse, latestMessages, openLocalDm, upsertDmShadow } from '../../dm/services';
import { findFriendship, friendAuthority } from '../../friends/model';
import { federationAuth } from '../plugin';
import { federationErrors, okResponseSchema } from '../schemas';

// Every DM is hosted by one of the two homeservers, the one that sorts first (see friendAuthority).
// The other homeserver keeps a "shadow" copy of the DM and talks to the host about it.
export const dms = new Elysia()
  .use(federationAuth)
  // a remote user opens a DM with one of our users. We host it.
  .post(
    '/dms/open',
    async ({ payload, remoteUser, server, status }) => {
      if (remoteUser.isBot) return status(403, { error: 'Bots cannot open DMs' });

      const peerUsername = z.string().safeParse(payload.peerUsername);
      if (!peerUsername.success) return status(400, { error: 'Invalid peer username' });

      const localHomeserver = getConfig().server.homeserver;
      if (
        friendAuthority(localHomeserver, remoteUser.homeserver) !== localHomeserver.toLowerCase()
      ) {
        return status(400, { error: 'This homeserver is not authoritative for this DM' });
      }

      const target = await db.query.users.findFirst({
        where: { username: peerUsername.data, homeserver: localHomeserver },
      });
      if (!target || target.isBot) return status(404, { error: 'User not found' });

      const actor = await upsertFederatedUser(remoteUser);
      const friendship = await findFriendship(actor.id, target.id);
      if (friendship?.status !== 'ACCEPTED') return status(403, { error: 'Users are not friends' });

      const dm = await openLocalDm(actor.id, target.id);
      if (dm.created && server) {
        publishRealtime(server, `userEvents:${target.id}`, {
          type: 'dm.created',
          data: dmResponse(dm.channel, dm.joinedAt, [actor]),
        });
      }

      return {
        id: dm.channel.id,
        type: dm.channel.type as 'DM' | 'GROUP_DM',
        participants: [publicUser(target), publicUser(actor)],
      };
    },
    {
      federatedUser: true,
      response: {
        200: dmOpenResponseSchema,
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  // the host of a DM tells us about it, so it shows up for our user too
  .post(
    '/dms/notify',
    async ({ payload, origin, server, status }) => {
      // a body that isn't an object has no fields, so every field below counts as missing
      const fields = z.record(z.string(), z.unknown()).catch({}).parse(payload);
      const channelId = z.string().safeParse(fields.channelId);
      if (!channelId.success) return status(400, { error: 'Invalid channel ID' });
      const participants = z.array(federationUserSchema).safeParse(fields.participants);
      if (!participants.success) return status(400, { error: 'Invalid participants' });

      const localHomeserver = getConfig().server.homeserver;
      const local = participants.data.find(
        (p) => p.homeserver.toLowerCase() === localHomeserver.toLowerCase()
      );
      if (!local) return status(400, { error: 'No local participant in this DM' });

      // a DM is between exactly two users: ours and one of the sender's
      const remotes = participants.data.filter((p) => p !== local);
      if (
        participants.data.length !== 2 ||
        remotes.some((p) => p.homeserver.toLowerCase() !== origin.homeserver)
      ) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }
      if (friendAuthority(origin.homeserver, localHomeserver) !== origin.homeserver.toLowerCase()) {
        return status(403, { error: 'This homeserver is not authoritative for this DM' });
      }

      const localUser = await db.query.users.findFirst({
        where: { username: local.username, homeserver: localHomeserver },
      });
      if (!localUser) return status(404, { error: 'User not found' });

      const others = await Promise.all(remotes.map(upsertFederatedUser));
      const friendship = await findFriendship(localUser.id, others[0]!.id);
      if (friendship?.status !== 'ACCEPTED') return status(403, { error: 'Users are not friends' });

      // the ids are rebuilt from the sender's homeserver, so it can only create DMs it hosts
      const shadowId = makeFederatedChannelId(origin.homeserver, channelId.data);
      const membership = await upsertDmShadow(shadowId, localUser.id, [
        localUser.id,
        ...others.map((user) => user.id),
      ]);

      if (server) {
        publishRealtime(server, `userEvents:${localUser.id}`, {
          type: 'dm.created',
          data: dmResponse({ id: shadowId, type: 'DM' }, membership.joinedAt, others),
        });
        void ensureFederatedDmRealtimeBridge(server, shadowId).catch(() => null);
      }

      return { ok: true };
    },
    {
      federated: true,
      response: {
        200: okResponseSchema,
        ...federationErrors,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  // the newest message of each of the user's DMs that we host
  .post(
    '/dms/latest',
    async ({ payload, remoteUser, status }) => {
      const channelIds = z.array(z.string()).max(500).safeParse(payload.channelIds);
      if (!channelIds.success) return status(400, { error: 'Invalid channel IDs' });

      const user = await db.query.users.findFirst({
        where: { username: remoteUser.username, homeserver: remoteUser.homeserver.toLowerCase() },
      });
      if (!user || !channelIds.data.length) return { channels: [] };

      // ids of DMs the user is not in are left out instead of reported as an error
      const memberships = await db.query.channelMembers.findMany({
        where: { userId: user.id, channelId: { in: channelIds.data } },
      });
      const latest = await latestMessages(memberships.map((membership) => membership.channelId));

      return {
        channels: latest.map((message) => ({
          channelId: message.channelId,
          id: message.id,
          createdAt: message.createdAt.toISOString(),
          own: message.authorId === user.id,
        })),
      };
    },
    {
      federatedUser: true,
      response: {
        200: dmLatestResponseSchema,
        ...federationErrors,
        404: genericResponseErrorSchema,
      },
    }
  );
