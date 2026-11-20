import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { messageCursorSchema } from '../../../utils/messageCursor';
import { maxSearchQueryLength, parseSearchQuery } from '../../../utils/messageSearch';
import {
  allowSearch,
  defaultSearchPageSize,
  isEmptySearch,
  maxSearchPageSize,
  searchMessages,
  searchResponseSchema,
} from '../../message/search';
import { getFederatedChannelAccess, getFederatedGuildAccess } from '../access';
import { federationAuth } from '../plugin';
import { federationErrors } from '../schemas';

const searchBodySchema = z.object({
  q: z.string().max(maxSearchQueryLength),
  cursor: messageCursorSchema,
  limit: z.number().int().min(1).max(maxSearchPageSize).default(defaultSearchPageSize),
});

const response = {
  200: searchResponseSchema,
  ...federationErrors,
  403: genericResponseErrorSchema,
  404: genericResponseErrorSchema,
  429: genericResponseErrorSchema,
};

function parseSearch(payload: unknown) {
  const body = searchBodySchema.safeParse(payload);
  if (!body.success) return { ok: false as const, error: 'Invalid search' };
  const parsed = parseSearchQuery(body.data.q);
  if (!parsed.ok) return parsed;
  if (isEmptySearch(parsed.query)) return { ok: false as const, error: 'Nothing to search for' };
  return { ok: true as const, ...body.data, query: parsed.query };
}

// Remote users searching a guild or channel we host. Access is checked here, never by their homeserver.
export const search = new Elysia()
  .use(federationAuth)
  .post(
    '/channels/:id/messages/search',
    async ({ params, payload, remoteUser, status }) => {
      const body = parseSearch(payload);
      if (!body.ok) return status(400, { error: body.error });
      const access = await getFederatedChannelAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      if (!allowSearch(access.user.id)) return status(429, { error: 'Too many searches' });

      return searchMessages([access.channel.id], body.query, body.cursor, body.limit);
    },
    { federatedUser: true, response }
  )
  .post(
    '/guilds/:id/messages/search',
    async ({ params, payload, remoteUser, status }) => {
      const body = parseSearch(payload);
      if (!body.ok) return status(400, { error: body.error });
      const access = await getFederatedGuildAccess(params.id, remoteUser);
      if (!access.ok) return status(access.status, { error: access.error });
      if (!allowSearch(access.user.id)) return status(429, { error: 'Too many searches' });

      const channels = await db.query.channels.findMany({ where: { guildId: access.guild.id } });
      return searchMessages(
        channels.map((channel) => channel.id),
        body.query,
        body.cursor,
        body.limit
      );
    },
    { federatedUser: true, response }
  );
