// Native-only: swipe right from anywhere on a pushed screen to go back, with the screen under it showing as you
// drag (like Discord or Telegram). The stack's own swipe can't do it: its pan takes over drags in any direction,
// which broke scrolling and swipe-to-reply. This one only starts on a rightward drag.
import { router, useNavigation } from 'expo-router';
import type { ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { goHome } from '@/lib/navigation';

export function SwipeBack({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);

  // the screen is already off to the side, so it leaves without the stack's slide
  const back = () => {
    navigation.setOptions({ animation: 'none' });
    if (router.canGoBack()) router.back();
    else goHome();
  };

  const pan = Gesture.Pan()
    .activeOffsetX(15)
    .failOffsetX(-15)
    .failOffsetY([-15, 15])
    .onUpdate((event) => {
      x.value = Math.max(0, event.translationX);
    })
    .onEnd((event) => {
      if (event.translationX > width * 0.35 || event.velocityX > 800) {
        x.value = withTiming(width, { duration: 120 }, (finished) => {
          if (finished) runOnJS(back)();
        });
      } else {
        x.value = withSpring(0, { damping: 24, stiffness: 300 });
      }
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    shadowOpacity: interpolate(x.value, [0, width], [0.4, 0]),
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[{ flex: 1, shadowColor: '#000', shadowRadius: 12, elevation: 12 }, style]}
        className="bg-background"
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
