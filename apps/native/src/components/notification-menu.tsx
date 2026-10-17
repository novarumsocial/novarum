// Port of apps/frontend/src/lib/components/notification-menu.svelte
import { BellOff, Check } from 'lucide-react-native';
import { View } from 'react-native';
import type { NotificationLevel } from 'anchor/notification-level';
import { Separator } from '@/components/ui/separator';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { useNotificationSettings } from '@/lib/notification-settings';

const mutes: [string, number | null][] = [
  ['For 1 Hour', 1],
  ['For 8 Hours', 8],
  ['For 24 Hours', 24],
  ['Until I turn it back on', null],
];

const levels: [string, NotificationLevel][] = [
  ['All Messages', 'ALL'],
  ['Only Mentions', 'MENTIONS'],
  ['Nothing', 'NONE'],
];

// the "Mute" and "Notify" entries of a long-press menu, for a guild, channel or DM.
export function NotificationMenu({
  open,
  onClose,
  targetId,
  guildId = null,
  noun,
}: {
  open: boolean;
  onClose: () => void;
  targetId: string;
  guildId?: string | null;
  noun: 'Server' | 'Channel' | 'Conversation';
}) {
  // a guild is its own parent here, so it falls back to the guild default (mentions)
  const level = useNotificationSettings((s) =>
    s.level({ channelId: targetId, guildId: noun === 'Server' ? targetId : guildId })
  );
  const muted = useNotificationSettings((s) => s.isMuted(targetId));
  const hasSetting = useNotificationSettings((s) => !!s.entries[targetId]);
  const { mute, unmute, set, reset } = useNotificationSettings.getState();

  // run the change, then close the sheet
  const then = (action: () => unknown) => () => {
    void action();
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <Text className="px-4 pt-2 pb-1 text-sm text-muted-foreground">
        {muted ? `Muted ${noun}` : `Mute ${noun}`}
      </Text>
      {muted && (
        <SheetItem icon={BellOff} label="Unmute" onPress={then(() => unmute(targetId, level))} />
      )}
      {mutes.map(([label, hours]) => (
        <SheetItem key={label} label={label} onPress={then(() => mute(targetId, hours, level))} />
      ))}
      <View className="py-1">
        <Separator />
      </View>
      <Text className="px-4 pt-2 pb-1 text-sm text-muted-foreground">Notify</Text>
      {levels.map(([label, value]) => (
        <SheetItem
          key={value}
          icon={value === level ? Check : undefined}
          label={label}
          onPress={then(() => set(targetId, { level: value }, level))}
        />
      ))}
      {hasSetting && <SheetItem label="Use Default" onPress={then(() => reset(targetId))} />}
    </Sheet>
  );
}
