export interface LaunchPrefs {
  autoLaunch: boolean;
  startHidden: boolean;
  /** Download updates in the background and install them when Novarum quits. */
  autoUpdate: boolean;
}

export interface UpdateCheck {
  status: 'available' | 'current' | 'unsupported' | 'error';
  version?: string;
}

export interface ElectronAPI {
  getAudioDevices(): Promise<MediaDeviceInfo[]>;
  getLaunchPrefs(): Promise<LaunchPrefs>;
  setLaunchPrefs(prefs: Partial<LaunchPrefs>): Promise<LaunchPrefs>;
  checkForUpdates(): Promise<UpdateCheck>;
  getVersion(): Promise<string>;
  /** Sets the dock / launcher unread badge; 0 clears it. */
  setBadgeCount(count: number): Promise<void>;
  /** `process.platform` from the main process, e.g. 'linux' | 'darwin' | 'win32'. */
  platform: string;
  venmic: {
    /** Whether the linux system-audio virtual mic (pipewire) is usable on this machine. */
    isAvailable(): Promise<boolean>;
    /** Routes system audio into the "vencord-screen-share" virtual mic. Returns false on failure. */
    link(): Promise<boolean>;
    unlink(): Promise<void>;
  };
}
