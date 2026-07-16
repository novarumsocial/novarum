import { db } from '../prisma/db';

export async function writeEmojis() {
  const perf = performance.now();
  const emojis = (await (
    await fetch('https://cdn.jsdelivr.net/npm/emoji-datasource@latest/emoji.json')
  ).json()) as EmojiEntry[];

  const currentData = await db.orm.public.Emoji.all();
  const difference = emojis.filter((emoji) => !currentData.some((e) => e.name === emoji.name));
  if (difference.length === 0) {
    console.log(`No new emojis to write in ${Math.round(performance.now() - perf)}ms`);
    return;
  }

  const dbEmojis = emojis.map((emoji) => ({
    name: emoji.name,
    unicode: emoji.unified,
    url: emoji.has_img_apple
      ? `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@latest/img/apple/64/${emoji.image}`
      : `https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@latest/img/twitter/64/${emoji.image}`,
  }));

  await db.orm.public.Emoji.createAll(dbEmojis);
  console.log(`Wrote ${dbEmojis.length} emojis in ${Math.round(performance.now() - perf)}ms`);
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
