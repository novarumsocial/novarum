import { getNotificationPermission, notificationsSupported } from './notifications';

export type TimeFormat = 'auto' | '12hr' | '24hr';
export type NoiseSuppressionModel = 'deepfilternet' | 'rnnoise';
export type ColorPalette = 'light' | 'dark-v2' | 'dark-classic';

export const noiseModelLabels: Record<NoiseSuppressionModel, string> = {
  deepfilternet: 'DeepFilterNet 3',
  rnnoise: 'RNNoise',
};

type Settings = {
  pushNotifications: boolean;
  messagePreview: boolean;
  mentionSound: boolean;
  showOnlineStatus: boolean;
  compactMode: boolean;
  showMemberList: boolean;
  circleIcons: boolean;
  roundedBorders: boolean;
  colorPalette: ColorPalette;
  noiseCancellation: boolean;
  noiseSuppressionModel: NoiseSuppressionModel;
  noiseSuppressionLevel: number;
  noiseSuppressionAuto: boolean;
  voiceEchoCancellation: boolean;
  voiceAutoGainControl: boolean;
  voiceInputDeviceId: string;
  voiceOutputDeviceId: string;
  videoInputDeviceId: string;
  screenShareSystemAudio: boolean;
  othersCallSounds: boolean;
  notificationVolume?: number;
  timeFormat: TimeFormat;
  language: string;
};

const defaults: Settings = {
  // the desktop app is allowed to notify out of the box (apps/electron/src/main.ts grants it)
  pushNotifications: typeof window !== 'undefined' && !!window.electron,
  messagePreview: true,
  mentionSound: true,
  showOnlineStatus: true,
  compactMode: false,
  showMemberList: true,
  circleIcons: false,
  roundedBorders: false,
  colorPalette: 'dark-classic',
  noiseCancellation: true,
  noiseSuppressionModel: 'deepfilternet',
  noiseSuppressionLevel: 30,
  noiseSuppressionAuto: true,
  voiceEchoCancellation: true,
  voiceAutoGainControl: true,
  voiceInputDeviceId: 'default',
  voiceOutputDeviceId: 'default',
  videoInputDeviceId: 'default',
  screenShareSystemAudio: true,
  othersCallSounds: true,
  notificationVolume: 0.5,
  timeFormat: 'auto',
  language: 'en',
};

async function load(): Promise<Settings> {
  if (typeof localStorage === 'undefined') return { ...defaults };
  try {
    const raw = localStorage.getItem('settings');
    const stored: Partial<Settings> & { darkMode?: boolean } = raw ? JSON.parse(raw) : {};
    if (stored.colorPalette === undefined && stored.darkMode !== undefined) {
      stored.colorPalette = stored.darkMode ? 'dark-classic' : 'light';
    }
    const value = { ...defaults, ...stored };
    return {
      ...value,
      pushNotifications:
        value.pushNotifications &&
        // phones have no Notification api; their permission is asked natively when registering
        (!notificationsSupported() || (await getNotificationPermission()) === 'granted'),
    };
  } catch {
    return { ...defaults };
  }
}

class SettingsStore {
  value = $state<Settings>({ ...defaults });
  constructor() {
    if (typeof localStorage === 'undefined') return;
    void load().then((value) => {
      this.value = value;
      $effect.root(() => {
        $effect(() => {
          localStorage.setItem('settings', JSON.stringify(this.value));
        });
      });
    });
  }
}

export const settings = new SettingsStore();

export const settingsDialog = $state({ open: false });
