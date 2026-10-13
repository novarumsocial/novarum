// The chat is a stack: the hub (servers, channels and DMs) at the bottom and every channel, call or the
// friends list pushed on top. It is the JS stack, not the native one, so the screen below stays drawn and
// <SwipeBack> can drag the top one away to show it (Android's native stack has no swipe back at all).
// An incoming call sits above every screen (the bar of the call you are in is part of ScreenHeader).
import {
  CardStyleInterpolators,
  Stack,
  type StackCardStyleInterpolator,
} from 'expo-router/js-stack';
import { View } from 'react-native';
import { CallRinging } from '@/components/call-ringing';
import { SwipeBack } from '@/components/swipe-back';
import { pathSegments } from '@/lib/chat-state';
import { dmPath } from '@/lib/dms';
import { goto, instantChats } from '@/lib/navigation';
import { useThemeColors } from '@/lib/theme';
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

export default function GuildsLayout() {
  const colors = useThemeColors();

  return (
    <View className="flex-1 bg-background">
      <Stack
        screenLayout={({ route, children }) =>
          route.name === 'index' || route.name === 'members' ? (
            children
          ) : (
            <SwipeBack>{children}</SwipeBack>
          )
        }
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
        <Stack.Screen
          name="[server]/[...rest]"
          {...singularChannel}
          options={({ route }: { route: { params?: object } }) =>
            instantChats.has(channelKey(route.params as Record<string, unknown>))
              ? { animation: 'none' }
              : {}
          }
        />
        <Stack.Screen
          name="members"
          options={{
            presentation: 'modal',
            cardStyleInterpolator: CardStyleInterpolators.forModalPresentationIOS,
            gestureEnabled: true,
            headerShown: true,
            title: 'Members',
            // the same color as the list under it
            headerStyle: { backgroundColor: colors.sidebar },
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
