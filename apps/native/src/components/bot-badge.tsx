// Port of apps/frontend/src/lib/components/bot-badge.svelte
import { View } from 'react-native';
import { cn } from '@/lib/utils';
import { Text } from './ui/text';

export function BotBadge({ className }: { className?: string }) {
  return (
    <View
      className={cn('h-4 shrink-0 justify-center bg-primary px-1', className)}
      accessibilityLabel="Bot"
    >
      <Text className="text-[10px] font-semibold leading-3 text-primary-foreground">Bot</Text>
    </View>
  );
}
