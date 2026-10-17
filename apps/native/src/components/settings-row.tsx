// Port of apps/frontend/src/lib/components/settings-row.svelte
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { cn } from '@/lib/utils';
import { Label } from './ui/label';
import { Text } from './ui/text';

// `stacked` puts the control under the text, for wide controls like sliders and pickers
export function SettingsRow({
  title,
  description,
  stacked = false,
  children,
}: {
  title: string;
  description?: string;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      className={cn('gap-3 px-4 py-3.5', !stacked && 'flex-row items-center justify-between gap-4')}
    >
      <View className={cn('min-w-0', !stacked && 'flex-1')}>
        <Label>{title}</Label>
        {description ? (
          <Text className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </Text>
        ) : null}
      </View>
      <View className={stacked ? 'w-full' : 'shrink-0'}>{children}</View>
    </View>
  );
}
