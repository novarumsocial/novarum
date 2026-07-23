import { db, emojis as dbEmojis } from '../src/db';

const qualifiedUnicodes = new Map<string, string>();

export function qualifyEmojiUnicode(unicode: string) {
  return qualifiedUnicodes.get(unicode) ?? unicode;
}

export async function writeEmojis() {
  const perf = performance.now();
  const emojis = (await (
    await fetch('https://cdn.jsdelivr.net/npm/emoji-datasource@latest/emoji.json')
  ).json()) as EmojiEntry[];

  for (const emoji of emojis) {
    if (emoji.non_qualified) qualifiedUnicodes.set(emoji.non_qualified, emoji.unified);
  }

  const currentData = await db.query.emojis.findMany({
    columns: { unicode: true },
  });
  const currentUnicodes = new Set(currentData.map((emoji) => emoji.unicode));
  const difference = emojis.filter((emoji) => !currentUnicodes.has(emoji.unified));
  if (difference.length === 0) {
    console.log(`No new emojis to write in ${Math.round(performance.now() - perf)}ms`);
    return;
  }

  const emojiData = difference.map((emoji) => ({
    name: emoji.short_name,
    unicode: emoji.unified,
    url: emoji.has_img_apple
      ? `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@latest/img/apple/64/${emoji.image}`
      : `https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@latest/img/twitter/64/${emoji.image}`,
  }));

  try {
    await db.insert(dbEmojis).values(emojiData);
  } catch (error) {
    const written = new Set(
      (
        await db.query.emojis.findMany({
          columns: { unicode: true },
        })
      ).map((emoji) => emoji.unicode)
    );
    if (difference.some((emoji) => !written.has(emoji.unified))) throw error;
  }
  console.log(`Wrote ${emojiData.length} emojis in ${Math.round(performance.now() - perf)}ms`);
}

type EmojiEntry = {
  name: string;
  unified: string;
  non_qualified: string | null;
  docomo: string | null;
  au: string | null;
  softbank: string | null;
  google: string | null;
  image: string;
  sheet_x: number;
  sheet_y: number;
  short_name: string;
  short_names: string[];
  text: string | null;
  texts: string[] | null;
  category: string;
  subcategory: string;
  sort_order: number;
  added_in: string;
  has_img_apple: boolean;
  has_img_google: boolean;
  has_img_twitter: boolean;
  has_img_facebook: boolean;
};
