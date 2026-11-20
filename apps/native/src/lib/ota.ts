// Port of apps/frontend/src/lib/ota.ts: ship JS fixes without a store release (Hot Updater instead of Capgo)
import { HotUpdater, insights } from '@hot-updater/react-native';

export const hotUpdater = HotUpdater.init({
  baseURL: 'https://novarum-hot-updater.sr-izan.workers.dev',
  // baked in at bundle time; CI sets it from the HOT_UPDATER_API_KEY secret
  requestHeaders: { 'x-api-key': process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY ?? '' },
  plugins: [insights()],
  onError: (error) => console.error('Hot Updater:', error),
});

// CI deploys each PR branch to a channel with this name (.github/workflows/native-development-release.yml)
export const branchChannel = (branch: string) =>
  branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// checks the current channel (the build's, or the branch switched to), and also applies rollbacks
export async function checkForUpdates(channel?: string) {
  if (__DEV__) return false;
  const update = await hotUpdater.checkForUpdate({ updateStrategy: 'fingerprint', channel });
  // a just-applied bundle can be offered once more before its first launch is confirmed
  if (!update || update.id === hotUpdater.getBundleId()) return false;
  if (!(await update.updateBundle())) throw new Error('Could not download the update');
  await hotUpdater.reload();
  return true;
}

export async function resetChannel() {
  if (await hotUpdater.resetChannel()) await hotUpdater.reload();
}
