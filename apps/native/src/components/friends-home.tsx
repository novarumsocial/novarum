// Port of apps/frontend/src/lib/components/friends-home.svelte
// Same tabs and actions as the web; rows open the DM when tapped, pull down to refresh.
import * as Haptics from 'expo-haptics';
import {
  Check,
  EllipsisVertical,
  MessageSquare,
  Search,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { z } from 'zod';
import { Avatar } from '@/components/avatar';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { dms } from '@/lib/dms';
import { friends, useFriends, type FriendEntry } from '@/lib/friends';
import { useSettings } from '@/lib/settings';
import { useThemeColors } from '@/lib/theme';
import { cn } from '@/lib/utils';

type Tab = 'online' | 'all' | 'pending' | 'add';

const tabs: { value: Tab; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
];

// accepts "@name:server" or "name:server"
const handleSchema = z
  .string()
  .trim()
  .regex(/^@?[^:\s@]+:\S+$/, 'Use a full handle, like @name:server.');

const nameFor = (entry: FriendEntry) => entry.user.displayName || entry.user.username;
const handleFor = (entry: FriendEntry) => `@${entry.user.username}:${entry.user.homeserver}`;

function Person({ entry, subtitle }: { entry: FriendEntry; subtitle: string }) {
  const circleIcons = useSettings((s) => s.circleIcons);

  return (
    <>
      <View>
        <Avatar
          src={entry.user.avatarUrl}
          name={nameFor(entry)}
          bgColor={entry.user.avatarColor}
          className="size-10"
        />
        <View
          className={cn(
            'absolute -right-1 -bottom-1 size-3.5 border-[3px] border-background',
            entry.status === 'ONLINE' ? 'bg-emerald-500' : 'bg-muted-foreground/60',
            circleIcons && 'rounded-full'
          )}
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold" numberOfLines={1}>
          {nameFor(entry)}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </>
  );
}

function ActionButton({
  label,
  icon,
  onPress,
  tone = 'text-muted-foreground',
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  tone?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="bg-card"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
    >
      <Icon as={icon} size={18} className={tone} />
    </Button>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View className="flex-1 items-center justify-center px-6 py-16">
      <Icon as={Users} size={40} className="text-muted-foreground/50" />
      <Text className="mt-4 text-sm font-medium">{title}</Text>
      <Text className="mt-1 max-w-xs text-center text-xs leading-5 text-muted-foreground">
        {body}
      </Text>
    </View>
  );
}

export function FriendsHome() {
  const colors = useThemeColors();
  const circleIcons = useSettings((s) => s.circleIcons);
  const accepted = useFriends((s) => s.accepted);
  const incoming = useFriends((s) => s.incoming);
  const outgoing = useFriends((s) => s.outgoing);
  const loading = useFriends((s) => s.loading);
  const error = useFriends((s) => s.error);
  const busyUserIds = useFriends((s) => s.busyUserIds);

  const [tab, setTab] = useState<Tab>('online');
  const [query, setQuery] = useState('');
  const [handle, setHandle] = useState('');
  const [addResult, setAddResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // the entry stays set while the sheet slides away, so its content doesn't vanish early
  const [menuFor, setMenuFor] = useState<FriendEntry | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = (entry: FriendEntry) => {
    setMenuFor(entry);
    setMenuOpen(true);
  };

  const busy = (id: string) => busyUserIds.includes(id);
  const online = useMemo(() => accepted.filter((entry) => entry.status === 'ONLINE'), [accepted]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tab === 'online' ? online : accepted)
      .filter(
        (entry) =>
          !q ||
          nameFor(entry).toLowerCase().includes(q) ||
          handleFor(entry).toLowerCase().includes(q)
      )
      .sort((a, b) => Number(b.status === 'ONLINE') - Number(a.status === 'ONLINE'));
  }, [tab, online, accepted, query]);
  const pending = useMemo(
    () => [
      ...incoming.map((entry) => ({ entry, incoming: true })),
      ...outgoing.map((entry) => ({ entry, incoming: false })),
    ],
    [incoming, outgoing]
  );

  async function refresh() {
    setRefreshing(true);
    await friends().load();
    setRefreshing(false);
  }

  async function sendRequest() {
    const parsed = handleSchema.safeParse(handle);
    if (!parsed.success) {
      setAddResult({ ok: false, message: parsed.error.issues[0].message });
      return;
    }

    const [username, homeserver] = parsed.data.replace(/^@/, '').split(/:(.*)/);
    const sent = await friends().request(parsed.data, username, homeserver);
    setAddResult(
      sent
        ? { ok: true, message: `Friend request sent to @${username}:${homeserver}.` }
        : { ok: false, message: friends().error ?? 'Could not send the friend request.' }
    );
    if (sent) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setHandle('');
    }
  }

  const confirmRemove = (entry: FriendEntry) =>
    Alert.alert(`Remove ${nameFor(entry)}?`, 'They will no longer be in your friends list.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => void friends().remove(entry.user.userId),
      },
    ]);

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      tintColor={colors['muted-foreground']}
      colors={[colors.primary]}
    />
  );

  const sectionLabel = (text: string) => (
    <Text className="px-3 pt-4 pb-2 text-xs font-semibold text-muted-foreground">{text}</Text>
  );

  const errorText = error && tab !== 'add' && (
    <Text className="mx-3 my-4 border-l-2 border-destructive pl-3 text-xs leading-5 text-destructive">
      {error}
    </Text>
  );

  return (
    <View className="min-w-0 flex-1 bg-background">
      <ScreenHeader>
        <Text className="text-base font-semibold">Friends</Text>
      </ScreenHeader>
      <View className="flex-row items-center gap-2 border-b border-border px-1">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="min-w-0 flex-1"
          contentContainerClassName="items-center gap-2 pr-2"
        >
          {tabs.map((item) => (
            <Pressable
              key={item.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === item.value }}
              onPress={() => setTab(item.value)}
              className={cn(
                'min-h-11 flex-row items-center gap-1.5 px-2.5',
                tab === item.value && 'bg-muted'
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  tab === item.value ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {item.label}
              </Text>
              {item.value === 'pending' && incoming.length > 0 && (
                <View className={cn('min-w-4 bg-destructive px-1', circleIcons && 'rounded-full')}>
                  <Text className="text-center text-[11px] font-bold leading-4 text-white">
                    {incoming.length > 99 ? '99+' : incoming.length}
                  </Text>
                </View>
              )}
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === 'add' }}
            onPress={() => setTab('add')}
            className={cn(
              'min-h-11 justify-center px-2.5',
              tab === 'add' ? 'bg-transparent' : 'bg-primary'
            )}
          >
            <Text
              className={cn(
                'text-sm font-medium',
                tab === 'add' ? 'text-sidebar-primary' : 'text-primary-foreground'
              )}
            >
              Add friend
            </Text>
          </Pressable>
        </ScrollView>
      </View>

      {tab === 'online' || tab === 'all' ? (
        loading && accepted.length === 0 ? (
          <Text className="px-6 py-8 text-sm text-muted-foreground">Loading friends…</Text>
        ) : accepted.length === 0 ? (
          <ScrollView
            refreshControl={refreshControl}
            contentContainerClassName="flex-grow items-center"
          >
            <Empty
              title="No friends yet"
              body="Add someone with their handle and they’ll show up here once they accept."
            />
            <Button className="mb-16" onPress={() => setTab('add')}>
              <Text>Add friend</Text>
            </Button>
          </ScrollView>
        ) : tab === 'online' && online.length === 0 ? (
          <ScrollView refreshControl={refreshControl} contentContainerClassName="flex-grow">
            <Empty
              title="No one’s around right now"
              body="Friends who come online will show up here."
            />
          </ScrollView>
        ) : (
          <FlatList
            data={list}
            keyExtractor={(entry) => entry.user.userId}
            refreshControl={refreshControl}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-3 pb-6"
            ListHeaderComponent={
              <>
                <View className="mt-4">
                  <Input
                    placeholder="Search"
                    value={query}
                    onChangeText={setQuery}
                    className="border-0 bg-sidebar pr-10"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View className="absolute top-0 right-3 h-11 justify-center" pointerEvents="none">
                    <Icon as={Search} size={16} className="text-muted-foreground" />
                  </View>
                </View>
                {sectionLabel(`${tab === 'online' ? 'Online' : 'All friends'} — ${list.length}`)}
              </>
            }
            ListEmptyComponent={
              <Text className="px-3 py-8 text-sm text-muted-foreground">
                No friends match “{query.trim()}”.
              </Text>
            }
            ListFooterComponent={errorText || null}
            renderItem={({ item: entry }) => (
              <View className="flex-row items-center border-t border-border">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Message ${nameFor(entry)}`}
                  onPress={() => void dms().open(entry.user.userId)}
                  onLongPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    openMenu(entry);
                  }}
                  className="min-h-14 min-w-0 flex-1 flex-row items-center gap-3 px-3 py-2.5 active:bg-card"
                >
                  <Person
                    entry={entry}
                    subtitle={entry.status === 'ONLINE' ? 'Online' : 'Offline'}
                  />
                </Pressable>
                <ActionButton
                  label={`More options for ${nameFor(entry)}`}
                  icon={EllipsisVertical}
                  onPress={() => openMenu(entry)}
                />
              </View>
            )}
          />
        )
      ) : tab === 'pending' ? (
        pending.length === 0 ? (
          <ScrollView refreshControl={refreshControl} contentContainerClassName="flex-grow">
            <Empty
              title="No pending requests"
              body="Requests you send or receive will wait here until they’re answered."
            />
          </ScrollView>
        ) : (
          <ScrollView refreshControl={refreshControl} contentContainerClassName="px-3 pb-6">
            {sectionLabel(`Pending — ${pending.length}`)}
            {pending.map(({ entry, incoming: isIncoming }) => (
              <View
                key={entry.user.userId}
                className="min-h-14 flex-row items-center gap-3 border-t border-border px-3 py-2.5"
              >
                <Person
                  entry={entry}
                  subtitle={isIncoming ? 'Incoming friend request' : 'Outgoing friend request'}
                />
                <View className="flex-row items-center gap-2">
                  {isIncoming ? (
                    <>
                      <ActionButton
                        label={`Accept ${nameFor(entry)}`}
                        icon={Check}
                        tone="text-emerald-500"
                        disabled={busy(entry.user.userId)}
                        onPress={() => void friends().accept(entry.user.userId)}
                      />
                      <ActionButton
                        label={`Ignore ${nameFor(entry)}`}
                        icon={X}
                        tone="text-destructive"
                        disabled={busy(entry.user.userId)}
                        onPress={() => void friends().decline(entry.user.userId)}
                      />
                    </>
                  ) : (
                    <ActionButton
                      label={`Cancel request to ${nameFor(entry)}`}
                      icon={X}
                      tone="text-destructive"
                      disabled={busy(entry.user.userId)}
                      onPress={() => void friends().remove(entry.user.userId)}
                    />
                  )}
                </View>
              </View>
            ))}
            {errorText}
          </ScrollView>
        )
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 pt-4 pb-6">
          <Text className="text-base font-semibold">Add friend</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            You can add friends with their Novarum handle. It’s on their profile.
          </Text>
          <View
            className={cn(
              'mt-4 flex-row items-center gap-2 border bg-sidebar p-1.5 pl-3',
              addResult
                ? addResult.ok
                  ? 'border-emerald-500'
                  : 'border-destructive'
                : 'border-border'
            )}
          >
            <Input
              value={handle}
              onChangeText={(text) => {
                setHandle(text);
                setAddResult(null);
              }}
              onSubmitEditing={() => void sendRequest()}
              placeholder="@name:server"
              accessibilityLabel="Friend's handle"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              className="min-w-0 flex-1 border-0 bg-transparent px-0"
            />
            <Button disabled={!handle.trim()} onPress={() => void sendRequest()}>
              <Text>Send</Text>
            </Button>
          </View>
          {addResult && (
            <Text
              accessibilityLiveRegion="polite"
              className={cn('mt-2 text-xs', addResult.ok ? 'text-emerald-500' : 'text-destructive')}
            >
              {addResult.message}
            </Text>
          )}
          {error && !addResult ? (
            <Text className="mt-2 text-xs text-destructive">{error}</Text>
          ) : null}
        </ScrollView>
      )}

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)}>
        {menuFor && (
          <>
            <SheetItem
              icon={MessageSquare}
              label={`Message ${nameFor(menuFor)}`}
              onPress={() => {
                setMenuOpen(false);
                void dms().open(menuFor.user.userId);
              }}
            />
            <SheetItem
              label="Remove friend"
              destructive
              disabled={busy(menuFor.user.userId)}
              onPress={() => {
                setMenuOpen(false);
                confirmRemove(menuFor);
              }}
            />
          </>
        )}
      </Sheet>
    </View>
  );
}
