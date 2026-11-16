import { describe, expect, test } from 'bun:test';
import { messagePreview, previewLength } from '../../utils/messagePreview';

describe('messagePreview', () => {
  test('empty and whitespace-only content has no preview', () => {
    expect(messagePreview(null)).toBeNull();
    expect(messagePreview('')).toBeNull();
    expect(messagePreview(' \n\t ')).toBeNull();
  });

  test('whitespace collapses onto one line', () => {
    expect(messagePreview('  hello\n\n  world  ')).toBe('hello world');
  });

  test('long content is cut by characters and ends with an ellipsis', () => {
    expect(messagePreview('a'.repeat(previewLength))).toBe('a'.repeat(previewLength));
    expect(messagePreview('a'.repeat(previewLength + 1))).toBe(`${'a'.repeat(previewLength - 1)}…`);
    expect(Array.from(messagePreview('🐟'.repeat(500))!)).toHaveLength(previewLength);
  });
});
