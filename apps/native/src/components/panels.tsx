// Native-only: the web's phone layout (swipe right for servers/channels, swipe left for members) with
// native gestures. The center panel follows your finger like Discord. On tablets / landscape the side
// panels sit next to the chat (web breakpoints: md = 768 for the left one, lg = 1024 for the members).
import * as Haptics from 'expo-haptics';
import { useEffect, type ReactNode } from 'react';
import { BackHandler, Pressable, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { usePanels } from '@/lib/panels';

const LEFT_WIDTH = 296; // guild rail w-14 (56) + channel list w-60 (240)
const RIGHT_WIDTH = 224; // member list w-56
const EDGE = 40; // swiping left opens the members only from the right edge, so messages can use swipe-left to reply
const spring = { damping: 24, stiffness: 260, mass: 0.8 };

export function Panels({
  left,
  right,
  children,
}: {
  left: ReactNode;
  right?: ReactNode; // members, only in guilds
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const open = usePanels((s) => s.open);
  const wideLeft = width >= 768;
  const wideRight = width >= 1024;
  const offset = useSharedValue(0);
  const start = useSharedValue(0);
  const fromEdge = useSharedValue(false);

  const leftW = Math.min(LEFT_WIDTH, width - 48);
  const maxLeft = wideLeft ? 0 : leftW; // nothing slides in from the left when it is already on screen
  const hasRight = Boolean(right) && !wideRight;

  useEffect(() => {
    offset.value = withSpring(
      open === 'left' ? maxLeft : open === 'right' ? -RIGHT_WIDTH : 0,
      spring
    );
  }, [open, maxLeft, offset]);

  // Android back button and the iOS edge swipe close an open panel before leaving the screen
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!usePanels.getState().open) return false;
      usePanels.getState().close();
      return true;
    });
    return () => subscription.remove();
  }, []);

  const settle = (side: 'left' | 'right' | null) => {
    if (side && side !== usePanels.getState().open) void Haptics.selectionAsync();
    if (side === 'left') usePanels.getState().openLeft();
    else if (side === 'right') usePanels.getState().openRight();
    else usePanels.getState().close();
  };

  const pan = Gesture.Pan()
    .enabled(!wideLeft || hasRight)
    .activeOffsetX([-14, 14])
    .failOffsetY([-14, 14])
    .onBegin((event) => {
      start.value = offset.value;
      fromEdge.value = event.absoluteX > width - EDGE;
    })
    .onUpdate((event) => {
      const next = start.value + event.translationX;
      const min = hasRight && (start.value < 0 || fromEdge.value) ? -RIGHT_WIDTH : 0;
      offset.value = Math.min(maxLeft, Math.max(min, next));
    })
    .onEnd((event) => {
      const projected = offset.value + event.velocityX * 0.12;
      const side =
        projected > maxLeft / 2 && maxLeft > 0
          ? 'left'
          : projected < -RIGHT_WIDTH / 2
            ? 'right'
            : null;
      offset.value = withSpring(
        side === 'left' ? maxLeft : side === 'right' ? -RIGHT_WIDTH : 0,
        spring
      );
      runOnJS(settle)(side);
    });

  const centerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      Math.abs(offset.value),
      [0, 1, Math.max(maxLeft, RIGHT_WIDTH)],
      [0, 0, 0.6],
      'clamp'
    ),
  }));

  return (
    <View className="flex-1 flex-row overflow-hidden bg-background">
      {wideLeft ? (
        <View className="bg-sidebar" style={{ width: LEFT_WIDTH }}>
          {left}
        </View>
      ) : (
        <View
          className="absolute inset-y-0 left-0 bg-sidebar"
          style={{ width: leftW }}
          importantForAccessibility={open === 'left' ? 'auto' : 'no-hide-descendants'}
          accessibilityElementsHidden={open !== 'left'}
        >
          {left}
        </View>
      )}

      {hasRight && (
        <View className="absolute inset-y-0 right-0 bg-sidebar" style={{ width: RIGHT_WIDTH }}>
          {right}
        </View>
      )}

      <GestureDetector gesture={pan}>
        <Animated.View className="flex-1 bg-background" style={centerStyle}>
          {children}
          {(!wideLeft || hasRight) && (
            <Animated.View
              pointerEvents={open ? 'auto' : 'none'}
              style={scrimStyle}
              className="absolute inset-0 bg-black"
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close panel"
                accessibilityElementsHidden={!open}
                importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
                className="flex-1"
                onPress={() => usePanels.getState().close()}
              />
            </Animated.View>
          )}
        </Animated.View>
      </GestureDetector>

      {wideRight && right && (
        <View className="bg-sidebar" style={{ width: RIGHT_WIDTH }}>
          {right}
        </View>
      )}
    </View>
  );
}
