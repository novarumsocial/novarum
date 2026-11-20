// Port of apps/frontend/src/lib/components/system-message.svelte
import {
  Crown,
  Image,
  LogOut,
  Pencil,
  Phone,
  PhoneMissed,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react-native';
import { View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatTime } from '@/lib/format-date';
import { systemText } from '@/lib/system-message';
import type { Message } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

const icons = {
  'group.created': Users,
  'member.added': UserPlus,
  'bot.added': UserPlus,
  'member.removed': UserMinus,
  'bot.removed': UserMinus,
  'member.left': LogOut,
  'owner.changed': Crown,
  'group.renamed': Pencil,
  'group.icon': Image,
  call: Phone,
};

export function SystemMessage({
  message,
}: {
  message: Message & { system: NonNullable<Message['system']> };
}) {
  const { system } = message;
  const missed = system.type === 'call' && system.missed;
  return (
    <View accessibilityRole="text" className="flex-row items-center gap-3 px-3 py-1.5">
      <View className="w-10 items-center">
        <Icon
          as={missed ? PhoneMissed : icons[system.type]}
          size={16}
          className={cn(
            'text-muted-foreground',
            missed ? 'text-destructive' : system.type === 'call' && 'text-green-500'
          )}
        />
      </View>
      <Text className="min-w-0 flex-1 text-sm text-muted-foreground">
        {systemText(system, message.author)}
        <Text className="text-[10px] text-muted-foreground/60">
          {'  '}
          {formatTime(message.timestamp)}
        </Text>
      </Text>
    </View>
  );
}
