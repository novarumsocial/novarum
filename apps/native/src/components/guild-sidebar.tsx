// Port of apps/frontend/src/lib/components/guild-sidebar.svelte
// Differences: reordering is a long-press sheet with "Move up / Move down" instead of drag and drop.
import * as Haptics from 'expo-haptics';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react-native';
import { memo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { CreateServerDialog } from '@/components/create-server-dialog';
import { NotificationMenu } from '@/components/notification-menu';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { chat, useChat } from '@/lib/chat-state';
import { useSettings } from '@/lib/settings';
import { useThemeColors } from '@/lib/theme';
import type { Server } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

const homePath =
  'M23,16a1,1,0,0,1-1,1H2a1,1,0,0,1,0-2H22A1,1,0,0,1,23,16Zm-5,5a1,1,0,0,0,0-2H6a1,1,0,0,0,0,2ZM7,12a1,1,0,0,0,2,0,3,3,0,0,1,6,0,1,1,0,0,0,2,0A5,5,0,0,0,7,12Zm4-7a1,1,0,0,0,2,0V4a1,1,0,0,0-2,0Zm7,7a1,1,0,0,0,1,1h1a1,1,0,0,0,0-2H19A1,1,0,0,0,18,12ZM4,11a1,1,0,0,0,0,2H5a1,1,0,0,0,0-2ZM5.636,5.636a1,1,0,0,0,0,1.414l.707.707A1,1,0,0,0,7.757,6.343L7.05,5.636A1,1,0,0,0,5.636,5.636Zm11.314,0-.707.707a1,1,0,1,0,1.414,1.414l.707-.707A1,1,0,1,0,16.95,5.636Z';

// the bar at the rail's edge: tall for the open server, a dot for one with unread channels
function Pill({ active, unread }: { active: boolean; unread: boolean }) {
  if (!active && !unread) return null;
  return (
    <View
      pointerEvents="none"
      className={cn(
        'absolute top-1/2 left-0 w-1 rounded-r-full bg-foreground',
        active ? '-mt-5 h-10' : '-mt-1 h-2'
      )}
    />
  );
}

// memo: the hub stays drawn under a chat (for the swipe back), so it shouldn't redo the rail on every store change
export const GuildSidebar = memo(function GuildSidebar({
  servers,
  activeId,
  mentions,
  unread = {},
  hasUnreadDms = false,
  onSelect,
}: {
  servers: Server[];
  activeId: string | null;
  mentions: Record<string, number>;
  unread?: Record<string, boolean>;
  hasUnreadDms?: boolean;
  onSelect: (id?: string) => void;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [createOpen, setCreateOpen] = useState(false);
  const [menuServer, setMenuServer] = useState<Server | null>(null);
  const [menu, setMenu] = useState<'actions' | 'notify' | null>(null);

  const ordered = servers.filter((server) => server.id !== 'home');
  const index = menuServer ? ordered.findIndex((server) => server.id === menuServer.id) : -1;

  // the web drags tiles; here the long-press sheet swaps a tile with its neighbour
  const move = (by: -1 | 1) => {
    const next = [...ordered];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    useChat.setState({ servers: next });
    void chat().reorderGuilds(next.map((server) => server.id));
    setMenu(null);
  };

  return (
    <View
      className="w-[68px] items-center gap-2 bg-background pb-3"
      style={{ paddingTop: insets.top + 8 }}
    >
      <View className="w-full items-center">
        <Pill active={activeId === null} unread={hasUnreadDms} />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: activeId === null }}
          onPress={() => onSelect(undefined)}
          accessibilityLabel={hasUnreadDms ? 'Home, unread direct messages' : 'Home'}
          className={cn(
            'size-12 items-center justify-center active:opacity-80',
            activeId === null ? 'bg-primary' : 'bg-card',
            circleIcons && 'rounded-full'
          )}
        >
          <Svg
            width={26}
            height={26}
            viewBox="0 0 24 24"
            fill={activeId === null ? colors['primary-foreground'] : colors['muted-foreground']}
          >
            <Path d={homePath} />
          </Svg>
        </Pressable>
      </View>

      <View className="h-0.5 w-8 bg-border" />

      <ScrollView
        className="w-full flex-1"
        contentContainerClassName="gap-2 pb-2"
        showsVerticalScrollIndicator={false}
      >
        {ordered.map((server) => {
          const active = activeId === server.id;
          const mention = mentions[server.id] ?? 0;
          return (
            <View key={server.id} className="w-full items-center">
              <Pill active={active} unread={!!unread[server.id]} />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: server.down }}
                disabled={server.down}
                onPress={() => onSelect(server.id)}
                onLongPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  setMenuServer(server);
                  setMenu('actions');
                }}
                accessibilityLabel={
                  mention
                    ? `${server.name}, ${mention} unread mention${mention === 1 ? '' : 's'}`
                    : server.name
                }
                className={cn(
                  'size-12 overflow-hidden active:opacity-80',
                  server.down ? 'bg-destructive opacity-40' : 'bg-card',
                  circleIcons && 'rounded-full'
                )}
              >
                <Avatar
                  src={server.avatarUrl}
                  name={server.name}
                  fallback={server.initials}
                  className="size-full bg-transparent"
                  focused={active}
                />
              </Pressable>
              {mention > 0 && (
                <View
                  pointerEvents="none"
                  className={cn(
                    'absolute right-1.5 -bottom-1 h-5 min-w-5 items-center justify-center border-[3px] border-background bg-destructive px-1',
                    circleIcons && 'rounded-full'
                  )}
                >
                  <Text className="text-[10px] leading-none font-bold text-destructive-foreground">
                    {mention > 99 ? '99+' : mention}
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add server"
        onPress={() => setCreateOpen(true)}
        className={cn(
          'size-12 items-center justify-center bg-card active:opacity-80',
          circleIcons && 'rounded-full'
        )}
      >
        <Icon as={Plus} size={20} className="text-emerald-500" />
      </Pressable>

      <CreateServerDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      <Sheet
        open={menu === 'actions'}
        onClose={() => setMenu((current) => (current === 'actions' ? null : current))}
      >
        <Text className="px-4 pt-2 pb-1 text-sm font-medium" numberOfLines={1}>
          {menuServer?.name}
        </Text>
        <SheetItem icon={ArrowUp} label="Move up" disabled={index <= 0} onPress={() => move(-1)} />
        <SheetItem
          icon={ArrowDown}
          label="Move down"
          disabled={index < 0 || index >= ordered.length - 1}
          onPress={() => move(1)}
        />
        <SheetItem label="Notification Settings" onPress={() => setMenu('notify')} />
      </Sheet>
      {menuServer && (
        <NotificationMenu
          open={menu === 'notify'}
          onClose={() => setMenu(null)}
          targetId={menuServer.id}
          noun="Server"
        />
      )}
    </View>
  );
});
