// Port of apps/frontend/src/lib/notification-settings.svelte.ts
import { create } from 'zustand';
import {
  effectiveLevel,
  type NotificationEntries,
  type NotificationLevel,
} from 'anchor/notification-level';
import { anchor } from './anchor';

type Target = { channelId: string; guildId: string | null };

// "until I turn it back on"
const forever = '9999-12-31T00:00:00.000Z';

type NotificationSettingsState = {
  entries: NotificationEntries;
  load: () => Promise<void>;
  level: (target: Target) => NotificationLevel;
  isMuted: (targetId: string) => boolean;
  showsUnread: (target: Target) => boolean;
  showsMentions: (target: Target) => boolean;
  set: (
    targetId: string,
    change: { level?: NotificationLevel; mutedUntil?: string | null },
    defaultLevel: NotificationLevel
  ) => Promise<void>;
  mute: (targetId: string, hours: number | null, defaultLevel: NotificationLevel) => Promise<void>;
  unmute: (targetId: string, defaultLevel: NotificationLevel) => Promise<void>;
  reset: (targetId: string) => Promise<void>;
  savePreferences: (preferences: { push?: boolean; messagePreview?: boolean }) => Promise<void>;
};

export const useNotificationSettings = create<NotificationSettingsState>((set, get) => ({
  entries: {},

  async load() {
    const result = await anchor().client.notifications.settings.get();
    if (result.error || !result.data) return;

    set({
      entries: Object.fromEntries(result.data.settings.map((item) => [item.targetId, item])),
    });
  },

  level: (target) => effectiveLevel(get().entries, target),

  // a timed mute: hides the unread dot and silences notifications, but mention badges stay.
  isMuted(targetId) {
    const until = get().entries[targetId]?.mutedUntil;
    return !!until && new Date(until).getTime() > Date.now();
  },

  // unread dots are hidden when muted or set to nothing...
  showsUnread: (target) => get().level(target) !== 'NONE',

  // ...but mention badges only disappear for "nothing", not for a plain mute.
  showsMentions: (target) =>
    get().level(target) !== 'NONE' ||
    get().isMuted(target.channelId) ||
    (!!target.guildId && get().isMuted(target.guildId)),

  async set(targetId, change, defaultLevel) {
    const current = get().entries[targetId];
    const next = {
      level: change.level ?? current?.level ?? defaultLevel,
      mutedUntil:
        change.mutedUntil === undefined ? (current?.mutedUntil ?? null) : change.mutedUntil,
    };
    const previous = get().entries;
    set({ entries: { ...previous, [targetId]: next } });

    const result = await anchor()
      .client.notifications.settings({ targetId: encodeURIComponent(targetId) })
      .put({
        ...next,
        mutedUntil: next.mutedUntil ? new Date(next.mutedUntil).toISOString() : null,
      });
    if (result.error) set({ entries: previous });
  },

  mute: (targetId, hours, defaultLevel) =>
    get().set(
      targetId,
      { mutedUntil: hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : forever },
      defaultLevel
    ),

  unmute: (targetId, defaultLevel) => get().set(targetId, { mutedUntil: null }, defaultLevel),

  async reset(targetId) {
    const previous = get().entries;
    const { [targetId]: _, ...rest } = previous;
    set({ entries: rest });

    const result = await anchor()
      .client.notifications.settings({ targetId: encodeURIComponent(targetId) })
      .delete();
    if (result.error) set({ entries: previous });
  },

  // push is decided on the server, so these two are mirrored there
  async savePreferences(preferences) {
    await anchor()
      .client.notifications.preferences.put(preferences)
      .catch(() => null);
  },
}));

// Same name as on the web, for code that runs outside React: `notificationSettings().load()`
export const notificationSettings = useNotificationSettings.getState;
