export interface LaunchPrefs {
  autoLaunch: boolean;
  startHidden: boolean;
}

export interface ElectronAPI {
  getAudioDevices(): Promise<MediaDeviceInfo[]>;
  getLaunchPrefs(): Promise<LaunchPrefs>;
  setLaunchPrefs(prefs: Partial<LaunchPrefs>): Promise<LaunchPrefs>;
  getVersion(): Promise<string>;
}
