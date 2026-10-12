// Port of apps/frontend/src/lib/components/app-shell.svelte, the boot part (placeholder until Phase 1)
import { Stack } from 'expo-router';

export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
