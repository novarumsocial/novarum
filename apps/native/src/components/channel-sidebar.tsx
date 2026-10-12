// Port of apps/frontend/src/lib/components/channel-sidebar.svelte
// Differences: long-press a channel for a sheet (the web's right-click menu); channels move with "Move up /
// Move down" instead of drag and drop; web stubs (leave guild, delete, pin, duplicate, mark as read) are hidden.
import { FlashList } from '@shopify/flash-list';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  ArrowDown,
  ArrowUp,
  Bell,
  ChevronDown,
  ChevronRight,
  Hash,
  HeadphoneOff,
  IdCardLanyard,
  Link,
  MicOff,
  Pencil,
  Plus,
  Settings,
  UserRoundPlus,
  Volume2,
} from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { CreateChannelDialog } from '@/components/create-channel-dialog';
import { EditChannelDialog } from '@/components/edit-channel-dialog';
import { GuildSettingsDialog } from '@/components/guild-settings-dialog';
import { InviteDialog } from '@/components/invite-dialog';
import { NotificationMenu } from '@/components/notification-menu';
import { ProfileCard } from '@/components/profile-card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { chat, guildPath } from '@/lib/chat-state';
import { useNotificationSettings } from '@/lib/notification-settings';
import { useSettings } from '@/lib/settings';
import type { Author, Channel, ChannelCategory, Server } from '@/lib/types/chat';
import { fallbackAvatarBg, initialsFor } from '@/lib/voice-layout';
import { useVoice } from '@/lib/voice';
import { cn } from '@/lib/utils';

type Row =
  | { kind: 'category'; category: ChannelCategory }
  | { kind: 'channel'; channel: Channel; category: ChannelCategory };
type Menu =
  | 'guild'
  | 'guildNotify'
  | 'channel'
  | 'channelNotify'
  | 'invite'
  | 'create'
  | 'edit'
  | 'settings';

