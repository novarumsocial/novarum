// Port of apps/frontend/src/lib/components/initial-loader.svelte
// The sun is clipped by an `overflow-hidden` view (instead of an svg clipPath) so Reanimated can just translate a view.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useThemeColors } from '@/lib/theme';
import { Text } from './ui/text';

const SIZE = 144; // size-36
const UNIT = SIZE / 24; // svg viewBox is 24

export function InitialLoader({ finished = false }: { finished?: boolean }) {
  const colors = useThemeColors();
  const sunY = useSharedValue(9 * UNIT);

  useEffect(() => {
    sunY.value = finished
      ? withTiming(0, { duration: 550, easing: Easing.bezier(0.22, 1, 0.36, 1) })
      : withTiming(4 * UNIT, { duration: 800, easing: Easing.out(Easing.ease) });
  }, [finished, sunY]);

  const sunStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sunY.value }] }));

  return (
    <View
      className="flex-1 items-center justify-center overflow-hidden bg-background px-6"
      accessibilityRole="progressbar"
      accessibilityLabel={finished ? 'Ready' : 'Loading your guilds'}
    >
      <Svg width="100%" height="100%" style={{ position: 'absolute' }} pointerEvents="none">
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={colors.primary} stopOpacity={0.1} />
            <Stop offset="1" stopColor={colors.primary} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#glow)" />
      </Svg>

      <View style={{ width: SIZE, height: SIZE }}>
        <View style={{ width: SIZE, height: 15 * UNIT, overflow: 'hidden' }}>
          <Animated.View style={sunStyle}>
            <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24">
              <Path
                fill={colors.primary}
                d="M7 12a1 1 0 0 0 2 0 3 3 0 0 1 6 0 1 1 0 0 0 2 0 5 5 0 0 0-10 0Zm4-7a1 1 0 0 0 2 0V4a1 1 0 0 0-2 0Zm7 7a1 1 0 0 0 1 1h1a1 1 0 0 0 0-2h-1a1 1 0 0 0-1 1ZM3 12a1 1 0 0 0 1 1h1a1 1 0 0 0 0-2H4a1 1 0 0 0-1 1Zm2.636-6.364a1 1 0 0 0 0 1.414l.707.707a1 1 0 0 0 1.414-1.414l-.707-.707a1 1 0 0 0-1.414 0Zm11.314 0-.707.707a1 1 0 1 0 1.414 1.414l.707-.707a1 1 0 1 0-1.414-1.414Z"
              />
            </Svg>
          </Animated.View>
        </View>
        <Svg
          width={SIZE}
          height={SIZE}
          viewBox="0 0 24 24"
          style={{ position: 'absolute' }}
          pointerEvents="none"
        >
          <Path fill={colors.primary} d="M2 15a1 1 0 0 0 0 2h20a1 1 0 0 0 0-2Zm4 4a1 1 0 0 0 0 2h12a1 1 0 0 0 0-2Z" />
        </Svg>
      </View>

      <Text className="mt-8 text-xl font-semibold tracking-tight">novarum</Text>
    </View>
  );
}
