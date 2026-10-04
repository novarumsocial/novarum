import { anchor } from './anchor.svelte';
import {
  effectiveLevel,
  type NotificationEntries,
  type NotificationLevel,
} from 'anchor/notification-level';

type Target = { channelId: string; guildId: string | null };

// "until I turn it back on"
const forever = '9999-12-31T00:00:00.000Z';

class NotificationSettingsState {
  entries = $state<NotificationEntries>({});

  async load() {
    const result = await anchor.client.notifications.settings.get();
    if (result.error || !result.data) return;

    this.entries = Object.fromEntries(result.data.settings.map((item: { targetId: string }) => [item.targetId, item]));
  }

  level(target: Target) {
    return effectiveLevel(this.entries, target);
  }

  // a timed mute: hides the unread dot and silences notifications, but mention badges stay.
  isMuted(targetId: string) {
    const until = this.entries[targetId]?.mutedUntil;
    return !!until && new Date(until).getTime() > Date.now();
  }

  // unread dots are hidden when muted or set to nothing...
  showsUnread(target: Target) {
    return this.level(target) !== 'NONE';
  }

  // ...but mention badges only disappear for "nothing", not for a plain mute.
  showsMentions(target: Target) {
    return (
      this.level(target) !== 'NONE' ||
      this.isMuted(target.channelId) ||
      (!!target.guildId && this.isMuted(target.guildId))
    );
  }

  async set(
    targetId: string,
    change: { level?: NotificationLevel; mutedUntil?: string | null },
    defaultLevel: NotificationLevel
  ) {
    const current = this.entries[targetId];
    const next = {
      level: change.level ?? current?.level ?? defaultLevel,
      mutedUntil: change.mutedUntil === undefined ? (current?.mutedUntil ?? null) : change.mutedUntil,
    };
    const previous = this.entries;
    this.entries = { ...this.entries, [targetId]: next };

    const result = await anchor.client.notifications
      .settings({ targetId: encodeURIComponent(targetId) })
      .put({ ...next, mutedUntil: next.mutedUntil ? new Date(next.mutedUntil).toISOString() : null });
    if (result.error) this.entries = previous;
  }

  mute(targetId: string, hours: number | null, defaultLevel: NotificationLevel) {
    return this.set(
      targetId,
      { mutedUntil: hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : forever },
      defaultLevel
    );
  }

  unmute(targetId: string, defaultLevel: NotificationLevel) {
    return this.set(targetId, { mutedUntil: null }, defaultLevel);
  }

  async reset(targetId: string) {
    const previous = this.entries;
    const { [targetId]: _, ...rest } = this.entries;
    this.entries = rest;

    const result = await anchor.client.notifications
      .settings({ targetId: encodeURIComponent(targetId) })
      .delete();
    if (result.error) this.entries = previous;
  }

  // push is decided on the server, so these two are mirrored there
  async savePreferences(preferences: { push?: boolean; messagePreview?: boolean }) {
    await anchor.client.notifications.preferences.put(preferences).catch(() => null);
  }
}

export const notificationSettings = new NotificationSettingsState();
