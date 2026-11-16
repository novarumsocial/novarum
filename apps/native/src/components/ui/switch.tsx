// Port of apps/frontend/src/lib/components/ui/switch (the native switch, so it looks like the phone's)
import { Switch as RNSwitch, type SwitchProps } from 'react-native';
import { useThemeColors } from '@/lib/theme';

export function Switch({ value, ...props }: SwitchProps) {
  const colors = useThemeColors();
  return (
    <RNSwitch
      value={value}
      trackColor={{ false: colors.input, true: colors.primary }}
      // a white thumb on a pale off-track looked broken; off is a muted thumb instead
      thumbColor={value ? '#ffffff' : colors['muted-foreground']}
      {...props}
    />
  );
}
