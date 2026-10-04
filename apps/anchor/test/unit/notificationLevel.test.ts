import { describe, expect, test } from 'bun:test';
import { effectiveLevel, levelAllows } from '../../utils/notificationLevel';

const guild = { channelId: 'c1', guildId: 'g1' };
const dm = { channelId: 'd1', guildId: null };
const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

describe('effectiveLevel', () => {
  test('defaults to everything in a DM and mentions in a guild', () => {
    expect(effectiveLevel({}, dm)).toBe('ALL');
    expect(effectiveLevel({}, guild)).toBe('MENTIONS');
  });

  test('the channel beats the guild, which beats the default', () => {
    expect(effectiveLevel({ g1: { level: 'NONE' } }, guild)).toBe('NONE');
    expect(effectiveLevel({ g1: { level: 'NONE' }, c1: { level: 'ALL' } }, guild)).toBe('ALL');
    expect(effectiveLevel({ g1: { level: 'ALL' } }, dm)).toBe('ALL');
  });

  test('a mute that has not expired means nothing, and an expired one is ignored', () => {
    expect(effectiveLevel({ c1: { level: 'ALL', mutedUntil: future } }, guild)).toBe('NONE');
    expect(effectiveLevel({ c1: { level: 'ALL', mutedUntil: past } }, guild)).toBe('ALL');
    expect(effectiveLevel({ g1: { level: 'ALL', mutedUntil: future }, c1: { level: 'MENTIONS' } }, guild)).toBe('MENTIONS');
  });
});

describe('levelAllows', () => {
  test('ALL always, MENTIONS only for mentions, NONE never', () => {
    expect([true, false].map((mentioned) => levelAllows('ALL', mentioned))).toEqual([true, true]);
    expect([true, false].map((mentioned) => levelAllows('MENTIONS', mentioned))).toEqual([true, false]);
    expect([true, false].map((mentioned) => levelAllows('NONE', mentioned))).toEqual([false, false]);
  });
});
