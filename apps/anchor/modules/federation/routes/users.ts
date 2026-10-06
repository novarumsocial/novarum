import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import { getConfig } from '../../../utils/config';
import { federationUserSchema } from '../../../utils/federationPayload';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { publicUser } from '../../../utils/publicUser';

// the one unsigned route: anyone can look up the profile of one of our users
export const users = new Elysia().get(
  '/users/:username',
  async ({ params, status }) => {
    const { username } = params;
    if (!username) return status(400, { error: 'Missing username' });

    const user = await db.query.users.findFirst({
      where: { username, homeserver: getConfig().server.homeserver },
    });
    if (!user) return status(404, { error: 'User not found' });

    // the userId is local to this homeserver, so it stays here
    const { userId: _, ...profile } = publicUser(user);
    return { user: { ...profile, handle: `@${user.username}:${user.homeserver}` } };
  },
  {
    response: {
      200: z.object({ user: federationUserSchema.extend({ handle: z.string() }) }),
      400: genericResponseErrorSchema,
      404: genericResponseErrorSchema,
    },
  }
);
