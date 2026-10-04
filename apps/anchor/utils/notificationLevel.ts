// shared by the backend (push) and the frontend (in-app notifications and unread dots) so
// both always agree on whether something should notify.
export type NotificationLevel = 'ALL' | 'MENTIONS' | 'NONE';
export type NotificationEntry = { level: NotificationLevel; mutedUntil?: Date | string | null };
export type NotificationEntries = Record<string, NotificationEntry | undefined>;

const entryLevel = (entry: NotificationEntry | undefined, now: number) =>
  !entry
    ? null
    : entry.mutedUntil && new Date(entry.mutedUntil).getTime() > now
      ? 'NONE'
      : entry.level;

// the channel's setting wins, then the guild's, then the default: everything in a DM,
// only mentions in a guild.
export function effectiveLevel(
  entries: NotificationEntries,
  target: { channelId: string; guildId: string | null },
  now = Date.now()
): NotificationLevel {
  return (
    entryLevel(entries[target.channelId], now) ??
    (target.guildId ? entryLevel(entries[target.guildId], now) : null) ??
    (target.guildId ? 'MENTIONS' : 'ALL')
  );
}

// a DM message counts as a mention, since it is always addressed to you.
export function levelAllows(level: NotificationLevel, mentioned: boolean) {
  return level === 'ALL' || (level === 'MENTIONS' && mentioned);
}
