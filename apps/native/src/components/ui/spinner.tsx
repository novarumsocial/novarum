// Native-only: the web shows a Loader2 icon; the phone has a native spinner
import { ActivityIndicator } from 'react-native';
import { useThemeColors } from '@/lib/theme';

export const Spinner = ({ size = 'small' }: { size?: 'small' | 'large' }) => {
  const colors = useThemeColors();
  return <ActivityIndicator size={size} color={colors['muted-foreground']} />;
};
