import { describe, expect, test } from 'bun:test';
import {
  applySearchSuggestion,
  highlightMatches,
  parseSearchQuery,
  searchSuggestions,
  searchWords,
} from '../../utils/messageSearch';

describe('parseSearchQuery', () => {
  test('splits filters from the text', () => {
    const parsed = parseSearchQuery(
      'deploy  from:Alice from:@bob:Example.com has:LINK after:2026-01-01 before:2026-02-01 notes'
    );
    expect(parsed).toEqual({
      ok: true,
      query: {
        text: 'deploy notes',
        from: [
          { username: 'alice', homeserver: null },
          { username: 'bob', homeserver: 'example.com' },
        ],
        has: ['link'],
        after: new Date('2026-01-02T00:00:00.000Z'),
        before: new Date('2026-02-01T00:00:00.000Z'),
      },
    });
  });

  test('unknown has: values and bad dates are errors', () => {
    expect(parseSearchQuery('has:pony').ok).toBe(false);
    expect(parseSearchQuery('before:soon').ok).toBe(false);
    expect(parseSearchQuery('after:2026-13-01').ok).toBe(false);
  });

  test('a filter word without a value, or an unknown key, is plain text', () => {
    expect(parseSearchQuery('from: http://x.org').ok && parseSearchQuery('from:').ok).toBe(true);
    const parsed = parseSearchQuery('to:bob from:');
    expect(parsed.ok && parsed.query.text).toBe('to:bob from:');
  });

  test('NUL bytes separate words', () => {
    const parsed = parseSearchQuery('a\u0000b');
    expect(parsed.ok && parsed.query.text).toBe('a b');
  });
});

test('searchWords keeps the words to highlight, without filters', () => {
  expect(searchWords("Hello, O'Reilly from:bob has:link café")).toEqual([
    'hello',
    'o',
    'reilly',
    'café',
  ]);
});

test('highlightMatches marks word starts only, case-insensitively, and treats words as plain text', () => {
  expect(highlightMatches('Hello shell, HELp', ['hel'])).toEqual([
    { text: 'Hel', match: true },
    { text: 'lo shell, ', match: false },
    { text: 'HEL', match: true },
    { text: 'p', match: false },
  ]);
  expect(highlightMatches('a.b (c)', ['.', '('])).toEqual([
    { text: 'a.b ', match: false },
    { text: '(', match: true },
    { text: 'c)', match: false },
  ]);
  expect(highlightMatches('plain', [])).toEqual([{ text: 'plain', match: false }]);
});

describe('searchSuggestions', () => {
  const members = [
    { username: 'alice', server: 'a.test', displayName: 'Alice' },
    { username: 'bob', server: 'a.test', displayName: 'Robert' },
    { username: 'bob', server: 'b.test', displayName: null },
  ];
  const values = (raw: string) =>
    searchSuggestions(raw, members, new Date('2026-03-10T12:00:00Z')).map((s) => s.value);

  test('offers the filters for an empty or partial last word, and nothing for plain text', () => {
    expect(values('')).toEqual(['from:', 'has:', 'before:', 'after:']);
    expect(values('deploy ')).toEqual(['from:', 'has:', 'before:', 'after:']);
    expect(values('deploy B')).toEqual(['before:']);
    expect(values('deploy')).toEqual([]);
  });

  test('from: matches usernames and display names, with the full handle when a username repeats', () => {
    expect(values('from:')).toEqual(['from:alice ', 'from:@bob:a.test ', 'from:@bob:b.test ']);
    expect(values('x from:rob')).toEqual(['from:@bob:a.test ']);
    expect(values('from:@AL')).toEqual(['from:alice ']);
  });

  test('has: values and dates', () => {
    expect(values('has:i')).toEqual(['has:image ']);
    expect(values('before:')).toEqual(['before:2026-03-10 ', 'before:2026-03-03 ']);
    expect(values('after:2026-03-0')).toEqual(['after:2026-03-03 ']);
    expect(values('after:2026-03-03')).toEqual([]);
  });

  test('applying a suggestion swaps only the last word', () => {
    expect(applySearchSuggestion('deploy fr', { label: '', detail: '', value: 'from:' })).toBe(
      'deploy from:'
    );
    expect(applySearchSuggestion('a ', { label: '', detail: '', value: 'has:' })).toBe('a has:');
  });
});
