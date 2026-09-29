export interface ElectronAPI {
  getAudioDevices(): Promise<MediaDeviceInfo[]>;
  getVersion(): Promise<string>;
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
