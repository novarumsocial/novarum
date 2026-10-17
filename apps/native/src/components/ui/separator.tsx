// Port of apps/frontend/src/lib/components/ui/separator
import { View } from 'react-native';
import { cn } from '@/lib/utils';

export const Separator = ({ className, vertical }: { className?: string; vertical?: boolean }) => (
  <View className={cn('bg-border', vertical ? 'w-px self-stretch' : 'h-px w-full', className)} />
);
