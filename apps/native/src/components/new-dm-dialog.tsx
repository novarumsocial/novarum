// Port of apps/frontend/src/lib/components/new-dm-dialog.svelte
// The dialog is a bottom sheet listing your friends. Without `addTo`, one friend opens a 1:1 and
// more start a group. With a group, the picked friends join it; with a 1:1, a new group starts
// with the other person and the picked friends.
import { Check, Search } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useAnchor } from '@/lib/anchor';
import { dms, type DmEntry } from '@/lib/dms';
import { useFriends, type FriendEntry } from '@/lib/friends';
import { cn } from '@/lib/utils';

const nameFor = (entry: FriendEntry) => entry.user.displayName || entry.user.username;
const handleFor = (entry: FriendEntry) => `@${entry.user.username}:${entry.user.homeserver}`;

export function NewDmDialog({
  open,
  onClose,
  addTo = null,
}: {
  open: boolean;
  onClose: () => void;
  addTo?: DmEntry | null;
}) {
  const accepted = useFriends((s) => s.accepted);
  const limit = useAnchor((s) => s.maxGroupMembers);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inGroup = new Set(addTo?.participants.map((user) => user.userId) ?? []);
  const room = limit - (addTo ? addTo.participants.length + 1 : 1);

  const q = query.trim().toLowerCase();
  const visible = accepted.filter(
    (entry) =>
      !inGroup.has(entry.user.userId) &&
      (!q || nameFor(entry).toLowerCase().includes(q) || handleFor(entry).toLowerCase().includes(q))
  );

  function toggle(userId: string) {
    setError(null);
    if (selected.includes(userId)) setSelected(selected.filter((id) => id !== userId));
    else if (selected.length < room) setSelected([...selected, userId]);
  }

  function close() {
    onClose();
    setQuery('');
    setSelected([]);
    setError(null);
  }

  async function submit() {
    if (!selected.length) return;
    setBusy(true);
    setError(null);
    let failed: string | null = null;
    if (addTo?.type === 'GROUP_DM') {
      failed = await dms().addMembers(addTo.id, selected);
    } else if (addTo) {
      const other = addTo.participants[0];
      const result = await dms().createGroup([...(other ? [other.userId] : []), ...selected]);
      failed = 'error' in result ? result.error : null;
    } else if (selected.length === 1) {
      await dms().open(selected[0]!);
    } else {
      const result = await dms().createGroup(selected);
      failed = 'error' in result ? result.error : null;
    }
    setBusy(false);
    if (failed) setError(failed);
    else close();
  }

  const action =
    addTo?.type === 'GROUP_DM'
      ? 'Add to group'
      : addTo || selected.length > 1
        ? 'Create group'
        : 'Open DM';

  return (
    <Sheet
      open={open}
      onClose={close}
      title={addTo ? 'Add people' : 'New message'}
      subtitle={
        addTo
          ? `Pick friends to add. ${room} more can join.`
          : `Pick a friend, or several to start a group of up to ${limit}.`
      }
    >
      <View className="px-4 pt-3 pb-3">
        <View>
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
        visible.map((entry) => {
          const checked = selected.includes(entry.user.userId);
          const disabled = busy || (!checked && selected.length >= room);
          return (
            <Pressable
              key={entry.user.userId}
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled }}
              disabled={disabled}
              onPress={() => toggle(entry.user.userId)}
              className={cn(
                'min-h-14 flex-row items-center gap-3 px-4 py-2 active:bg-accent',
                disabled && 'opacity-50'
              )}
            >
              <Avatar
                src={entry.user.avatarUrl}
                name={nameFor(entry)}
                bgColor={entry.user.avatarColor}
                className="size-10"
              />
              <View className="min-w-0 flex-1">
                <Text className="text-base font-medium" numberOfLines={1}>
                  {nameFor(entry)}
                </Text>
                <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                  {handleFor(entry)}
                </Text>
              </View>
              <View
                className={cn(
                  'size-5 items-center justify-center border border-border',
                  checked && 'border-primary bg-primary'
                )}
              >
                {checked && <Icon as={Check} size={14} className="text-primary-foreground" />}
              </View>
            </Pressable>
          );
        })
      )}

      <View className="gap-2 px-4 pt-3 pb-2">
        {error && <Text className="text-xs text-destructive">{error}</Text>}
        <Button disabled={busy || !selected.length} onPress={() => void submit()}>
          <Text>
            {action}
            {selected.length > 1 ? ` (${selected.length})` : ''}
          </Text>
        </Button>
      </View>
    </Sheet>
  );
}