export function ChannelSidebar({
  server,
  categories,
  activeChannel,
  onSelectChannel,
  members = [],
  voiceStates = {},
}: {
  server: Server;
  categories: ChannelCategory[];
  activeChannel: string | null;
  onSelectChannel: (id: string) => void;
  members?: Author[];
  voiceStates?: Record<string, { userId: string; name: string | null }[]>;
}) {
  const insets = useSafeAreaInsets();
  const circleIcons = useSettings((s) => s.circleIcons);
  const voiceChannelId = useVoice((s) => s.channelId);
  const voiceUserStates = useVoice((s) => s.voiceStates);
  const levels = useNotificationSettings((s) => s.entries); // re-render when levels change
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<Menu | null>(null);
  const [category, setCategory] = useState<ChannelCategory | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const closeIf = (name: Menu) => () => setMenu((current) => (current === name ? null : current));
  const open = (name: Menu, next?: { channel?: Channel; category?: ChannelCategory }) => {
    if (next?.channel) setChannel(next.channel);
    if (next?.category) setCategory(next.category);
    setMenu(name);
  };

  const rows: Row[] = categories.flatMap((cat) => [
    { kind: 'category' as const, category: cat },
    ...(collapsed[cat.id]
      ? []
      : cat.channels.map((ch) => ({ kind: 'channel' as const, channel: ch, category: cat }))),
  ]);

  const memberFor = (userId: string) => members.find((member) => member.userId === userId);
  const nameFor = (userId: string) => {
    const member = memberFor(userId);
    return member?.displayName || member?.username || userId;
  };

  function voiceUsersFor(channelId: string) {
    const users = [...(voiceStates[channelId] ?? [])];
    if (voiceChannelId === channelId) {
      for (const userId of voiceUserStates.keys()) {
        if (!users.some((user) => user.userId === userId)) {
          users.push({ userId, name: nameFor(userId) });
        }
      }
    }
    return users;
  }

  // swap a channel with its neighbour inside its category, then save the order of all channels
  function move(by: -1 | 1) {
    if (!channel || !category) return;
    const ids = categories.flatMap((cat) => {
      const list = cat.channels.map((item) => item.id);
      const index = list.indexOf(channel.id);
      if (cat.id === category.id && list[index + by]) {
        [list[index], list[index + by]] = [list[index + by]!, list[index]!];
      }
      return list;
    });
    chat().reorderChannels(server.id, ids);
    void chat().saveChannelOrder(server.id, ids);
    setMenu(null);
  }

  const copy = (text: string) => {
    void Clipboard.setStringAsync(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setMenu(null);
  };

  const siblings = category?.channels ?? [];
  const position = channel ? siblings.findIndex((item) => item.id === channel.id) : -1;

  function renderChannel({ channel: ch }: { channel: Channel }) {
    const target = { channelId: ch.id, guildId: server.id };
    const showMention = ch.mention > 0 && useNotificationSettings.getState().showsMentions(target);
    const showUnread = ch.unread && useNotificationSettings.getState().showsUnread(target);
    const highlighted = showUnread || showMention;
    const connected = ch.type === 'VOICE' ? voiceUsersFor(ch.id) : [];

    return (
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${ch.type === 'VOICE' ? 'Voice channel' : 'Channel'} ${ch.label || ch.name}${showMention ? `, ${ch.mention} mentions` : showUnread ? ', unread' : ''}`}
          accessibilityState={{ selected: activeChannel === ch.id }}
          onPress={() => onSelectChannel(ch.id)}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            open('channel', {
              channel: ch,
              category: categories.find((cat) => cat.channels.some((item) => item.id === ch.id)),
            });
          }}
          className={cn(
            'min-h-11 flex-row items-center gap-1.5 px-2',
            activeChannel === ch.id ? 'bg-primary/10' : 'active:bg-accent'
          )}
        >
          <Icon
            as={ch.type === 'VOICE' ? Volume2 : Hash}
            className={
              highlighted || activeChannel === ch.id
                ? 'text-sidebar-foreground'
                : 'text-muted-foreground'
            }
          />
          <Text
            numberOfLines={1}
            className={cn(
              'flex-1 text-sm',
              highlighted || activeChannel === ch.id
                ? 'text-sidebar-foreground'
                : 'text-muted-foreground',
              highlighted && 'font-semibold'
            )}
          >
            {ch.label || ch.name}
          </Text>
          {showMention ? (
            <View
              className={cn(
                'size-5 items-center justify-center bg-destructive',
                circleIcons && 'rounded-full'
              )}
            >
              <Text className="text-[11px] font-bold text-destructive-foreground">
                {ch.mention > 99 ? '99+' : ch.mention}
              </Text>
            </View>
          ) : showUnread ? (
            <View className={cn('size-2 bg-foreground/80', circleIcons && 'rounded-full')} />
          ) : null}
        </Pressable>

        {connected.map((state) => {
          const name = state.name || nameFor(state.userId);
          const user = memberFor(state.userId);
          const voiceState =
            voiceChannelId === ch.id ? voiceUserStates.get(state.userId) : undefined;
          const row = (
            <View className="min-h-11 flex-row items-center gap-1.5 pr-2 pl-8">
              <View>
                <Avatar
                  src={user?.avatarUrl}
                  name={name}
                  fallback={initialsFor(state.userId)}
                  bgColor={user?.avatarColor ?? fallbackAvatarBg(state.userId)}
                  className="size-6"
                />
                {voiceState?.speaking && (
                  <View
                    pointerEvents="none"
                    className={cn('absolute inset-0 border-2', circleIcons && 'rounded-full')}
                    style={{ borderColor: user?.speakingRingColor ?? '#00d492' }}
                  />
                )}
              </View>
              <Text numberOfLines={1} className="flex-1 text-sm text-muted-foreground">
                {name}
              </Text>
              {voiceState?.selfMuted && <Icon as={MicOff} size={14} className="text-rose-400" />}
              {voiceState?.selfDeafened && (
                <Icon as={HeadphoneOff} size={14} className="text-rose-400" />
              )}
            </View>
          );
          return user ? (
            <ProfileCard key={state.userId} user={user}>
              {row}
            </ProfileCard>
          ) : (
            <View key={state.userId}>{row}</View>
          );
        })}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sidebar">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Server settings"
        onPress={() => open('guild')}
        className="shrink-0 flex-row items-center justify-between border-b border-border px-4 active:bg-accent"
        style={{ minHeight: 48 + insets.top, paddingTop: insets.top }}
      >
        <Text
          numberOfLines={1}
          className="flex-1 text-sm font-semibold tracking-tight text-sidebar-foreground"
        >
          {server.name}
        </Text>
        <Icon as={ChevronDown} className="text-muted-foreground" />
      </Pressable>

      <FlashList
        data={rows}
        extraData={[
          collapsed,
          voiceChannelId,
          voiceUserStates,
          voiceStates,
          members,
          levels,
          activeChannel,
          circleIcons,
        ]}
        keyExtractor={(row) => (row.kind === 'category' ? `c:${row.category.id}` : row.channel.id)}
        getItemType={(row) => row.kind}
        contentContainerStyle={{ paddingVertical: 8 }}
        renderItem={({ item }) =>
          item.kind === 'channel' ? (
            renderChannel(item)
          ) : (
            <View className="min-h-11 flex-row items-center px-3">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.category.label}
                accessibilityState={{ expanded: !collapsed[item.category.id] }}
                onPress={() =>
                  setCollapsed((current) => ({
                    ...current,
                    [item.category.id]: !current[item.category.id],
                  }))
                }
                className="min-h-11 flex-1 flex-row items-center gap-1"
              >
                <Icon
                  as={collapsed[item.category.id] ? ChevronRight : ChevronDown}
                  size={12}
                  className="text-muted-foreground"
                />
                <Text className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {item.category.label}
                </Text>
              </Pressable>
              {server.canManageChannels && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add channel"
                  onPress={() => open('create', { category: item.category })}
                  className="size-11 items-center justify-center"
                >
                  <Icon as={Plus} size={14} className="text-muted-foreground" />
                </Pressable>
              )}
            </View>
          )
        }
      />

      <Sheet open={menu === 'guild'} onClose={closeIf('guild')}>
        <Text className="px-4 pt-2 pb-1 text-sm font-medium" numberOfLines={1}>
          {server.name}
        </Text>
        {server.canManageChannels && (
          <>
            <SheetItem icon={UserRoundPlus} label="Invite" onPress={() => open('invite')} />
            <SheetItem
              icon={Plus}
              label="Create Channel"
              disabled={categories.length === 0}
              onPress={() => open('create', { category: categories[0] })}
            />
            <SheetItem icon={Settings} label="Settings" onPress={() => open('settings')} />
          </>
        )}
        <SheetItem icon={Bell} label="Notification Settings" onPress={() => open('guildNotify')} />
        <SheetItem icon={IdCardLanyard} label="Copy Guild ID" onPress={() => copy(server.id)} />
      </Sheet>
      <NotificationMenu
        open={menu === 'guildNotify'}
        onClose={closeIf('guildNotify')}
        targetId={server.id}
        noun="Server"
      />

      <Sheet open={menu === 'channel'} onClose={closeIf('channel')}>
        <Text className="px-4 pt-2 pb-1 text-sm font-medium" numberOfLines={1}>
          {channel?.label || channel?.name}
        </Text>
        <SheetItem
          icon={Link}
          label="Copy Link"
          onPress={() =>
            channel && copy(`https://app.novarum.me${guildPath(server.id, channel.id)}`)
          }
        />
        <SheetItem
          icon={Bell}
          label="Notification Settings"
          onPress={() => open('channelNotify')}
        />
        <SheetItem icon={Pencil} label="Edit Channel" onPress={() => open('edit')} />
        {server.canManageChannels && (
          <>
            <SheetItem
              icon={ArrowUp}
              label="Move up"
              disabled={position <= 0}
              onPress={() => move(-1)}
            />
            <SheetItem
              icon={ArrowDown}
              label="Move down"
              disabled={position < 0 || position >= siblings.length - 1}
              onPress={() => move(1)}
            />
          </>
        )}
        <SheetItem
          icon={IdCardLanyard}
          label="Copy Channel ID"
          onPress={() => channel && copy(channel.id)}
        />
      </Sheet>
      {channel && (
        <NotificationMenu
          open={menu === 'channelNotify'}
          onClose={closeIf('channelNotify')}
          targetId={channel.id}
          guildId={server.id}
          noun="Channel"
        />
      )}

      <CreateChannelDialog
        open={menu === 'create'}
        onClose={closeIf('create')}
        categoryLabel={category?.label}
        onCreate={async (created) => {
          const result = await chat().createChannel(
            server.id,
            created,
            created.type === 'VOICE' ? 'VOICE' : 'TEXT'
          );
          if (result) onSelectChannel(result.id);
        }}
      />
      <InviteDialog open={menu === 'invite'} onClose={closeIf('invite')} guildId={server.id} />
      <GuildSettingsDialog
        open={menu === 'settings'}
        onClose={closeIf('settings')}
        server={server}
      />
      <EditChannelDialog open={menu === 'edit'} onClose={closeIf('edit')} channel={channel} />
    </View>
  );
}
