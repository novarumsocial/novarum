// Port of apps/frontend/src/lib/components/dm-sidebar.svelte
// Differences: swipe a row left (or long-press it) to close the conversation, pull down to refresh.
// It is the hub's Home column: Friends and every DM open as their own screen.
import { FlashList } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { ChevronRight, LoaderCircle, Phone, Plus, Users, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { NewDmDialog } from '@/components/new-dm-dialog';
import { NotificationMenu } from '@/components/notification-menu';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { useChat } from '@/lib/chat-state';
import { dmPath, dms, useDms, type DmEntry } from '@/lib/dms';
import { formatDate, formatTime } from '@/lib/format-date';
import { friends, useFriends } from '@/lib/friends';
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
  const requests = useFriends((s) => s.incoming.length);
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

  const closeDm = (entry: DmEntry) => void dms().close(entry.id);

  const row = (entry: DmEntry) => {
    const other = entry.participants[0];
    const name = other ? other.displayName || other.username : 'Direct Message';
    const unread =
      entry.unread &&
      useNotificationSettings.getState().showsUnread({ channelId: entry.id, guildId: null });

    const last = entry.lastMessageAt ? new Date(entry.lastMessageAt) : null;

    return (
      // keyed so a recycled row never keeps the previous conversation's swipe open
      <ReanimatedSwipeable
        key={entry.id}
        overshootRight={false}
        renderRightActions={() => (
          <View className="w-20 items-center justify-center bg-destructive">
            <Icon as={X} size={18} className="text-destructive-foreground" />
          </View>
        )}
        onSwipeableOpen={() => closeDm(entry)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name}${unread ? ', unread' : ''}`}
          accessibilityHint="Swipe left to close the conversation"
          onPress={() => goto(dmPath(entry.id))}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setMenuEntry(entry);
            setMenu('actions');
          }}
          className="min-h-14 flex-row items-center gap-3 bg-sidebar px-3 active:bg-accent"
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
                  'absolute -right-px -bottom-px size-2.5 border-2 border-sidebar bg-emerald-500',
                  circleIcons && 'rounded-full'
                )}
              />
            )}
          </View>
          <Text
            numberOfLines={1}
            className={cn(
              'flex-1 text-[15px] text-muted-foreground',
              unread && 'font-semibold text-sidebar-foreground'
            )}
          >
            {name}
          </Text>
          {last && (
            <Text className={cn('text-xs', unread ? 'text-primary' : 'text-muted-foreground')}>
              {formatDate(last) === 'Today' ? formatTime(last) : formatDate(last)}
            </Text>
          )}
          {voiceStates[entry.id]?.length ? (
            <Icon as={Phone} size={14} className="text-green-500" accessibilityLabel="In a call" />
          ) : null}
          {unread && <View className="size-2 rounded-full bg-primary" />}
        </Pressable>
      </ReanimatedSwipeable>
    );
  };

  return (
    <View className="flex-1 bg-sidebar">
      <View
        className="shrink-0 flex-row items-center border-b border-border pr-1 pl-4"
        style={{ minHeight: 52 + insets.top, paddingTop: insets.top }}
      >
        <Text className="flex-1 text-[15px] font-semibold text-sidebar-foreground">Messages</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a direct message"
          onPress={() => setNewDmOpen(true)}
          className="size-11 items-center justify-center active:bg-accent"
        >
          <Icon as={Plus} size={20} className="text-muted-foreground" />
        </Pressable>
      </View>
      <FlashList
        data={entries}
        keyExtractor={(entry) => entry.id}
        renderItem={({ item }) => row(item)}
        extraData={[voiceStates, circleIcons]}
        refreshing={loading}
        onRefresh={() => void dms().load()}
        contentContainerStyle={{ paddingVertical: 8 }}
        ListHeaderComponent={
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={requests ? `Friends, ${requests} pending requests` : 'Friends'}
              onPress={() => goto('/guilds/friends')}
              className="min-h-14 flex-row items-center gap-3 px-3 active:bg-accent"
            >
              <View
                className={cn(
                  'size-10 items-center justify-center bg-muted',
                  circleIcons && 'rounded-full'
                )}
              >
                <Icon as={Users} size={20} className="text-muted-foreground" />
              </View>
              <Text className="flex-1 text-[15px] font-medium">Friends</Text>
              {requests > 0 && (
                <View
                  className={cn('min-w-5 bg-destructive px-1.5', circleIcons && 'rounded-full')}
                >
                  <Text className="text-center text-xs leading-5 font-bold text-white">
                    {requests}
                  </Text>
                </View>
              )}
              <Icon as={ChevronRight} size={18} className="text-muted-foreground" />
            </Pressable>
            <Text className="px-4 pt-4 pb-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Direct Messages
            </Text>
          </>
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
            {entries.length === 0 && pending.length === 0 && (
              <Text className="mt-4 px-4 text-center text-xs text-muted-foreground">
                No direct messages yet. Start one from a friend's profile.
              </Text>
            )}
          </>
        }
      />

      <Sheet
        open={menu === 'actions'}
        onClose={() => setMenu((current) => (current === 'actions' ? null : current))}
      >
        <SheetItem label="Notification Settings" onPress={() => setMenu('notify')} />
        <SheetItem
          icon={X}
          label="Close Direct Message"
          destructive
          onPress={() => {
            if (menuEntry) closeDm(menuEntry);
            setMenu(null);
          }}
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
