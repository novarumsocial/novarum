// Port of the web's settings-dialog.svelte shell: a stack with a native header per tab, styled with the theme
import { Stack } from 'expo-router';
import { useThemeColors } from '@/lib/theme';

export default function SettingsLayout() {
  const colors = useThemeColors();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
        headerTitleStyle: { fontFamily: 'IBMPlexSans_600SemiBold', color: colors.foreground },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="account" options={{ title: 'Account' }} />
      <Stack.Screen name="security" options={{ title: 'Privacy & security' }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="voice" options={{ title: 'Voice & audio' }} />
      <Stack.Screen name="language" options={{ title: 'Language & time' }} />
    </Stack>
  );
}
