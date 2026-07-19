type Settings = {
  pushNotifications: boolean;
  messagePreview: boolean;
  mentionSound: boolean;
  showOnlineStatus: boolean;
  compactMode: boolean;
  showMemberList: boolean;
  circleIcons: boolean;
  noiseCancellation: boolean;
  noiseCancellationLevel: number;
};

const defaults: Settings = {
  pushNotifications: false,
  messagePreview: true,
  mentionSound: true,
  showOnlineStatus: true,
  compactMode: false,
  showMemberList: true,
  circleIcons: false,
  noiseCancellation: true,
  noiseCancellationLevel: 60,
};

function load(): Settings {
  if (typeof localStorage === 'undefined') return { ...defaults };
  try {
    const raw = localStorage.getItem('settings');
    const value = raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
    return {
      ...value,
      pushNotifications:
        value.pushNotifications &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted',
    };
  } catch {
    return { ...defaults };
  }
}

class SettingsStore {
  value = $state<Settings>(load());

  constructor() {
    $effect.root(() => {
      $effect(() => {
        localStorage.setItem('settings', JSON.stringify(this.value));
      });
    });
  }
}

export const settings = new SettingsStore();
