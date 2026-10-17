// Port of apps/frontend/src/lib/components/create-channel-dialog.svelte, as a bottom sheet
import { Hash, Plus, Volume2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { Channel } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

const channelSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);

export function CreateChannelDialog({
  open,
  onClose,
  categoryLabel = 'Text Channels',
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  categoryLabel?: string;
  onCreate?: (channel: Channel) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<Channel['type']>('TEXT');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setName('');
      setType('TEXT');
      setError('');
    }
  }, [open]);

  async function submit() {
    const slug = channelSlug(name);
    if (slug.length < 2) {
      setError('Channel name must be 2-32 letters, numbers, spaces, or dashes.');
      return;
    }
    setLoading(true);
    try {
      await onCreate?.({
        id: `chn-${Date.now()}`,
        name: slug,
        unread: false,
        lastReadMessageId: null,
        mention: 0,
        type,
      });
      onClose();
    } catch {
      setError('Could not create the channel.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <View className="gap-4 px-4 pb-2">
        <View>
          <Text className="text-lg font-semibold">Create Channel</Text>
          <Text className="text-sm text-muted-foreground">Add a channel to {categoryLabel}.</Text>
        </View>
        <View className="gap-1.5">
          <Text className="text-xs font-medium">Channel Name</Text>
          <Input
            sheet
            value={name}
            onChangeText={setName}
            placeholder="new-channel"
            maxLength={32}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={submit}
          />
        </View>
        <View className="gap-2">
          <Text className="text-xs font-medium">Channel Type</Text>
          <View className="flex-row gap-2">
            {(
              [
                ['TEXT', 'Text', Hash],
                ['VOICE', 'Voice', Volume2],
              ] as const
            ).map(([value, label, icon]) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: type === value }}
                key={value}
                onPress={() => setType(value)}
                className={cn(
                  'min-h-11 flex-1 flex-row items-center gap-2 border border-border bg-background px-3 active:bg-accent',
                  type === value && 'border-primary bg-primary/10'
                )}
              >
                <Icon as={icon} className="text-muted-foreground" />
                <Text className="text-sm">{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
        <View className="flex-row gap-2 border-t border-border pt-3">
          <Button variant="ghost" className="mr-auto" onPress={onClose}>
            <Text>Cancel</Text>
          </Button>
          <Button disabled={loading || !name.trim()} onPress={submit}>
            {loading ? <Spinner /> : <Icon as={Plus} className="text-primary-foreground" />}
            <Text>{loading ? 'Creating…' : 'Create Channel'}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
