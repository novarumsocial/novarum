// Port of apps/frontend/src/lib/components/settings-row.svelte
// Native addition: `SettingsSwitchRow`, where the whole row toggles and the title is the switch's label
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { cn } from '@/lib/utils';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

function RowText({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <Label>{title}</Label>
      {description ? (
        <Text className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</Text>
      ) : null}
    </>
  );
}

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
        <RowText title={title} description={description} />
      </View>
      <View className={stacked ? 'w-full' : 'shrink-0'}>{children}</View>
    </View>
  );
}

export function SettingsSwitchRow({
  title,
  description,
  value,
  onValueChange,
  disabled,
}: {
  title: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      role="switch"
      accessibilityLabel={title}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      className={cn(
        'min-h-14 flex-row items-center justify-between gap-4 px-4 py-3.5 active:bg-accent',
        disabled && 'opacity-50'
      )}
    >
      <View className="min-w-0 flex-1">
        <RowText title={title} description={description} />
      </View>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Switch value={value} disabled={disabled} onValueChange={onValueChange} />
      </View>
    </Pressable>
  );
}
