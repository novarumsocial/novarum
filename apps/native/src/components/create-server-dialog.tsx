// Port of apps/frontend/src/lib/components/create-server-dialog.svelte, as a bottom sheet
import { Plus } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { chat } from '@/lib/chat-state';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');

export function CreateServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const circleIcons = useSettings((s) => s.circleIcons);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setName('');
      setError('');
    }
  }, [open]);

  async function submit() {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 32) {
      setError('Server name must be 2–32 characters.');
      return;
    }
    setLoading(true);
    await chat().createServer({
      id: `srv-${Date.now()}`,
      name: trimmed,
      initials: initials(trimmed),
      down: false,
      canManageChannels: true,
    });
    setLoading(false);
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <View className="gap-4 px-4 pb-2">
        <View>
          <Text className="text-lg font-semibold">Create Server</Text>
          <Text className="text-sm text-muted-foreground">Give your server a name.</Text>
        </View>
        <View className="items-center gap-3">
          <View
            className={cn('size-16 items-center justify-center bg-primary', circleIcons && 'rounded-full')}
          >
            <Text className="text-lg font-bold text-white">{initials(name) || 'N'}</Text>
          </View>
          <View className="w-full gap-1.5">
            <Text className="text-xs font-medium">Server Name</Text>
            <Input
              sheet
              value={name}
              onChangeText={setName}
              placeholder="My Server"
              maxLength={32}
              autoComplete="off"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={submit}
            />
          </View>
        </View>
        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
        <View className="flex-row gap-2 border-t border-border pt-3">
          <Button variant="ghost" className="mr-auto" onPress={onClose}>
            <Text>Cancel</Text>
          </Button>
          <Button disabled={loading || !name.trim()} onPress={submit}>
            {loading ? <Spinner /> : <Icon as={Plus} className="text-primary-foreground" />}
            <Text>{loading ? 'Creating…' : 'Create Server'}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
