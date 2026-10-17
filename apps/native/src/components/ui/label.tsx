// Port of apps/frontend/src/lib/components/ui/label
import { Text } from './text';
import type { TextProps } from 'react-native';
import { cn } from '@/lib/utils';

export const Label = ({ className, ...props }: TextProps & { className?: string }) => (
  <Text className={cn('text-sm font-medium', className)} {...props} />
);
