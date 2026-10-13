// The chat is a native stack: the hub (servers, channels and DMs) at the bottom and every channel, call or
// the friends list pushed on top, so the system back gesture and button work like in any phone app.
// An incoming call sits above every screen (the bar of the call you are in is part of ScreenHeader).
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { CallRinging } from '@/components/call-ringing';
import { pathSegments } from '@/lib/chat-state';
import { dmPath } from '@/lib/dms';
import { goto } from '@/lib/navigation';
import { useThemeColors } from '@/lib/theme';
import { startCall } from '@/lib/voice';

// a deep link straight to a channel still gets the hub below it to go back to
export const unstable_settings = { initialRouteName: 'index' };

// opening a channel that is already in the history goes back to it instead of stacking a second copy
const channelKey = (_name: string, params: Record<string, unknown>) =>
  `${params.server}/${pathSegments.parse(params.rest)[0]}`;

export default function GuildsLayout() {
  const colors = useThemeColors();

  return (
    <View className="flex-1 bg-background">
      <Stack
        screenOptions={{
          headerShown: false,
          fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="[server]/[...rest]" dangerouslySingular={channelKey} />
        <Stack.Screen
          name="members"
          options={{
            presentation: 'modal',
            headerShown: true,
            title: 'Members',
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
            headerTitleStyle: { fontFamily: 'IBMPlexSans_600SemiBold', color: colors.foreground },
            headerShadowVisible: false,
          }}
        />
      </Stack>
      <CallRinging
        onAccept={(id) => {
          goto(dmPath(id));
          startCall(id);
        }}
      />
    </View>
  );
}
