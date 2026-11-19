// Native-only: the search box at the top of a list (friends, members, the hub)
import { Search, X } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function SearchField({
  value,
  onChangeText,
  placeholder,
  className,
  onSubmitEditing,
  autoFocus,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  className?: string;
  onSubmitEditing?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <View className={cn('min-h-11 flex-row items-center gap-2 bg-muted px-3', className)}>
      <Icon as={Search} size={16} className="text-muted-foreground" />
      <Input
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        className="min-w-0 flex-1 border-0 bg-transparent px-0"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={onSubmitEditing}
        autoFocus={autoFocus}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={12}
          className="min-h-11 justify-center"
          onPress={() => onChangeText('')}
        >
          <Icon as={X} size={16} className="text-muted-foreground" />
        </Pressable>
      ) : null}
    </View>
  );
}
