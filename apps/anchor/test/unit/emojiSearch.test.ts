import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mockDb, restoreDb } from '../harness/mockDb';

// emojiSearch loads the whole emoji table from the db on the first search and caches it, so the
// db is stubbed here. The real-table variant (seeded Postgres) belongs to the L2 tests.
const names = [
  'smile',
  'smiley',
  'smirk',
  'grinning',
  'grin',
  'heart',
  'heart_eyes',
  'broken_heart',
  'thumbsup',
  'cat',
  'cat2',
  'dog',
  'fire',
  'white_check_mark',
];
const rows = names.map((name) => ({
  name,
  unicode: `u-${name}`,
  url: `https://e.test/${name}.png`,
}));
let searchEmojis: typeof import('../../utils/emojiSearch').searchEmojis;
let loads = 0;

beforeAll(async () => {
  mockDb({
    query: {
      emojis: {
        findMany: async () => {
          loads++;
          return rows;
        },
      },
    },
  });
  ({ searchEmojis } = await import('../../utils/emojiSearch'));
});
afterAll(restoreDb);

const search = async (q: string, limit?: number) =>
  (await searchEmojis(q, limit)).map((e) => e.name);

describe('searchEmojis', () => {
  test('blank queries return nothing', async () => {
    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
    expect(await search('_-_')).toEqual([]);
  });

  test('returns full rows', async () => {
    expect(await searchEmojis('fire')).toEqual([
      { name: 'fire', unicode: 'u-fire', url: 'https://e.test/fire.png' },
    ]);
  });

  test('exact match is ranked before partial ones', async () => {
    expect((await search('cat'))[0]).toBe('cat');
    expect((await search('heart'))[0]).toBe('heart');
    expect((await search('grin'))[0]).toBe('grin');
  });

  test('prefix matches are found', async () => {
    const r = await search('smi');
    expect(r).toEqual(expect.arrayContaining(['smile', 'smiley', 'smirk']));
    expect(r).not.toContain('dog');
  });

  test('underscores and dashes in the query are treated as spaces', async () => {
    expect((await search('broken_heart'))[0]).toBe('broken_heart');
    expect((await search('broken-heart'))[0]).toBe('broken_heart');
    expect(await search('white check')).toContain('white_check_mark');
  });

  test('case and surrounding whitespace do not matter', async () => {
    expect(await search('  CAT ')).toEqual(await search('cat'));
  });

  test('pinned: terms must appear in name order (no out-of-order matching)', async () => {
    expect(await search('heart broken')).toEqual([]);
  });

  test('no match is an empty list', async () => {
    expect(await search('zzzzqqq')).toEqual([]);
  });

  test('limit is honoured', async () => {
    expect((await search('s', 2)).length).toBeLessThanOrEqual(2);
    expect(await search('cat', 1)).toHaveLength(1);
  });

  test('the table is loaded once and cached', async () => {
    await search('dog');
    await search('fire');
    expect(loads).toBe(1);
  });
});
