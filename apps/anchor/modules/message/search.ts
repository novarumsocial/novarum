import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { attachments, db, users } from '../../src/db';
import { attachmentResponseSchema, messageResponseBaseSchema } from '../../src/db/zod';
import { messagePayload } from '../../utils/messagePayload';
import { publicUserSchema } from '../../utils/publicUser';
import { encodeMessageCursor } from '../../utils/messageCursor';
import { rateLimiter } from '../../utils/rateLimit';
import type { SearchQuery } from '../../utils/messageSearch';

export const maxSearchPageSize = 50;
export const defaultSearchPageSize = 25;
export const maxSearchesPerMinute = 60;
export const allowSearch = rateLimiter(maxSearchesPerMinute);

export const searchResultSchema = messageResponseBaseSchema.extend({
  guildId: z.string().nullable(),
  channelName: z.string(),
  pingedHandles: z.array(z.string()),
  attachments: z.array(attachmentResponseSchema),
  author: publicUserSchema,
});
export const searchResponseSchema = z.object({
  messages: z.array(searchResultSchema).max(maxSearchPageSize),
  nextCursor: z.string().nullable(),
});

// every word of the text has to start a word of the message. The words are cut up by Postgres
// itself and quoted into the tsquery, so nothing the user types is read as tsquery syntax.
const matchesText = (content: unknown, text: string) =>
  sql`to_tsvector('simple', coalesce(${content}, '')) @@ (
    select to_tsquery('simple', string_agg('''' || replace(replace(word, '\\', '\\\\'), '''', '''''') || ''':*', ' & '))
    from unnest(tsvector_to_array(to_tsvector('simple', ${text}))) word
  )`;

async function authorIds(from: SearchQuery['from']) {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        ...from.map(({ username, homeserver }) =>
          and(
            eq(sql`lower(${users.username})`, username),
            homeserver ? eq(users.homeserver, homeserver) : undefined
          )
        )
      )
    );
  return found.map((user) => user.id);
}

/** One page of the messages in `channelIds` matching `query`, newest first. */
export async function searchMessages(
  channelIds: string[],
  query: SearchQuery,
  cursor: { createdAt: Date; id: string } | null | undefined,
  limit: number
) {
  const authors = query.from.length ? await authorIds(query.from) : null;
  if (!channelIds.length || authors?.length === 0) return { messages: [], nextCursor: null };

  const has = new Set(query.has);
  const found = await db.query.messages.findMany({
    where: {
      channelId: { in: channelIds },
      deletedAt: { isNull: true },
      ...(authors ? { authorId: { in: authors } } : {}),
      RAW: (message) =>
        and(
          query.text ? matchesText(message.content, query.text) : undefined,
          has.has('link') ? sql`${message.content} ~* 'https?://'` : undefined,
          has.has('attachment') || has.has('image')
            ? sql`exists (select 1 from ${attachments} where ${attachments.messageId} = ${message.id}
                ${has.has('image') ? sql`and ${attachments.contentType} like 'image/%'` : sql``})`
            : undefined,
          query.before ? lt(message.createdAt, query.before) : undefined,
          query.after ? gte(message.createdAt, query.after) : undefined,
          cursor
            ? or(
                lt(message.createdAt, cursor.createdAt),
                and(eq(message.createdAt, cursor.createdAt), lt(message.id, cursor.id))
              )
            : undefined
        ) ?? sql`true`,
    },
    orderBy: { createdAt: 'desc', id: 'desc' },
    with: { author: true, attachments: true, channel: true },
    limit: limit + 1,
  });

  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    messages: page.map((message) => ({
      ...messagePayload(message, message.channel, message.author),
      channelName: message.channel.name,
    })),
    nextCursor: found.length > limit && last ? encodeMessageCursor(last) : null,
  };
}

export const isEmptySearch = (query: SearchQuery) =>
  !query.text && !query.from.length && !query.has.length && !query.before && !query.after;
