// Port of apps/frontend/src/lib/components/constellation-background.svelte
// Native version is cheap on purpose: the stars and lines are drawn once (no per-frame canvas), and only the hub glow breathes.
import { useEffect, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Line } from 'react-native-svg';

const ACCENT = 'rgb(130,175,235)';
const HOT = 'rgb(188,212,250)';
const MAX_DIST = 150;

function makeNodes(width: number, height: number) {
  const count = Math.min(85, Math.floor((width * height) / 17000));
  return Array.from({ length: count }, () => {
    const hub = Math.random() < 0.12;
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      r: hub ? 2.1 + Math.random() * 1.1 : 0.9 + Math.random() * 0.8,
      hub,
    };
  });
}

export function ConstellationBackground({ className }: { className?: string }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const pulse = useSharedValue(0.6);
  const nodes = useMemo(() => makeNodes(size.width, size.height), [size]);
  const hubs = nodes.filter((n) => n.hub);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
      -1,
      true
    );
  }, [pulse]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: pulse.value, position: 'absolute' }));

  const onLayout = ({ nativeEvent: { layout } }: LayoutChangeEvent) =>
    setSize({ width: Math.round(layout.width), height: Math.round(layout.height) });

  const lines = useMemo(
    () =>
      nodes.flatMap((a, i) =>
        nodes.slice(i + 1).flatMap((b, j) => {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          return d < MAX_DIST
            ? [{ a, b, key: `${i}-${j}`, opacity: (1 - d / MAX_DIST) * 0.2 }]
            : [];
        })
      ),
    [nodes]
  );

  return (
    <View className={className} onLayout={onLayout} pointerEvents="none" aria-hidden>
      <Svg width={size.width} height={size.height}>
        {lines.map(({ a, b, key, opacity }) => (
          <Line
            key={key}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={ACCENT}
            strokeOpacity={opacity}
            strokeWidth={0.6}
          />
        ))}
        {nodes.map((n, i) => (
          <Circle
            key={i}
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.hub ? HOT : ACCENT}
            fillOpacity={n.hub ? 0.85 : 0.5}
          />
        ))}
      </Svg>
      <Animated.View style={glowStyle}>
        <Svg width={size.width} height={size.height}>
          {hubs.map((n, i) => (
            <Circle key={i} cx={n.x} cy={n.y} r={n.r * 4.2} fill={ACCENT} fillOpacity={0.16} />
          ))}
        </Svg>
      </Animated.View>
    </View>
  );
}
