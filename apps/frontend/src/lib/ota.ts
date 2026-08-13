import { CapacitorUpdater } from '@capgo/capacitor-updater';

const MANIFEST_URL = 'https://mobile.novarum.me/updates.json';

export async function checkForUpdates() {
  await CapacitorUpdater.notifyAppReady();
  try {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) return;
    const manifest = await response.json();
    const { version } = (await CapacitorUpdater.current()).bundle;

    if (manifest.version === version) return;

    const bundle = await CapacitorUpdater.download({
      url: manifest.url,
      version: manifest.version,
      checksum: manifest.checksum,
    });
    await CapacitorUpdater.set({ id: bundle.id });
  } catch (error) {
    console.error('Error checking for updates:', error);
  }
}
