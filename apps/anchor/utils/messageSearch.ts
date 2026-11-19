import { z } from 'zod';

// The search box syntax, shared with the clients so they highlight the same words the server matched:
// free text plus `from:alice` / `from:@alice:example.com`, `has:attachment|image|link`,
// `before:2026-01-31` and `after:2026-01-01` (whole UTC days, both exclusive).

export const maxSearchQueryLength = 200;
const hasValues = ['attachment', 'image', 'link'] as const;
const filterPattern = /^(from|has|before|after):(.+)$/i;
const dateSchema = z.iso.date();

export type SearchQuery = {
  text: string;
  from: { username: string; homeserver: string | null }[];
  has: (typeof hasValues)[number][];
  before: Date | null;
  after: Date | null;
};

export function parseSearchQuery(raw: string) {
  const query: SearchQuery = { text: '', from: [], has: [], before: null, after: null };
  const words: string[] = [];
  // Postgres can't hold a NUL in text, so it separates words like a space
  for (const token of raw.split(/[\s\0]+/).filter(Boolean)) {
    const [, key, value = ''] = filterPattern.exec(token) ?? [];
    switch (key?.toLowerCase()) {
      case 'from': {
        const [username = '', homeserver] = value.replace(/^@/, '').toLowerCase().split(/:(.*)/);
        if (username) query.from.push({ username, homeserver: homeserver || null });
        break;
      }
      case 'has': {
        const has = z.enum(hasValues).safeParse(value.toLowerCase());
        if (!has.success) return { ok: false as const, error: `Unknown filter has:${value}` };
        query.has.push(has.data);
        break;
      }
      case 'before':
      case 'after': {
        if (!dateSchema.safeParse(value).success) {
          return { ok: false as const, error: `${key}: needs a date like 2026-01-31` };
        }
        const day = new Date(`${value}T00:00:00.000Z`);
        if (key.toLowerCase() === 'before') query.before = day;
        else query.after = new Date(day.getTime() + 24 * 60 * 60 * 1000);
        break;
      }
      default:
        words.push(token);
    }
  }
  query.text = words.join(' ');
  return { ok: true as const, query };
}

/** The words a result is highlighted with: what's left of the query after its filters. */
export const searchWords = (raw: string) =>
  raw
    .split(/\s+/)
    .filter((token) => token && !filterPattern.test(token))
    .flatMap((token) => token.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter(Boolean);

/** `text` cut into pieces, with `match` set on the starts of words that one of `words` begins. */
export function highlightMatches(text: string, words: string[]) {
  const pieces: { text: string; match: boolean }[] = [];
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return [{ text, match: false }];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})`, 'giu');
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > last) pieces.push({ text: text.slice(last, found.index), match: false });
    pieces.push({ text: found[0], match: true });
    last = found.index + found[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), match: false });
  return pieces;
}
