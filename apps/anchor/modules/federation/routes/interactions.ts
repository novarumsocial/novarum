import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import { getConfig } from '../../../utils/config';
import { makeFederatedChannelId, makeFederatedGuildId } from '../../../utils/federationIds';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { commandListSchema } from '../../../utils/botSchemas';
import { groupCommands, guildCommands, startInteraction } from '../../interactions/host';
import { acceptDelivery, acceptEphemeral, acceptRemoteResponse } from '../../interactions/relay';
import {
  guildCommandsSchema,
  interactionInputSchema,
  interactionResultSchema,
  respondActionSchema,
} from '../../interactions/schemas';
import { getFederatedChannelAccess, getFederatedGuildAccess } from '../access';
import { federationAuth } from '../plugin';
import { federationErrors, okResponseSchema, successResponseSchema } from '../schemas';

const errors = {
  ...federationErrors,
  403: genericResponseErrorSchema,
  404: genericResponseErrorSchema,
  429: genericResponseErrorSchema,
  502: genericResponseErrorSchema,
  504: genericResponseErrorSchema,
};

// Slash commands and buttons across homeservers (see modules/interactions).
export const interactions = new Elysia()
  .use(federationAuth)
  // a remote member of one of our guilds wants the commands they can use there
  .post(
    '/guilds/:id/commands',
    async ({ params, remoteUser, status }) => {
      const access = await getFederatedGuildAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      return guildCommands(params.id);
    },
    { federatedUser: true, response: { 200: guildCommandsSchema, ...errors } }
  )
  // a remote member of one of our group DMs wants the commands of the bots in it
  .post(
    '/channels/:id/commands',
    async ({ params, remoteUser, status }) => {
      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      if (access.channel.type !== 'GROUP_DM') return status(404, { error: 'Channel not found' });
      return groupCommands(params.id);
    },
    { federatedUser: true, response: { 200: guildCommandsSchema, ...errors } }
  )
  // a guild or group DM host wants the commands of one of our bots in it
  .post(
    '/bots/:username/commands',
    async ({ params, origin, payload, status }) => {
      const body = z
        .union([
          z.object({ guildId: z.string().min(1) }),
          z.object({ channelId: z.string().min(1) }),
        ])
        .safeParse(payload);
      if (!body.success) return status(400, { error: 'Invalid guild or group' });
      const bot = await db.query.users.findFirst({
        where: {
          username: params.username,
          homeserver: getConfig().server.homeserver,
          isBot: true,
        },
        with: { bot: true },
      });
      const member =
        bot &&
        ('guildId' in body.data
          ? await db.query.guildMembers.findFirst({
              where: {
                guildId: makeFederatedGuildId(origin.homeserver, body.data.guildId),
                userId: bot.id,
              },
            })
          : await db.query.channelMembers.findFirst({
              where: {
                channelId: makeFederatedChannelId(origin.homeserver, body.data.channelId),
                userId: bot.id,
              },
            }));
      if (!bot?.bot || !member) return status(404, { error: 'Bot not found' });
      return { commands: bot.bot.commands };
    },
    { federated: true, response: { 200: z.object({ commands: commandListSchema }), ...errors } }
  )
  // a remote member starts an interaction in one of our channels
  .post(
    '/channels/:id/interactions',
    async ({ params, payload, remoteUser, server, status }) => {
      const input = interactionInputSchema.safeParse(payload);
      if (!input.success) return status(400, { error: 'Invalid interaction' });
      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });

      const started = await startInteraction(server, access.channel, access.user, input.data);
      if (!started.ok) return status(started.status, { error: started.error });
      return started.result;
    },
    { federatedUser: true, response: { 200: interactionResultSchema, ...errors } }
  )
  // the host of a guild tells one of our bots about an interaction
  .post(
    '/interactions',
    async ({ origin, payload, server, status }) => {
      const delivered = await acceptDelivery(server, origin.homeserver, payload);
      if (!delivered.ok) return status(delivered.status, { error: delivered.error });
      return { ok: true };
    },
    { federated: true, response: { 200: okResponseSchema, ...errors } }
  )
  // a remote bot answers an interaction of one of our guilds
  .post(
    '/interactions/:id/respond',
    async ({ params, payload, remoteUser, server, status }) => {
      const body = z
        .intersection(z.object({ token: z.string().min(1).max(128) }), respondActionSchema)
        .safeParse(payload);
      if (!body.success) return status(400, { error: 'Invalid interaction response' });
      const { token, ...action } = body.data;

      const result = await acceptRemoteResponse(server, remoteUser, params.id, token, action);
      if (!result.ok) return status(result.status, { error: result.error });
      return { success: true };
    },
    { federatedUser: true, response: { 200: successResponseSchema, ...errors } }
  )
  // the host of a guild sends one of our people an ephemeral message
  .post(
    '/interactions/ephemeral',
    async ({ origin, payload, server, status }) => {
      const delivered = await acceptEphemeral(server, origin.homeserver, payload);
      if (!delivered.ok) return status(delivered.status, { error: delivered.error });
      return { ok: true };
    },
    { federated: true, response: { 200: okResponseSchema, ...errors } }
  );
