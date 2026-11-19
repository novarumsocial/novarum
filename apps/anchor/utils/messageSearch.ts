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

export type SearchSuggestion = { label: string; detail: string; value: string };

const filterHints: SearchSuggestion[] = [
  { label: 'from:', detail: 'user', value: 'from:' },
  { label: 'has:', detail: 'link, image or attachment', value: 'has:' },
  { label: 'before:', detail: 'date', value: 'before:' },
  { label: 'after:', detail: 'date', value: 'after:' },
];
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * What the search box offers for the word being typed (the last one): the filters, then once one is
 * picked, matching members, `has:` values or dates. `value` replaces that word; values ending in a
 * space are complete, the bare filters keep suggesting.
 */
export function searchSuggestions(
  raw: string,
  members: { username: string; server: string; displayName?: string | null }[],
  today = new Date()
): SearchSuggestion[] {
  const word = raw.split(/\s/).at(-1)!.toLowerCase();
  const [, key, value = ''] = /^(from|has|before|after):(.*)$/.exec(word) ?? [];
  if (key === 'from') {
    const typed = value.replace(/^@/, '');
    return members
      .filter((member) =>
        [member.username, member.displayName ?? ''].some((name) =>
          name.toLowerCase().startsWith(typed)
        )
      )
      .slice(0, 8)
      .map((member) => {
        // a username that is on more than one homeserver needs the full handle to pick one
        const shared = members.some(
          (other) => other.username === member.username && other.server !== member.server
        );
        const handle = shared ? `@${member.username}:${member.server}` : member.username;
        return {
          label: member.displayName || member.username,
          detail: handle,
          value: `from:${handle} `,
        };
      });
  }
  if (key === 'has') {
    return hasValues
      .filter((has) => has.startsWith(value))
      .map((has) => ({ label: has, detail: '', value: `has:${has} ` }));
  }
  if (key === 'before' || key === 'after') {
    const days = [
      { detail: 'today', date: today },
      { detail: 'a week ago', date: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) },
    ];
    return days
      .map(({ detail, date }) => ({
        label: isoDay(date),
        detail,
        value: `${key}:${isoDay(date)} `,
      }))
      .filter((day) => day.label.startsWith(value) && day.label !== value);
  }
  return filterHints.filter((hint) => hint.value.startsWith(word) && hint.value !== word);
}

/** `raw` with its last word swapped for a picked suggestion. */
export const applySearchSuggestion = (raw: string, suggestion: SearchSuggestion) =>
  raw.replace(/\S*$/, suggestion.value);

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
