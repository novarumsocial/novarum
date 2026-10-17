// Port of apps/frontend/src/lib/components/friends-home.svelte
// Same tabs and actions as the web, with "Add friend" as a sheet from the header. Rows open the DM when
// tapped (long-press for more), pull down to refresh.
import * as Haptics from 'expo-haptics';
import {
  Check,
  EllipsisVertical,
  MessageSquare,
  Search,
  UserRoundMinus,
  UserRoundPlus,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

type Tab = 'online' | 'all' | 'pending';

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
          className="size-11"
        />
        <View
          className={cn(
            'absolute -right-1 -bottom-1 size-4 border-[3px] border-background',
            entry.status === 'ONLINE' ? 'bg-emerald-500' : 'bg-muted-foreground/60',
            circleIcons && 'rounded-full'
          )}
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-semibold" numberOfLines={1}>
          {nameFor(entry)}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
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
  className,
  tone = 'text-foreground',
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  className?: string;
  tone?: string;
  disabled?: boolean;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('bg-muted', circleIcons && 'rounded-full', className)}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
    >
      <Icon as={icon} size={18} className={tone} />
    </Button>
  );
}

function Empty({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center px-6 py-16">
      <View className="size-20 items-center justify-center bg-muted">
        <Icon as={Users} size={36} className="text-muted-foreground" />
      </View>
      <Text className="mt-5 text-base font-semibold">{title}</Text>
      <Text className="mt-1 max-w-xs text-center text-sm leading-5 text-muted-foreground">
        {body}
      </Text>
      {children}
    </View>
  );
}

