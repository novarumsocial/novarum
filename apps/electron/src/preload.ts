import { contextBridge, ipcRenderer } from 'electron';
// i know this is jank but it's a type so it gets removed on compilation and runtime
import type { ElectronAPI } from '../../frontend/src/lib/electron-api';

window.addEventListener('DOMContentLoaded', () => {
  let frame = 0;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${red}, ${green}, ${blue}, ${(alpha ?? 255) / 255})`;
  };
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const style = getComputedStyle(document.documentElement);
      ipcRenderer.send(
        'titlebar-colors',
        rgba(style.getPropertyValue('--background').trim()),
        rgba(style.getPropertyValue('--foreground').trim())
      );
    });
  };

  new MutationObserver(update).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  new MutationObserver(update).observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  update();
});

const api: ElectronAPI = {
  getAudioDevices: () => ipcRenderer.invoke('voice:get-audio-devices'),
  getLaunchPrefs: () => ipcRenderer.invoke('launch:get'),
  setLaunchPrefs: (prefs) => ipcRenderer.invoke('launch:set', prefs),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event: unknown, status: Parameters<typeof callback>[0]) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.off('update:status', listener);
  },
  appReady: () => ipcRenderer.send('app:ready'),
  getVersion: () => ipcRenderer.invoke('version:get'),
  setBadgeCount: (count) => ipcRenderer.invoke('badge:set', count),
  platform: process.platform,
  behindSplash: process.argv.includes('--behind-splash'),
  venmic: {
    isAvailable: () => ipcRenderer.invoke('venmic:available'),
    link: () => ipcRenderer.invoke('venmic:link'),
    unlink: () => ipcRenderer.invoke('venmic:unlink'),
  },
};

contextBridge.exposeInMainWorld('electron', api);
