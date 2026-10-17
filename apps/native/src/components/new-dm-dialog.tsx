// Port of apps/frontend/src/lib/components/new-dm-dialog.svelte
// The dialog is a bottom sheet listing your friends.
import { Search } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { dms } from '@/lib/dms';
import { useFriends, type FriendEntry } from '@/lib/friends';
import { cn } from '@/lib/utils';

const nameFor = (entry: FriendEntry) => entry.user.displayName || entry.user.username;
const handleFor = (entry: FriendEntry) => `@${entry.user.username}:${entry.user.homeserver}`;

export function NewDmDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accepted = useFriends((s) => s.accepted);
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const visible = accepted.filter(
    (entry) =>
      !q || nameFor(entry).toLowerCase().includes(q) || handleFor(entry).toLowerCase().includes(q)
  );

  async function handleSelect(entry: FriendEntry) {
    setOpening(entry.user.userId);
    await dms().open(entry.user.userId);
    setOpening(null);
    onClose();
    setQuery('');
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        onClose();
        setQuery('');
      }}
    >
      <View className="px-4 pt-2 pb-3">
        <Text className="text-lg font-semibold">New Direct Message</Text>
        <Text className="text-sm text-muted-foreground">Pick a friend to message.</Text>
        <View className="mt-3">
          <Input
            sheet
            value={query}
            onChangeText={setQuery}
            placeholder="Search friends"
            autoCapitalize="none"
            autoCorrect={false}
            className="pl-9"
          />
          <View className="absolute top-0 left-3 h-11 justify-center" pointerEvents="none">
            <Icon as={Search} size={16} className="text-muted-foreground" />
          </View>
        </View>
      </View>

      {accepted.length === 0 ? (
        <Text className="py-6 text-center text-sm text-muted-foreground">
          You don't have any friends yet.
        </Text>
      ) : visible.length === 0 ? (
        <Text className="py-6 text-center text-sm text-muted-foreground">No matches.</Text>
      ) : (
        visible.map((entry) => (
          <Pressable
            key={entry.user.userId}
            accessibilityRole="button"
            disabled={opening === entry.user.userId}
            onPress={() => void handleSelect(entry)}
            className={cn(
              'min-h-14 flex-row items-center gap-3 px-4 py-2 active:bg-accent',
              opening === entry.user.userId && 'opacity-50'
            )}
          >
            <Avatar
              src={entry.user.avatarUrl}
              name={nameFor(entry)}
              bgColor={entry.user.avatarColor}
              className="size-10"
            />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium" numberOfLines={1}>
                {nameFor(entry)}
              </Text>
              <Text className="font-mono text-[10px] text-muted-foreground" numberOfLines={1}>
                {handleFor(entry)}
              </Text>
            </View>
          </Pressable>
        ))
      )}
    </Sheet>
  );
}
