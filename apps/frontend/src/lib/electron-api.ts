export interface LaunchPrefs {
  autoLaunch: boolean;
  startHidden: boolean;
  /** Download updates in the background and install them when Novarum quits. */
  autoUpdate: boolean;
}

export interface UpdateStatus {
  status:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unsupported';
  version?: string;
  /** Download progress, 0-100. */
  percent?: number;
}

export interface ElectronAPI {
  getAudioDevices(): Promise<MediaDeviceInfo[]>;
  getLaunchPrefs(): Promise<LaunchPrefs>;
  setLaunchPrefs(prefs: Partial<LaunchPrefs>): Promise<LaunchPrefs>;
  checkForUpdates(): Promise<UpdateStatus>;
  getUpdateStatus(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<void>;
  /** Quits Novarum, installs the downloaded update and relaunches. */
  installUpdate(): Promise<void>;
  /** Subscribes to update status changes; returns an unsubscribe function. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  /** Tells the main process the app has booted, so it can swap the launch updater for this window. */
  appReady(): void;
  getVersion(): Promise<string>;
  /** Sets the dock / launcher unread badge; 0 clears it. */
  setBadgeCount(count: number): Promise<void>;
  /**
   * Opens a single sign-on page in its own window and resolves with the app URL the provider
   * finally sends the user back to, or null if the window was closed first.
   */
  signOn(url: string): Promise<string | null>;
  /** `process.platform` from the main process, e.g. 'linux' | 'darwin' | 'win32'. */
  platform: string;
  /** The window boots hidden behind the launch updater, so it has no need for its own loader. */
  behindSplash: boolean;
  venmic: {
    /** Whether the linux system-audio virtual mic (pipewire) is usable on this machine. */
    isAvailable(): Promise<boolean>;
    /** Routes system audio into the "vencord-screen-share" virtual mic. Returns false on failure. */
    link(): Promise<boolean>;
    unlink(): Promise<void>;
  };
}
