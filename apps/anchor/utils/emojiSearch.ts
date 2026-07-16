import uFuzzy from '@leeoniya/ufuzzy';
import { db } from '../prisma/db';

const fuzzy = new uFuzzy();
let index: ReturnType<typeof loadIndex> | undefined;

function loadIndex() {
  return db.orm.public.Emoji.all().then((emojis) => ({
    emojis: emojis.map(({ name, unicode, url }) => ({ name, unicode, url })),
    names: emojis.map((emoji) => emoji.name),
  }));
}

export async function searchEmojis(query: string, limit = 50) {
  const needle = query.trim().replaceAll(/[_-]+/g, ' ');
  if (!needle) return [];

  const { emojis, names } = await (index ??= loadIndex());
  const [indices, info, order] = fuzzy.search(names, needle, 0, 10_000);
  if (!indices) return [];

  return (info && order ? order.map((position) => info.idx[position]!) : indices)
    .slice(0, limit)
    .map((position) => emojis[position]!);
}
