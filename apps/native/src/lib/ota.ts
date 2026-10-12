// Port of apps/frontend/src/lib/ota.ts: ship JS fixes without a store release (expo-updates instead of Capgo)
import * as Updates from 'expo-updates';

export async function checkForUpdates() {
  if (__DEV__ || !Updates.isEnabled) return;
  try {
    const update = await Updates.checkForUpdateAsync();
    if (!update.isAvailable) return;
    await Updates.fetchUpdateAsync();
    await Updates.reloadAsync();
  } catch (error) {
    console.error('Error checking for updates:', error);
  }
}
