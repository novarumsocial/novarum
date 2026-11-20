export const previewLength = 140;

// a one-line taste of a message for lists, cut by characters so emoji are never split in half
export function messagePreview(content: string | null) {
  const chars = Array.from(content?.replace(/\s+/g, ' ').trim() ?? '');
  if (!chars.length) return null;
  return chars.length > previewLength
    ? `${chars.slice(0, previewLength - 1).join('')}…`
    : chars.join('');
}
