import { describe, expect, test } from 'bun:test';
import { isMessageAfter } from '../../utils/messageCursor';

const t = '2026-01-01T00:00:00.000Z';

describe('isMessageAfter', () => {
  test('no cursor: everything is after', () => {
    expect(isMessageAfter({ createdAt: t, id: 'a' })).toBe(true);
  });
  test('later createdAt wins regardless of id', () => {
    expect(
      isMessageAfter({ createdAt: '2026-01-01T00:00:00.001Z', id: 'a' }, { createdAt: t, id: 'z' })
    ).toBe(true);
    expect(
      isMessageAfter({ createdAt: '2025-12-31T23:59:59.999Z', id: 'z' }, { createdAt: t, id: 'a' })
    ).toBe(false);
  });
  test('ties on createdAt are broken by id', () => {
    expect(isMessageAfter({ createdAt: t, id: 'b' }, { createdAt: t, id: 'a' })).toBe(true);
    expect(isMessageAfter({ createdAt: t, id: 'a' }, { createdAt: t, id: 'b' })).toBe(false);
  });
  test('the cursor itself is not after itself', () => {
    expect(isMessageAfter({ createdAt: t, id: 'a' }, { createdAt: t, id: 'a' })).toBe(false);
  });
  test('Date and ISO string forms compare equal', () => {
    expect(isMessageAfter({ createdAt: new Date(t), id: 'b' }, { createdAt: t, id: 'a' })).toBe(
      true
    );
    expect(isMessageAfter({ createdAt: t, id: 'a' }, { createdAt: new Date(t), id: 'a' })).toBe(
      false
    );
  });
  test('sorting by the cursor order is total', () => {
    const msgs = [
      { createdAt: t, id: 'c' },
      { createdAt: t, id: 'a' },
      { createdAt: '2026-01-01T00:00:01.000Z', id: 'b' },
    ];
    const sorted = [...msgs].sort((x, y) => (isMessageAfter(x, y) ? 1 : -1));
    expect(sorted.map((m) => m.id)).toEqual(['a', 'c', 'b']);
  });
});
