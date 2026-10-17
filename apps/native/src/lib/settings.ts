// Port of apps/frontend/src/lib/settings.svelte.ts
import { create } from 'zustand';
import { z } from 'zod';
import { storage } from './storage';

const settingsSchema = z.object({
  pushNotifications: z.boolean().default(false),
  messagePreview: z.boolean().default(true),
  mentionSound: z.boolean().default(true),
  showOnlineStatus: z.boolean().default(true),
  showMemberList: z.boolean().default(true),
  circleIcons: z.boolean().default(false),
  darkMode: z.boolean().default(true),
  noiseCancellation: z.boolean().default(true),
  voiceEchoCancellation: z.boolean().default(false),
  voiceAutoGainControl: z.boolean().default(true),
  notificationVolume: z.number().default(0.5),
  timeFormat: z.enum(['auto', '12hr', '24hr']).default('auto'),
  language: z.string().default('en'),
});

export type Settings = z.infer<typeof settingsSchema>;
export type TimeFormat = Settings['timeFormat'];

const stored = z.string().safeParse(storage.getString('settings'));
const initial = settingsSchema.parse(stored.success ? JSON.parse(stored.data) : {});

type SettingsState = Settings & { update: (patch: Partial<Settings>) => void };

export const useSettings = create<SettingsState>((set) => ({
  ...initial,
  update: (patch) => set(patch),
}));

useSettings.subscribe(({ update, ...value }) => storage.set('settings', JSON.stringify(value)));

// Same name as on the web, for code that runs outside React: `settings().darkMode`
export const settings = useSettings.getState;
