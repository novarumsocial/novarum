// Port of apps/frontend/src/lib/components/dm-sidebar.svelte
// Differences: swipe a row left (or long-press it) to close the conversation, pull down to refresh;
// "Friends" is only listed on wide screens, on phones the guild rail's Home button already goes there.
import { FlashList } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { LoaderCircle, Phone, Plus, Users, X } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { NewDmDialog } from '@/components/new-dm-dialog';
import { NotificationMenu } from '@/components/notification-menu';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { useChat } from '@/lib/chat-state';
import { dmPath, dms, useDms, type DmEntry } from '@/lib/dms';
import { friends, useFriends } from '@/lib/friends';
import { goto } from '@/lib/navigation';
import { useNotificationSettings } from '@/lib/notification-settings';
import { panels } from '@/lib/panels';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

export function DmSidebar() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const circleIcons = useSettings((s) => s.circleIcons);
  const list = useDms((s) => s.list);
  const pending = useDms((s) => s.pending);
  const loading = useDms((s) => s.loading);
  const route = useChat((s) => s.route);
  const voiceStates = useChat((s) => s.voiceStates);
  useFriends((s) => s.accepted); // re-render when someone goes online or offline
  useNotificationSettings((s) => s.entries); // re-render when levels change
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [menuEntry, setMenuEntry] = useState<DmEntry | null>(null);
  const [menu, setMenu] = useState<'actions' | 'notify' | null>(null);

  const entries = [...list].sort(
    (a, b) =>
      new Date(b.lastMessageAt ?? b.joinedAt).getTime() -
      new Date(a.lastMessageAt ?? a.joinedAt).getTime()
  );

  const activeId = route.kind === 'dms' ? route.channelId : null;

  function closeDm(entry: DmEntry) {
    void dms().close(entry.id);
    if (entry.id === activeId) goto('/guilds/dms');
  }

  const row = (entry: DmEntry) => {
    const other = entry.participants[0];
    const name = other ? other.displayName || other.username : 'Direct Message';
    const active = entry.id === activeId;
    const unread =
      entry.unread &&
      useNotificationSettings.getState().showsUnread({ channelId: entry.id, guildId: null });

    return (
      <ReanimatedSwipeable
        overshootRight={false}
        renderRightActions={() => (
          <View className="w-20 items-center justify-center bg-destructive">
            <Icon as={X} size={18} className="text-destructive-foreground" />
          </View>
        )}
        onSwipeableOpen={() => closeDm(entry)}
      >
        <Pressable
          onPress={() => {
            goto(dmPath(entry.id));
            panels().close();
          }}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setMenuEntry(entry);
            setMenu('actions');
          }}
          className={cn(
            'min-h-12 flex-row items-center gap-2 bg-sidebar px-2',
            active ? 'bg-primary/10' : 'active:bg-accent'
          )}
        >
          <View>
            <Avatar
              src={other?.avatarUrl}
              name={name}
              bgColor={other?.avatarColor}
              className="size-8"
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
              'flex-1 text-sm',
              active ? 'text-sidebar-foreground' : 'text-muted-foreground',
              unread && 'font-semibold text-sidebar-foreground'
            )}
          >
            {name}
          </Text>
          {voiceStates[entry.id]?.length ? (
            <Icon as={Phone} size={14} className="text-green-500" accessibilityLabel="In a call" />
          ) : null}
          {unread && <View className="size-1.5 rounded-full bg-primary" />}
        </Pressable>
      </ReanimatedSwipeable>
    );
  };

  return (
    <View className="flex-1 bg-sidebar" style={{ paddingTop: insets.top }}>
      <FlashList
        data={entries}
        keyExtractor={(entry) => entry.id}
        renderItem={({ item }) => row(item)}
        extraData={[activeId, voiceStates, circleIcons]}
        refreshing={loading}
        onRefresh={() => void dms().load()}
        contentContainerStyle={{ paddingVertical: 8 }}
        ListHeaderComponent={
          <>
            {width >= 768 && (
              <>
                <Pressable
                  onPress={() => goto('/guilds')}
                  className={cn(
                    'mx-2 min-h-11 flex-row items-center gap-1.5 px-2',
                    route.kind === 'home' ? 'bg-primary/10' : 'active:bg-accent'
                  )}
                >
                  <Icon as={Users} className="text-muted-foreground" />
                  <Text className="flex-1 text-sm text-muted-foreground">Friends</Text>
                </Pressable>
                <View className="mt-3">
                  <Separator />
                </View>
              </>
            )}
            <View className="min-h-11 flex-row items-center justify-between pr-1 pl-4">
              <Text className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Direct Messages
              </Text>
              <Pressable
                accessibilityLabel="Start a direct message"
                onPress={() => setNewDmOpen(true)}
                className="size-11 items-center justify-center"
              >
                <Icon as={Plus} size={16} className="text-muted-foreground" />
              </Pressable>
            </View>
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
