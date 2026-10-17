// Port of apps/frontend/src/lib/components/edit-channel-dialog.svelte (UI only, like the web: the backend has no rename yet)
import { Hash, Pencil, Volume2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import type { Channel } from '@/lib/types/chat';

export function EditChannelDialog({
  open,
  onClose,
  channel = null,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  channel?: Channel | null;
  onSave?: (channel: Channel, name: string) => void;
}) {
  const [name, setName] = useState('');

  useEffect(() => {
    if (open && channel) setName(channel.label || channel.name);
  }, [open, channel]);

  function submit() {
    if (!channel || !name.trim()) return;
    onSave?.(channel, name.trim());
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <View className="gap-4 px-4 pb-2">
        <View>
          <Text className="text-lg font-semibold">Edit Channel</Text>
          <Text className="text-sm text-muted-foreground">
            Rename #{channel?.label || channel?.name || 'channel'}.
          </Text>
        </View>
        <View className="gap-1.5">
          <Text className="text-xs font-medium">Channel Name</Text>
          <Input
            sheet
            value={name}
            onChangeText={setName}
            maxLength={32}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={submit}
          />
        </View>
        <View className="flex-row gap-2 border-t border-border pt-3">
          <Button variant="ghost" className="mr-auto" onPress={onClose}>
            <Text>Cancel</Text>
          </Button>
          <Button disabled={!name.trim()} onPress={submit}>
            <Icon
              as={channel?.type === 'VOICE' ? Volume2 : channel ? Pencil : Hash}
              className="text-primary-foreground"
            />
            <Text>Save</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
