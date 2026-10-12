// Native-only: one tappable row inside a <Sheet>, like a dropdown-menu item on the web
import type { LucideIcon } from 'lucide-react-native';
import { Pressable } from 'react-native';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { Text } from './text';

export function SheetItem({
  icon,
  label,
  onPress,
  destructive,
  disabled,
}: {
  icon?: LucideIcon;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        'h-12 flex-row items-center gap-3 px-4 active:bg-accent',
        disabled && 'opacity-50'
      )}
    >
      {icon && (
        <Icon
          as={icon}
          size={18}
          className={destructive ? 'text-destructive' : 'text-muted-foreground'}
        />
      )}
      <Text className={cn('text-base', destructive && 'text-destructive')}>{label}</Text>
    </Pressable>
  );
}
