// Chat markdown: parses to a small tree instead of HTML, so the renderers only ever create elements and text.
// Nothing in a message can become markup, and links are limited to http(s). apps/native/src/lib/markdown.ts is a port; markdown.test.ts runs against both.
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; children: Inline[] }
  | { type: 'link'; url: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

const spans = [
  ['**', 'bold'],
  ['__', 'underline'],
  ['~~', 'strike'],
  ['||', 'spoiler'],
  ['*', 'italic'],
  ['_', 'italic'],
] as const;
const word = /[\p{L}\p{N}]/u;
const urlAt = /https?:\/\/[^\s]+/y;
const linkAt = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y;
const plainAt = /[^\\`*_~|[h]+/y;
const codeAt = /(`{1,3})([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const listItem = /^\s*([-*+]|\d{1,9}[.)]) +(.*)$/;

// where a span whose content starts at `from` closes, or -1. Single `*`/`_` skip doubled runs, and `_` needs word edges (snake_case)
function closing(src: string, delimiter: string, from: number) {
  for (
    let end = src.indexOf(delimiter, from + 1);
    end !== -1;
    end = src.indexOf(delimiter, end + 1)
  ) {
    if (/\s/.test(src[end - 1]) || src[end + delimiter.length] === delimiter[0]) continue;
    if (delimiter.length === 1 && src[end - 1] === delimiter) continue;
    if (delimiter === '_' && word.test(src[end + 1] ?? '')) continue;
    return end;
  }
  return -1;
}

// nesting is capped so a wall of `*` can't recurse thousands deep
export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  // a delimiter with no valid closer won't find one further on either, so it's never searched again (linear time)
  const unclosed = new Set<string>();
  let text = '';
  const push = (node: Inline) => {
    if (text) out.push({ type: 'text', text });
    text = '';
    out.push(node);
  };

  for (let i = 0; i < src.length;) {
    const char = src[i];
    if (char === '\\' && /[\\`*_~|[\]()#>.+-]/.test(src[i + 1] ?? '')) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    plainAt.lastIndex = i;
    const plain = plainAt.exec(src);
    if (plain) {
      text += plain[0];
      i += plain[0].length;
      continue;
    }

    // bare urls stay text (the text renderer links them) so `_` or `*` inside them isn't formatting
    for (const pattern of [urlAt, linkAt, codeAt]) pattern.lastIndex = i;
    const match =
      (char === 'h' && urlAt.exec(src)) ||
      (char === '[' && linkAt.exec(src)) ||
      (char === '`' && !unclosed.has('`') && codeAt.exec(src));
    if (char === '`' && !match) unclosed.add('`');
    if (match) {
      if (char === 'h') text += match[0];
      else if (char === '[')
        push({ type: 'link', url: match[2], children: parseInline(match[1], depth + 1) });
      else push({ type: 'code', text: match[2] });
      i += match[0].length;
      continue;
    }

    const span = spans.find(([delimiter]) => src.startsWith(delimiter, i));
    const after = src[i + (span?.[0].length ?? 0)];
    const opens =
      depth < 6 &&
      span &&
      after &&
      !/\s/.test(after) &&
      !(span[0] === '_' && word.test(src[i - 1] ?? ''));
    const end = opens && !unclosed.has(span[0]) ? closing(src, span[0], i + span[0].length) : -1;
    if (opens && end === -1) unclosed.add(span[0]);
    if (span && end !== -1) {
      push({ type: span[1], children: parseInline(src.slice(i + span[0].length, end), depth + 1) });
      i = end + span[0].length;
      continue;
    }

    text += char;
    i++;
  }

  if (text) out.push({ type: 'text', text });
  return out;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join('\n').replace(/^\n+|\n+$/g, '');
    if (text) blocks.push({ type: 'paragraph', children: parseInline(text) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```[\w+#.-]*\s*$/.test(line)
      ? lines.findIndex((next, index) => index > i && next.trim() === '```')
      : -1;
    const heading = /^(#{1,3}) +(.+)$/.exec(line);

    if (fence !== -1) {
      flush();
      blocks.push({ type: 'code', text: lines.slice(i + 1, fence).join('\n') });
      i = fence;
    } else if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
    } else if (/^>( |$)/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^>( |$)/.test(lines[i]); i++)
        quoted.push(lines[i].replace(/^> ?/, ''));
      blocks.push({ type: 'quote', children: parseBlocks(quoted) });
      i--;
    } else if (listItem.test(line)) {
      flush();
      const first = listItem.exec(line)![1];
      const ordered = /\d/.test(first);
      const items: Inline[][] = [];
      for (
        let item;
        i < lines.length && (item = listItem.exec(lines[i])) && /\d/.test(item[1]) === ordered;
        i++
      )
        items.push(parseInline(item[2]));
      blocks.push({ type: 'list', ordered, start: ordered ? parseInt(first) : 1, items });
      i--;
    } else {
      paragraph.push(line);
    }
  }

  flush();
  return blocks;
}

// messages re-render often (typing, reactions, scrolling), so parsed trees are cached by content
const cache = new Map<string, Block[]>();

export function parseMarkdown(src: string): Block[] {
  let blocks = cache.get(src);
  if (!blocks) {
    blocks = parseBlocks(src.split('\n'));
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(src, blocks);
  }
  return blocks;
}
