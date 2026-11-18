// Native-only: draws the toast from lib/toast.ts above the bottom of the screen (and above any sheet)
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { dismissToast, useToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function ToastHost() {
  const current = useToast((s) => s.current);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!current) return;
    const timeout = setTimeout(dismissToast, current.action ? 5000 : 2500);
    return () => clearTimeout(timeout);
  }, [current]);

  if (!current) return null;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 items-center px-4"
      style={{ paddingBottom: insets.bottom + 72 }}
    >
      <Animated.View
        key={current.id}
        entering={FadeInDown.duration(160)}
        exiting={FadeOutDown.duration(160)}
        accessibilityLiveRegion="polite"
        role="alert"
        className={cn(
          'min-h-12 w-full max-w-md flex-row items-center gap-3 border px-4 py-2 shadow-lg',
          current.tone === 'error' ? 'border-destructive/40 bg-popover' : 'border-border bg-popover'
        )}
      >
        <Text
          className={cn('flex-1 text-sm', current.tone === 'error' && 'text-destructive')}
          numberOfLines={3}
        >
          {current.message}
        </Text>
        {current.action && (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            className="min-h-11 justify-center px-2 active:opacity-60"
            onPress={() => {
              current.action?.onPress();
              dismissToast();
            }}
          >
            <Text className="text-sm font-semibold text-link">{current.action.label}</Text>
          </Pressable>
        )}
      </Animated.View>
    </View>
  );
}
