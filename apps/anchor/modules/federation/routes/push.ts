import Elysia from 'elysia';
import { z } from 'zod';
import { db } from '../../../src/db';
import { getConfig } from '../../../utils/config';
import { makeFederatedChannelId, makeFederatedGuildId } from '../../../utils/federationIds';
import { genericResponseErrorSchema } from '../../../utils/genericResponseError';
import { maxSnippetLength, notifyLocal } from '../../../utils/notify';
import { federationAuth } from '../plugin';
import { federationErrors, okResponseSchema } from '../schemas';

// text only: the receiving end shows it as plain text, never as html
const pushBodySchema = z.object({
  guildId: z.string().min(1).nullable(),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  author: z.object({
    username: z.string().min(1).max(64),
    displayName: z.string().max(64).nullable(),
    homeserver: z.string().min(1).max(255),
    avatarUrl: z.url().nullable(),
  }),
  snippet: z
    .string()
    .nullable()
    .transform((snippet) => snippet?.slice(0, maxSnippetLength) ?? null),
  handles: z.array(z.string().max(300)).min(1).max(1000),
});

// A fixed window per sending homeserver, so one noisy server can't flood our push services.
// Windows live in memory only, so a restart gives everyone a fresh one.
const maxPushesPerMinute = 600;
const windowMs = 60_000;
const pushWindows = new Map<string, { start: number; count: number }>();

function allowPush(homeserver: string) {
  const now = Date.now();
  // forget old windows now and then so the map can't grow forever
  if (pushWindows.size > 1000) {
    for (const [name, old] of pushWindows) if (now - old.start > windowMs) pushWindows.delete(name);
  }

  const window = pushWindows.get(homeserver);
  if (!window || now - window.start > windowMs) {
    pushWindows.set(homeserver, { start: now, count: 1 });
    return true;
  }
  return ++window.count <= maxPushesPerMinute;
}

export const push = new Elysia().use(federationAuth).post(
  '/push',
  async ({ payload, origin, status }) => {
    if (!allowPush(origin.homeserver)) return status(429, { error: 'Too many pushes' });

    const input = pushBodySchema.safeParse(payload);
    if (!input.success) return status(400, { error: 'Invalid push' });

    // the ids are rebuilt from the sender's homeserver, so a server can only ever push
    // for its own guilds and DMs
    const guildId =
      input.data.guildId && makeFederatedGuildId(origin.homeserver, input.data.guildId);
    const channelId = makeFederatedChannelId(origin.homeserver, input.data.channelId);

    // handles look like @username:homeserver; only the ones of our own users matter
    const localHomeserver = getConfig().server.homeserver;
    const usernames = input.data.handles.flatMap((handle) => {
      const [, username, homeserver] = handle.match(/^@([^:]+):(.+)$/) ?? [];
      return username && homeserver?.toLowerCase() === localHomeserver.toLowerCase()
        ? [username]
        : [];
    });
    if (!usernames.length) return { ok: true };

    const localUsers = await db.query.users.findMany({
      where: { username: { in: usernames }, homeserver: localHomeserver },
    });
    const userIds = localUsers.map((user) => user.id);

    // anything that is not a local member of that guild or DM is silently dropped
    const members = guildId
      ? await db.query.guildMembers.findMany({ where: { guildId, userId: { in: userIds } } })
      : await db.query.channelMembers.findMany({ where: { channelId, userId: { in: userIds } } });

    await notifyLocal(
      members.map((member) => member.userId),
      {
        guildId,
        channelId,
        messageId: input.data.messageId,
        author: input.data.author,
        snippet: input.data.snippet,
      }
    );

    return { ok: true };
  },
  {
    federated: true,
    response: {
      200: okResponseSchema,
      ...federationErrors,
      404: genericResponseErrorSchema,
      429: genericResponseErrorSchema,
    },
  }
);
