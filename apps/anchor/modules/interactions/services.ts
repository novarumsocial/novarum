import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../src/db';
import { requestSession, sessionCookieName, validateSessionToken } from '../auth/provider';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { parseFederatedChannelId, parseFederatedGuildId } from '../../utils/federationIds';
import { callRemote, federationChannelPath, passThrough } from '../../utils/federationClient';
import { guildCommands, startInteraction } from './host';
import { botRespond, expectEphemerals } from './relay';
import {
  callbackSchema,
  guildCommandsSchema,
  interactionInputSchema,
  interactionResultSchema,
  responseMessageSchema,
} from './schemas';

const errors = {
  400: genericResponseErrorSchema,
  401: genericResponseErrorSchema,
  403: genericResponseErrorSchema,
  404: genericResponseErrorSchema,
  429: genericResponseErrorSchema,
  502: genericResponseErrorSchema,
  504: genericResponseErrorSchema,
};

// People using slash commands and buttons. Cookie sessions only: bots don't press buttons.
export const interactions = new Elysia({ tags: ['Bots'] })
  .resolve(async ({ cookie, status }) => {
    const session = await validateSessionToken(
      cookie[sessionCookieName]?.value as string | undefined
    );
    if (!session) return status(401, { error: 'Unauthorized' });
    return { session };
  })
  .get(
    '/guilds/:id/commands',
    async ({ params, session, status }) => {
      if (
        !(await db.query.guildMembers.findFirst({
          where: { guildId: params.id, userId: session.userId },
        }))
      ) {
        return status(404, { error: 'Guild not found' });
      }
      const federatedGuild = parseFederatedGuildId(params.id);
      if (!federatedGuild) return guildCommands(params.id);

      const remote = await callRemote(
        federatedGuild.homeserver,
        `/federation/guilds/${encodeURIComponent(federatedGuild.id)}/commands`,
        session,
        {},
        {
          response: guildCommandsSchema,
          // an older homeserver without bots has no commands to offer
          forward: passThrough(403, 404),
          errors: { failed: 'Remote commands failed', invalid: 'Remote commands were invalid' },
        }
      );
      if (!remote.ok)
        return remote.status === 502 ? { bots: [] } : status(remote.status, remote.error);
      return remote.data;
    },
    { response: { 200: guildCommandsSchema, ...errors } }
  )
  .post(
    '/interactions',
    async ({ body, session, server, status }) => {
      const { channelId, ...input } = body;
      const channel = await db.query.channels.findFirst({ where: { id: channelId } });
      if (!channel) return status(404, { error: 'Channel not found' });

      const federatedChannel = parseFederatedChannelId(channelId);
      if (!federatedChannel) {
        const started = await startInteraction(server, channel, session.user, input);
        if (!started.ok) return status(started.status, { error: started.error });
        return started.result;
      }

      if (
        !(await db.query.guildMembers.findFirst({
          where: { guildId: channel.guildId ?? '', userId: session.userId },
        }))
      ) {
        return status(403, { error: 'Forbidden' });
      }
      // the bot's ephemeral answer can arrive before the host answers this request
      expectEphemerals(session.userId, federatedChannel.homeserver);
      const remote = await callRemote(
        federatedChannel.homeserver,
        federationChannelPath(federatedChannel, 'interactions'),
        session,
        input,
        {
          response: interactionResultSchema,
          forward: passThrough(400, 403, 404, 429, 504),
          errors: {
            failed: 'Remote interaction failed',
            invalid: 'Remote interaction was invalid',
          },
        }
      );
      if (!remote.ok) return status(remote.status, remote.error);
      return remote.data;
    },
    {
      body: z.intersection(
        z.object({ channelId: z.string().min(1).max(512) }),
        interactionInputSchema
      ),
      response: { 200: interactionResultSchema, ...errors },
    }
  );

// Bots answering interactions with the token they were given, like Discord's webhooks.

export const interactionResponses = new Elysia({
  prefix: '/interactions/:id/:token',
  tags: ['Bots'],
})
  .resolve(async ({ cookie, request, status }) => {
    const session = await requestSession(cookie, request);
    if (!session?.user.isBot) return status(401, { error: 'Unauthorized' });
    return { session };
  })
  .post(
    '/callback',
    async ({ params, body, session, server, status }) => {
      const result = await botRespond(server, session.user, params.id, params.token, {
        action: 'callback',
        body,
      });
      if (!result.ok) return status(result.status, { error: result.error });
      return { success: true };
    },
    { body: callbackSchema, response: { 200: z.object({ success: z.boolean() }), ...errors } }
  )
  .patch(
    '/original',
    async ({ params, body, session, server, status }) => {
      const result = await botRespond(server, session.user, params.id, params.token, {
        action: 'edit',
        body,
      });
      if (!result.ok) return status(result.status, { error: result.error });
      return { success: true };
    },
    {
      body: responseMessageSchema,
      response: { 200: z.object({ success: z.boolean() }), ...errors },
    }
  )
  .post(
    '/followup',
    async ({ params, body, session, server, status }) => {
      const result = await botRespond(server, session.user, params.id, params.token, {
        action: 'followup',
        body,
      });
      if (!result.ok) return status(result.status, { error: result.error });
      return { success: true };
    },
    {
      body: responseMessageSchema,
      response: { 200: z.object({ success: z.boolean() }), ...errors },
    }
  );
