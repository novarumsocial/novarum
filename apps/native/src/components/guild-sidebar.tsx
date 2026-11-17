// Port of apps/frontend/src/lib/components/guild-sidebar.svelte
// Differences: reordering is a "Reorder servers" sheet with up/down buttons per server instead of drag and drop;
// unread DMs light up Home (with a count) instead of being added to the rail, so the rail never reshuffles;
// "Add a server" offers create or join with an invite link; a server whose homeserver is down says so on tap.
import * as Haptics from 'expo-haptics';
import { ArrowDown, ArrowDownUp, ArrowUp, Bell, Link, Plus, WifiOff } from 'lucide-react-native';
import { memo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { CreateServerDialog } from '@/components/create-server-dialog';
import { JoinServerDialog } from '@/components/join-server-dialog';
import { NotificationMenu } from '@/components/notification-menu';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { chat, useChat } from '@/lib/chat-state';
import type { DmEntry } from '@/lib/dms';
import { useSettings } from '@/lib/settings';
import { useThemeColors } from '@/lib/theme';
import { toast } from '@/lib/toast';
import type { Server } from '@/lib/types/chat';
import { cn } from '@/lib/utils';
import { fallbackAvatarBg } from '@/lib/voice-layout';

// the Novarum logo, for Home (your DMs)
const homePath =
  'M23,16a1,1,0,0,1-1,1H2a1,1,0,0,1,0-2H22A1,1,0,0,1,23,16Zm-5,5a1,1,0,0,0,0-2H6a1,1,0,0,0,0,2ZM7,12a1,1,0,0,0,2,0,3,3,0,0,1,6,0,1,1,0,0,0,2,0A5,5,0,0,0,7,12Zm4-7a1,1,0,0,0,2,0V4a1,1,0,0,0-2,0Zm7,7a1,1,0,0,0,1,1h1a1,1,0,0,0,0-2H19A1,1,0,0,0,18,12ZM4,11a1,1,0,0,0,0,2H5a1,1,0,0,0,0-2ZM5.636,5.636a1,1,0,0,0,0,1.414l.707.707A1,1,0,0,0,7.757,6.343L7.05,5.636A1,1,0,0,0,5.636,5.636Zm11.314,0-.707.707a1,1,0,1,0,1.414,1.414l.707-.707A1,1,0,1,0,16.95,5.636Z';

// the bar at the rail's edge: tall for the open server, a short one for unread
function Pill({ active, unread }: { active: boolean; unread: boolean }) {
  if (!active && !unread) return null;
  return (
    <View
      pointerEvents="none"
      className={cn(
        'absolute top-1/2 left-0 w-1.5 rounded-r-full bg-foreground',
        active ? '-mt-5 h-10' : '-mt-2 h-4'
      )}
    />
  );
}

function Badge({ count }: { count: number }) {
  const circleIcons = useSettings((s) => s.circleIcons);
  return (
    <View
      pointerEvents="none"
      className={cn(
        'absolute right-1 -bottom-1 h-6 min-w-6 items-center justify-center border-[3px] border-background bg-sidebar-primary px-1',
        circleIcons && 'rounded-full'
      )}
    >
      <Text className="text-xs leading-none font-bold text-sidebar-primary-foreground">
        {count > 99 ? '99+' : count}
      </Text>
    </View>
  );
}

// memo: the hub stays drawn under a chat (for the swipe back), so it shouldn't redo the rail on every store change
export const GuildSidebar = memo(function GuildSidebar({
  servers,
  activeId,
  mentions,
  unread = {},
  unreadDms = [],
  onSelect,
}: {
  servers: Server[];
  activeId: string | null;
  mentions: Record<string, number>;
  unread?: Record<string, boolean>;
  unreadDms?: DmEntry[];
  onSelect: (id?: string) => void;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [menuServer, setMenuServer] = useState<Server | null>(null);
  const [menu, setMenu] = useState<
    'actions' | 'notify' | 'reorder' | 'add' | 'create' | 'join' | null
  >(null);
  const closeIf = (name: typeof menu) => () =>
    setMenu((current) => (current === name ? null : current));

  const ordered = servers.filter((server) => server.id !== 'home');

  // the web drags tiles; here the reorder sheet swaps a server with its neighbour
  const move = (index: number, by: -1 | 1) => {
    const next = [...ordered];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    useChat.setState({ servers: next });
    void chat().reorderGuilds(next.map((server) => server.id));
    void Haptics.selectionAsync();
  };

  const homeActive = activeId === null;

  return (
    <View
      className="w-[72px] items-center gap-2 bg-background pb-3"
      style={{ paddingTop: insets.top + 8 }}
    >
      <View className="w-full items-center">
        <Pill active={homeActive} unread={unreadDms.length > 0} />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: homeActive }}
          onPress={() => onSelect(undefined)}
          accessibilityLabel={
            unreadDms.length ? `Direct messages, ${unreadDms.length} unread` : 'Direct messages'
          }
          className={cn(
            'size-12 items-center justify-center active:opacity-80',
            homeActive ? 'bg-primary' : 'bg-card',
            circleIcons && 'rounded-full'
          )}
        >
          <Svg
            width={26}
            height={26}
            viewBox="0 0 24 24"
            fill={homeActive ? colors['primary-foreground'] : colors['muted-foreground']}
          >
            <Path d={homePath} />
          </Svg>
        </Pressable>
        {unreadDms.length > 0 && <Badge count={unreadDms.length} />}
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
                accessibilityState={{ selected: active }}
                onPress={() =>
                  server.down
                    ? toast(`${server.name} is unreachable right now. Try again later.`, {
                        tone: 'error',
                      })
                    : onSelect(server.id)
                }
                onLongPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  setMenuServer(server);
                  setMenu('actions');
                }}
                accessibilityHint="Long-press for more actions"
                accessibilityLabel={[
                  server.name,
                  server.down && 'unreachable',
                  mention && `${mention} unread mention${mention === 1 ? '' : 's'}`,
                  !mention && unread[server.id] && 'unread',
                ]
                  .filter(Boolean)
                  .join(', ')}
                className={cn(
                  'size-12 items-center justify-center overflow-hidden active:opacity-80',
                  circleIcons && 'rounded-full'
                )}
              >
                <Avatar
                  src={server.avatarUrl}
                  name={server.name}
                  fallback={server.initials}
                  bgColor={server.avatarUrl ? undefined : fallbackAvatarBg(server.id)}
                  className={cn('size-full', server.down && 'opacity-40')}
                  focused={active}
                />
                {server.down && (
                  <View className="absolute inset-0 items-center justify-center">
                    <Icon as={WifiOff} size={20} className="text-destructive" />
                  </View>
                )}
              </Pressable>
              {mention > 0 && <Badge count={mention} />}
            </View>
          );
        })}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a server"
          onPress={() => setMenu('add')}
          className={cn(
            'size-12 items-center justify-center self-center bg-card active:opacity-80',
            circleIcons && 'rounded-full'
          )}
        >
          <Icon as={Plus} size={22} className="text-emerald-500" />
        </Pressable>
      </ScrollView>

      <Sheet open={menu === 'add'} onClose={closeIf('add')} title="Add a server">
        <SheetItem icon={Plus} label="Create a server" onPress={() => setMenu('create')} />
        <SheetItem icon={Link} label="Join with an invite link" onPress={() => setMenu('join')} />
      </Sheet>
      <CreateServerDialog open={menu === 'create'} onClose={closeIf('create')} />
      <JoinServerDialog open={menu === 'join'} onClose={closeIf('join')} />

      <Sheet open={menu === 'actions'} onClose={closeIf('actions')} title={menuServer?.name}>
        <SheetItem icon={Bell} label="Notification settings" onPress={() => setMenu('notify')} />
        {ordered.length > 1 && (
          <SheetItem
            icon={ArrowDownUp}
            label="Reorder servers"
            onPress={() => setMenu('reorder')}
          />
        )}
      </Sheet>
      {menuServer && (
        <NotificationMenu
          open={menu === 'notify'}
          onClose={closeIf('notify')}
          targetId={menuServer.id}
          noun="Server"
        />
      )}

      <Sheet open={menu === 'reorder'} onClose={closeIf('reorder')} title="Reorder servers">
        {ordered.map((server, index) => (
          <View key={server.id} className="min-h-14 flex-row items-center gap-3 pr-1 pl-4">
            <Avatar
              src={server.avatarUrl}
              name={server.name}
              fallback={server.initials}
              bgColor={server.avatarUrl ? undefined : fallbackAvatarBg(server.id)}
              className="size-9"
            />
            <Text numberOfLines={1} className="flex-1 text-base">
              {server.name}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Move ${server.name} up`}
              disabled={index === 0}
              onPress={() => move(index, -1)}
              className={cn(
                'size-12 items-center justify-center active:bg-accent',
                index === 0 && 'opacity-30'
              )}
            >
              <Icon as={ArrowUp} size={20} className="text-muted-foreground" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Move ${server.name} down`}
              disabled={index === ordered.length - 1}
              onPress={() => move(index, 1)}
              className={cn(
                'size-12 items-center justify-center active:bg-accent',
                index === ordered.length - 1 && 'opacity-30'
              )}
            >
              <Icon as={ArrowDown} size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
        ))}
      </Sheet>
    </View>
  );
});
