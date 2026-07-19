type Settings = {
  pushNotifications: boolean;
  messagePreview: boolean;
  mentionSound: boolean;
  showOnlineStatus: boolean;
  compactMode: boolean;
  showMemberList: boolean;
  circleIcons: boolean;
  darkMode: boolean;
};

const defaults: Settings = {
  pushNotifications: true,
  messagePreview: true,
  mentionSound: true,
  showOnlineStatus: true,
  compactMode: false,
  showMemberList: true,
  circleIcons: false,
  darkMode: true,
};

function load(): Settings {
  if (typeof localStorage === 'undefined') return { ...defaults };
  try {
    const raw = localStorage.getItem('settings');
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
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
