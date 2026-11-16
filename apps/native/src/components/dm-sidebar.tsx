// Port of apps/frontend/src/lib/components/dm-sidebar.svelte
// Differences: long-press a row for its actions drawer (close, notifications), pull down to refresh.
// It is the hub's Home column: every DM opens as its own screen (Friends is a tab in the bottom bar). A search
// field finds DMs and channels in every server, the "new message" button sits in thumb reach at the bottom right,
// and when two people share a display name their handles tell them apart.
import * as Haptics from 'expo-haptics';
import { Bell, Hash, LoaderCircle, Phone, SquarePen, Volume2, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { NewDmDialog } from '@/components/new-dm-dialog';
import { NotificationMenu } from '@/components/notification-menu';
import { SearchField } from '@/components/search-field';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { guildPath, useChat } from '@/lib/chat-state';
import { dmPath, dms, useDms, type DmEntry } from '@/lib/dms';
import { formatShortDate } from '@/lib/format-date';
import { friends, useFriends } from '@/lib/friends';
import type { PublicUser } from 'anchor/public-user';
import { goto } from '@/lib/navigation';
import { useNotificationSettings } from '@/lib/notification-settings';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

export function DmSidebar() {
  const insets = useSafeAreaInsets();
  const circleIcons = useSettings((s) => s.circleIcons);
  const list = useDms((s) => s.list);
  const pending = useDms((s) => s.pending);
  const loading = useDms((s) => s.loading);
  const voiceStates = useChat((s) => s.voiceStates);
  useFriends((s) => s.accepted); // re-render when someone goes online or offline
  const servers = useChat((s) => s.servers);
  const channelsByServer = useChat((s) => s.channelsByServer);
  const [query, setQuery] = useState('');
  useNotificationSettings((s) => s.entries); // re-render when levels change
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [menuEntry, setMenuEntry] = useState<DmEntry | null>(null);
  const [menu, setMenu] = useState<'actions' | 'notify' | null>(null);

  const entries = useMemo(
    () =>
      [...list].sort(
        (a, b) =>
          new Date(b.lastMessageAt ?? b.joinedAt).getTime() -
          new Date(a.lastMessageAt ?? a.joinedAt).getTime()
      ),
    [list]
  );

  // display names repeat ("guille" twice), so a repeated one also shows the handle
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of list) {
      const other = entry.participants[0];
      const name = other ? other.displayName || other.username : '';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [list]);

  const needle = query.trim().toLowerCase();
  const nameOf = (other?: PublicUser) =>
    other ? other.displayName || other.username : 'Direct Message';
  const handleOf = (other?: PublicUser) => (other ? `@${other.username}:${other.homeserver}` : '');
  const shownDms = needle
    ? entries.filter((entry) =>
        `${nameOf(entry.participants[0])} ${handleOf(entry.participants[0])}`
          .toLowerCase()
          .includes(needle)
      )
    : entries;
  const channelResults = needle
    ? servers.flatMap((server) =>
        (channelsByServer[server.id] ?? []).flatMap((category) =>
          category.channels
            .filter((channel) => (channel.label || channel.name).toLowerCase().includes(needle))
            .map((channel) => ({ server, channel }))
        )
      )
    : [];

  const closeDm = (entry: DmEntry) => {
    setMenu(null);
    Alert.alert(
      `Close your conversation with ${nameOf(entry.participants[0])}?`,
      'It leaves your list until one of you sends a new message. Nothing is deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close', style: 'destructive', onPress: () => void dms().close(entry.id) },
      ]
    );
  };

  const row = (entry: DmEntry) => {
    const other = entry.participants[0];
    const name = nameOf(other);
    const repeated = (nameCounts.get(name) ?? 0) > 1;
    const unread =
      entry.unread &&
      useNotificationSettings.getState().showsUnread({ channelId: entry.id, guildId: null });

    const last = entry.lastMessageAt ? new Date(entry.lastMessageAt) : null;

    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}${unread ? ', unread' : ''}`}
        accessibilityHint="Long-press for more actions"
        onPress={() => goto(dmPath(entry.id))}
        onLongPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setMenuEntry(entry);
          setMenu('actions');
        }}
        className="min-h-16 flex-row items-center gap-3 bg-sidebar px-3 active:bg-accent"
      >
        <View>
          <Avatar
            src={other?.avatarUrl}
            name={name}
            bgColor={other?.avatarColor}
            className="size-10"
          />
          {other && friends().isOnline(other.userId) && (
            <View
              className={cn(
                'absolute -right-0.5 -bottom-0.5 size-3.5 border-2 border-sidebar bg-emerald-500',
                circleIcons && 'rounded-full'
              )}
            />
          )}
        </View>
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={cn('text-base text-sidebar-foreground', unread && 'font-semibold')}
          >
            {name}
          </Text>
          {repeated || needle ? (
            <Text numberOfLines={1} className="text-sm text-muted-foreground">
              {handleOf(other)}
            </Text>
          ) : null}
        </View>
        {last && (
          <Text
            className={cn(
              'text-xs',
              unread ? 'font-semibold text-sidebar-foreground' : 'text-muted-foreground'
            )}
          >
            {formatShortDate(last)}
          </Text>
        )}
        {voiceStates[entry.id]?.length ? (
          <Icon as={Phone} size={14} className="text-green-500" accessibilityLabel="In a call" />
        ) : null}
        {unread && <View className="size-2.5 rounded-full bg-sidebar-primary" />}
      </Pressable>
    );
  };

  return (
    <View className="flex-1 bg-sidebar">
      <View
        className="shrink-0 gap-2 border-b border-border px-3 pb-3"
        style={{ paddingTop: insets.top + 10 }}
      >
        <Text role="heading" className="px-1 text-lg font-bold text-sidebar-foreground">
          Messages
        </Text>
        <SearchField
          placeholder="Search messages and channels"
          value={query}
          onChangeText={setQuery}
        />
      </View>
      {/* a plain list: FlashList's extra layout passes made switching to Home slow */}
      <FlatList
        data={shownDms}
        keyExtractor={(entry) => entry.id}
        renderItem={({ item }) => row(item)}
        extraData={[voiceStates, circleIcons]}
        refreshing={loading}
        onRefresh={() => void dms().load()}
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 96 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          needle ? (
            <>
              {channelResults.length > 0 && (
                <Text className="px-4 pt-2 pb-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Channels
                </Text>
              )}
              {channelResults.slice(0, 20).map(({ server, channel }) => (
                <Pressable
                  key={channel.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${channel.label || channel.name} in ${server.name}`}
                  onPress={() => {
                    setQuery('');
                    goto(guildPath(server.id, channel.id));
                  }}
                  className="min-h-14 flex-row items-center gap-3 px-3 active:bg-accent"
                >
                  <View className="size-10 items-center justify-center bg-muted">
                    <Icon
                      as={channel.type === 'VOICE' ? Volume2 : Hash}
                      size={18}
                      className="text-muted-foreground"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-base">
                      {channel.label || channel.name}
                    </Text>
                    <Text numberOfLines={1} className="text-sm text-muted-foreground">
                      {server.name}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {shownDms.length > 0 && (
                <Text className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Direct messages
                </Text>
              )}
            </>
          ) : null
        }
        ListFooterComponent={
          <>
            {pending.map((homeserver) => (
              <View key={homeserver} className="min-h-9 flex-row items-center gap-1.5 px-4">
                <Icon as={LoaderCircle} size={14} className="text-muted-foreground" />
                <Text numberOfLines={1} className="flex-1 text-xs text-muted-foreground">
                  Waiting for {homeserver}…
                </Text>
              </View>
            ))}
            {needle && shownDms.length === 0 && channelResults.length === 0 ? (
              <Text className="mt-6 px-4 text-center text-sm text-muted-foreground">
                Nothing matches “{query.trim()}”.
              </Text>
            ) : null}
            {!needle && entries.length === 0 && pending.length === 0 && (
              <Text className="mt-6 px-6 text-center text-sm text-muted-foreground">
                No direct messages yet. Tap the pencil to start one.
              </Text>
            )}
          </>
        }
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New message"
        onPress={() => setNewDmOpen(true)}
        className={cn(
          'absolute right-4 bottom-4 size-14 items-center justify-center bg-primary shadow-lg active:opacity-80',
          circleIcons && 'rounded-full'
        )}
        style={{ elevation: 6 }}
      >
        <Icon as={SquarePen} size={22} className="text-primary-foreground" />
      </Pressable>

      <Sheet
        open={menu === 'actions'}
        onClose={() => setMenu((current) => (current === 'actions' ? null : current))}
        title={menuEntry ? nameOf(menuEntry.participants[0]) : undefined}
        subtitle={menuEntry ? handleOf(menuEntry.participants[0]) : undefined}
      >
        <SheetItem icon={Bell} label="Notification settings" onPress={() => setMenu('notify')} />
        <SheetItem
          icon={X}
          label="Close conversation"
          destructive
          onPress={() => menuEntry && closeDm(menuEntry)}
        />
      </Sheet>
      {menuEntry && (
        <NotificationMenu
          open={menu === 'notify'}
          onClose={() => setMenu(null)}
          targetId={menuEntry.id}
          noun="Conversation"
        />
      )}
      <NewDmDialog open={newDmOpen} onClose={() => setNewDmOpen(false)} />
    </View>
  );
}