// the web's "Add friend" tab, as a sheet opened from the header
function AddFriendSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const error = useFriends((s) => s.error);
  const [handle, setHandle] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const input = useRef<TextInput>(null);
  // focused once the sheet is up: autoFocus raises the keyboard before the sheet is presented and hides it
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 400);
    return () => clearTimeout(timer);
  }, []);

  async function sendRequest() {
    const parsed = handleSchema.safeParse(handle);
    if (!parsed.success) {
      setResult({ ok: false, message: parsed.error.issues[0].message });
      return;
    }

    const [username, homeserver] = parsed.data.replace(/^@/, '').split(/:(.*)/);
    const sent = await friends().request(parsed.data, username, homeserver);
    setResult(
      sent
        ? { ok: true, message: `Friend request sent to @${username}:${homeserver}.` }
        : { ok: false, message: friends().error ?? 'Could not send the friend request.' }
    );
    if (sent) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setHandle('');
    }
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <View className="px-4 pt-2 pb-4">
        <Text className="text-lg font-semibold">Add friend</Text>
        <Text className="mt-1 text-sm text-muted-foreground">
          Enter their Novarum handle. It’s on their profile.
        </Text>
        <View
          className={cn(
            'mt-4 flex-row items-center gap-2 border bg-background p-1.5 pl-3',
            result ? (result.ok ? 'border-emerald-500' : 'border-destructive') : 'border-border'
          )}
        >
          <Input
            sheet
            ref={input}
            value={handle}
            onChangeText={(text) => {
              setHandle(text);
              setResult(null);
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
        {result || error ? (
          <Text
            accessibilityLiveRegion="polite"
            className={cn('mt-2 text-xs', result?.ok ? 'text-emerald-500' : 'text-destructive')}
          >
            {result?.message ?? error}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

export function FriendsHome() {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const circleIcons = useSettings((s) => s.circleIcons);
  const accepted = useFriends((s) => s.accepted);
  const incoming = useFriends((s) => s.incoming);
  const outgoing = useFriends((s) => s.outgoing);
  const loading = useFriends((s) => s.loading);
  const error = useFriends((s) => s.error);
  const busyUserIds = useFriends((s) => s.busyUserIds);

  // requests waiting on you are the first thing to see
  const [tab, setTab] = useState<Tab>(() => (incoming.length ? 'pending' : 'online'));
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // the entry stays set while the sheet slides away, so its content doesn't vanish early
  const [menuFor, setMenuFor] = useState<FriendEntry | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = (entry: FriendEntry) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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
    <Text className="px-4 pt-5 pb-2 text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
      {text}
    </Text>
  );

  const errorText = error && (
    <Text className="mx-4 my-4 border-l-2 border-destructive pl-3 text-xs leading-5 text-destructive">
      {error}
    </Text>
  );

  const addButton = (
    <Button className="mt-6" onPress={() => setAddOpen(true)}>
      <Icon as={UserRoundPlus} size={16} className="text-primary-foreground" />
      <Text>Add friend</Text>
    </Button>
  );

  return (
    <View className="min-w-0 flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      <ScreenHeader
        actions={
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel="Add friend"
            onPress={() => setAddOpen(true)}
          >
            <Icon as={UserRoundPlus} size={20} />
          </Button>
        }
      >
        <Text className="text-[15px] font-semibold">Friends</Text>
      </ScreenHeader>

      <View accessibilityRole="tablist" className="mx-3 mt-3 flex-row bg-muted p-1">
        {tabs.map((item) => (
          <Pressable
            key={item.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item.value }}
            onPress={() => {
              void Haptics.selectionAsync();
              setTab(item.value);
            }}
            className={cn(
              'min-h-9 flex-1 flex-row items-center justify-center gap-1.5',
              tab === item.value && 'bg-background'
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
                <Text className="text-center text-[11px] leading-4 font-bold text-white">
                  {incoming.length > 99 ? '99+' : incoming.length}
                </Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>

      {tab === 'online' || tab === 'all' ? (
        loading && accepted.length === 0 ? (
          <Text className="px-6 py-8 text-sm text-muted-foreground">Loading friends…</Text>
        ) : accepted.length === 0 ? (
          <ScrollView refreshControl={refreshControl} contentContainerClassName="flex-grow">
            <Empty
              title="No friends yet"
              body="Add someone with their handle and they’ll show up here once they accept."
            >
              {addButton}
            </Empty>
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
            keyboardDismissMode="on-drag"
            contentContainerClassName="pb-6"
            ListHeaderComponent={
              <>
                <View className="mx-3 mt-3 min-h-11 flex-row items-center gap-2 bg-muted px-3">
                  <Icon as={Search} size={16} className="text-muted-foreground" />
                  <Input
                    placeholder="Search friends"
                    value={query}
                    onChangeText={setQuery}
                    className="min-w-0 flex-1 border-0 bg-transparent px-0"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {query ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Clear search"
                      hitSlop={10}
                      onPress={() => setQuery('')}
                    >
                      <Icon as={X} size={16} className="text-muted-foreground" />
                    </Pressable>
                  ) : null}
                </View>
                {sectionLabel(`${tab === 'online' ? 'Online' : 'All friends'} — ${list.length}`)}
              </>
            }
            ListEmptyComponent={
              <Text className="px-4 py-8 text-sm text-muted-foreground">
                No friends match “{query.trim()}”.
              </Text>
            }
            ListFooterComponent={errorText || null}
            renderItem={({ item: entry }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Message ${nameFor(entry)}`}
                accessibilityHint="Long press for more options"
                onPress={() => void dms().open(entry.user.userId)}
                onLongPress={() => openMenu(entry)}
                className="min-h-16 flex-row items-center gap-3 px-4 py-2 active:bg-accent"
              >
                <Person
                  entry={entry}
                  subtitle={entry.status === 'ONLINE' ? 'Online' : handleFor(entry)}
                />
                <ActionButton
                  label={`Message ${nameFor(entry)}`}
                  icon={MessageSquare}
                  onPress={() => void dms().open(entry.user.userId)}
                />
                <ActionButton
                  label={`More options for ${nameFor(entry)}`}
                  icon={EllipsisVertical}
                  tone="text-muted-foreground"
                  onPress={() => openMenu(entry)}
                />
              </Pressable>
            )}
          />
        )
      ) : pending.length === 0 ? (
        <ScrollView refreshControl={refreshControl} contentContainerClassName="flex-grow">
          <Empty
            title="No pending requests"
            body="Requests you send or receive will wait here until they’re answered."
          >
            {addButton}
          </Empty>
        </ScrollView>
      ) : (
        <ScrollView refreshControl={refreshControl} contentContainerClassName="pb-6">
          {sectionLabel(`Pending — ${pending.length}`)}
          {pending.map(({ entry, incoming: isIncoming }) => (
            <View
              key={entry.user.userId}
              className="min-h-16 flex-row items-center gap-3 px-4 py-2"
            >
              <Person
                entry={entry}
                subtitle={isIncoming ? 'Wants to be your friend' : 'Request sent'}
              />
              {isIncoming ? (
                <>
                  <ActionButton
                    label={`Accept ${nameFor(entry)}`}
                    icon={Check}
                    tone="text-emerald-500"
                    className="bg-emerald-500/15"
                    disabled={busy(entry.user.userId)}
                    onPress={() => void friends().accept(entry.user.userId)}
                  />
                  <ActionButton
                    label={`Ignore ${nameFor(entry)}`}
                    icon={X}
                    tone="text-destructive"
                    className="bg-destructive/15"
                    disabled={busy(entry.user.userId)}
                    onPress={() => void friends().decline(entry.user.userId)}
                  />
                </>
              ) : (
                <ActionButton
                  label={`Cancel request to ${nameFor(entry)}`}
                  icon={X}
                  tone="text-muted-foreground"
                  disabled={busy(entry.user.userId)}
                  onPress={() => void friends().remove(entry.user.userId)}
                />
              )}
            </View>
          ))}
          {errorText}
        </ScrollView>
      )}

      {addOpen && <AddFriendSheet open onClose={() => setAddOpen(false)} />}

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)}>
        {menuFor && (
          <>
            <Text className="px-4 pt-2 pb-1 text-sm font-medium" numberOfLines={1}>
              {nameFor(menuFor)}
            </Text>
            <SheetItem
              icon={MessageSquare}
              label="Message"
              onPress={() => {
                setMenuOpen(false);
                void dms().open(menuFor.user.userId);
              }}
            />
            <SheetItem
              icon={UserRoundMinus}
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
