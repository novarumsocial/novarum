// Port of the web's settings-dialog.svelte shell: a stack with one page per tab, under the same ScreenHeader as
// every other pushed screen
import { Stack } from 'expo-router';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme';

export default function SettingsLayout() {
  const colors = useThemeColors();
  return (
    <Stack
      screenOptions={{
        header: ({ options }) => (
          <ScreenHeader>
            <Text role="heading" numberOfLines={1} className="text-base font-semibold">
              {options.title}
            </Text>
          </ScreenHeader>
        ),
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="account" options={{ title: 'Account' }} />
      <Stack.Screen name="security" options={{ title: 'Privacy & security' }} />
      <Stack.Screen name="devices" options={{ title: 'Devices' }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="voice" options={{ title: 'Voice & audio' }} />
      <Stack.Screen name="language" options={{ title: 'Language & time' }} />
      <Stack.Screen name="updates" options={{ title: 'Updates' }} />
    </Stack>
  );
}
