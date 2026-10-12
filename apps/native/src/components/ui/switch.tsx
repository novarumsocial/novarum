// Port of apps/frontend/src/lib/components/ui/switch (the native switch, so it looks like the phone's)
import { Switch as RNSwitch, type SwitchProps } from 'react-native';
import { useThemeColors } from '@/lib/theme';

export function Switch({ value, ...props }: SwitchProps) {
  const colors = useThemeColors();
  return (
    <RNSwitch
      value={value}
      trackColor={{ false: colors.input, true: colors.primary }}
      thumbColor="#ffffff"
      {...props}
    />
  );
}
