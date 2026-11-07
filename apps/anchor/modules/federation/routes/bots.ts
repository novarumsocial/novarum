import Elysia from 'elysia';
import { z } from 'zod';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { federationUserSchema } from '../../../utils/federationPayload';
import {
  acceptJoin,
  acceptLeave,
  hostAddBot,
  hostRemoveBot,
  publicBotProfile,
  removeMember,
} from '../../bots/membership';
import { getFederatedGuildAccess } from '../access';
import { federationAuth } from '../plugin';
import { federationErrors, successResponseSchema } from '../schemas';

const errors = {
  ...federationErrors,
  403: genericResponseErrorSchema,
  404: genericResponseErrorSchema,
  409: genericResponseErrorSchema,
  502: genericResponseErrorSchema,
};

const addBodySchema = z.object({
  username: z.string().min(1).max(32),
  homeserver: z.string().min(1).max(255),
  role: z.enum(['ADMIN', 'MEMBER']),
  grant: z.string().max(64).optional(),
});

// Bots across homeservers. On the bot's homeserver: its public profile, joining and being taken
// out of remote guilds. On a guild's host: remote people adding and removing bots, and remote
// bots leaving.
export const bots = new Elysia()
  .use(federationAuth)
  .get(
    '/bots/:username',
    async ({ params, status }) =>
      (await publicBotProfile(params.username)) ?? status(404, { error: 'Bot not found' }),
    {
      response: {
        200: z.object({ user: federationUserSchema, public: z.boolean() }),
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/bots/:username/join',
    async ({ params, origin, payload, server, status }) => {
      const joined = await acceptJoin(server, origin.homeserver, params.username, payload);
      if (!joined.ok) return status(joined.status, { error: joined.error });
      return { user: joined.user };
    },
    { federated: true, response: { 200: z.object({ user: federationUserSchema }), ...errors } }
  )
  .post(
    '/bots/:username/leave',
    async ({ params, origin, payload, server, status }) => {
      const body = z.object({ guildId: z.string().min(1) }).safeParse(payload);
      if (!body.success) return status(400, { error: 'Invalid guild' });
      const left = await acceptLeave(server, origin.homeserver, params.username, body.data.guildId);
      if (!left.ok) return status(left.status, { error: left.error });
      return { success: true };
    },
    { federated: true, response: { 200: successResponseSchema, ...errors } }
  )
  .post(
    '/guilds/:id/bots',
    async ({ params, payload, remoteUser, server, status }) => {
      const body = addBodySchema.safeParse(payload);
      if (!body.success) return status(400, { error: 'Invalid bot' });
      const access = await getFederatedGuildAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });

      const { role, grant, ...bot } = body.data;
      const added = await hostAddBot(server, access.guild, access.user.id, bot, role, grant);
      if (!added.ok) return status(added.status, { error: added.error });
      return { success: true };
    },
    { federatedUser: true, response: { 200: successResponseSchema, ...errors } }
  )
  .post(
    '/guilds/:id/bots/remove',
    async ({ params, payload, remoteUser, server, status }) => {
      const body = z.object({ userId: z.string().min(1) }).safeParse(payload);
      if (!body.success) return status(400, { error: 'Invalid bot' });
      const access = await getFederatedGuildAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });

      const removed = await hostRemoveBot(server, access.guild, access.user.id, body.data.userId);
      if (!removed.ok) return status(removed.status, { error: removed.error });
      return { success: true };
    },
    { federatedUser: true, response: { 200: successResponseSchema, ...errors } }
  )
  // one of the remote's bots leaves a guild of ours
  .post(
    '/guilds/:id/bots/leave',
    async ({ params, remoteUser, server, status }) => {
      const access = await getFederatedGuildAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      if (!access.user.isBot) return status(403, { error: 'Only bots can leave this way' });

      await removeMember(server, params.id, access.user);
      return { success: true };
    },
    { federatedUser: true, response: { 200: successResponseSchema, ...errors } }
  );
