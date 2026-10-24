import { getNotificationPermission, notificationsSupported } from './notifications';

export type TimeFormat = 'auto' | '12hr' | '24hr';
export type NoiseSuppressionModel = 'deepfilternet' | 'rnnoise';

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
  darkMode: boolean;
  noiseCancellation: boolean;
  noiseSuppressionModel: NoiseSuppressionModel;
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
  pushNotifications: false,
  messagePreview: true,
  mentionSound: true,
  showOnlineStatus: true,
  compactMode: false,
  showMemberList: true,
  circleIcons: false,
  roundedBorders: false,
  darkMode: true,
  noiseCancellation: true,
  noiseSuppressionModel: 'deepfilternet',
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
    const value = raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
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
