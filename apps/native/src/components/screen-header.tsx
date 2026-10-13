// Native-only: the top bar of the screens pushed over the hub (a channel, a call, friends). It sits below the
// status bar and starts with a back button; the system back gesture does the same.
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { goHome } from '@/lib/navigation';

export function ScreenHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center gap-1 border-b border-border bg-background pr-1"
      style={{ minHeight: 52 + insets.top, paddingTop: insets.top }}
    >
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel="Back"
        // a deep link can open a channel with nothing below it
        onPress={() => (router.canGoBack() ? router.back() : goHome())}
      >
        <Icon as={ChevronLeft} size={24} />
      </Button>
      <View className="min-w-0 flex-1 flex-row items-center gap-2">{children}</View>
      {actions}
    </View>
  );
}
