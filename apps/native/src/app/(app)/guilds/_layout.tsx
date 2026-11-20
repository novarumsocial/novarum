// The chat is a stack: the hub (servers, channels and DMs) at the bottom and every channel, call or the
// friends list pushed on top. It is the JS stack, not the native one, so the screen below stays drawn and
// <SwipeBack> can drag the top one away to show it (Android's native stack has no swipe back at all).
// An incoming call sits above every screen (the bar of the call you are in is part of ScreenHeader).
import { Stack, type StackCardStyleInterpolator } from 'expo-router/js-stack';
import { useIsFocused } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { ModerationSheet } from '@/components/moderation-sheet';
import { CallRinging } from '@/components/call-ringing';
import { SwipeBack } from '@/components/swipe-back';
import { pathSegments } from '@/lib/chat-state';
import { dmPath } from '@/lib/dms';
import { goto } from '@/lib/navigation';
import { startCall } from '@/lib/voice';

// a pushed screen slides in over the one below, which stays put (so a swipe back shows it where it was)
const slideIn: StackCardStyleInterpolator = ({ current, layouts }) => ({
  cardStyle: {
    transform: [
      {
        translateX: current.progress.interpolate({
          inputRange: [0, 1],
          outputRange: [layouts.screen.width, 0],
        }),
      },
    ],
  },
});

// quicker than the stack's default spring, so moving around feels immediate
const quick = { animation: 'timing', config: { duration: 140 } } as const;

// a deep link straight to a channel still gets the hub below it to go back to
export const unstable_settings = { initialRouteName: 'index' };

// opening a channel that is already in the history goes back to it instead of stacking a second copy
// (expo-router handles it for any stack; only the JS stack's Screen type leaves the prop out)
const channelKey = (params: Record<string, unknown> | undefined) =>
  `${params?.server}/${pathSegments.parse(params?.rest)[0]}`;
const singularChannel = {
  dangerouslySingular: (_name: string, params: Record<string, unknown>) => channelKey(params),
};

// the screens below the top one stay drawn, so screen readers would read through to them
function OnlyWhenFocused({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return (
    <View
      style={{ flex: 1 }}
      importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!focused}
    >
      {children}
    </View>
  );
}

export default function GuildsLayout() {
  return (
    <View className="flex-1 bg-background">
      <Stack
        screenLayout={({ route, children }) => (
          <OnlyWhenFocused>
            {route.name === 'index' ? children : <SwipeBack>{children}</SwipeBack>}
          </OnlyWhenFocused>
        )}
        screenOptions={{
          headerShown: false,
          // the stack's own swipe grabs drags in every direction; <SwipeBack> replaces it
          gestureEnabled: false,
          cardStyleInterpolator: slideIn,
          transitionSpec: { open: quick, close: quick },
          // the screen below stays drawn, for the swipe back to show it
          detachPreviousScreen: false,
          // screens further down (earlier channels) stop re-rendering until you go back
          freezeOnBlur: true,
          // see-through: the hub and <SwipeBack> paint their own background, so dragging shows the screen below
          cardStyle: { backgroundColor: 'transparent' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="[server]/[...rest]" {...singularChannel} />
        <Stack.Screen name="members" />
      </Stack>
      <ModerationSheet />
      <CallRinging
        onAccept={(id) => {
          goto(dmPath(id));
          startCall(id);
        }}
      />
    </View>
  );
}
