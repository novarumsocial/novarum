// The hub: the first screen of the chat stack (the web's left column). The guild rail picks a server, next to it
// are that server's channels, or your DMs and friends for Home. Opening a channel pushes the channel screen.
// Switching to a server shows its channel list with the channel you were last in there selected (swipe left to
// open it, or on Home the last DM), and a launch reopens the chat that was open when the app closed.
import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { ChannelSidebar } from '@/components/channel-sidebar';
import { DmSidebar } from '@/components/dm-sidebar';
import { GuildSidebar } from '@/components/guild-sidebar';
import { UserArea } from '@/components/user-area';
import {
  channelPath,
  chat,
  guildPath,
  lastGuildChannel,
  lastChat,
  lastHubServer,
  useChannelName,
  useChat,
} from '@/lib/chat-state';
import { dmPath, dms, type DmEntry } from '@/lib/dms';
import { goto } from '@/lib/navigation';
import { useSession } from '@/lib/session';
import type { ChannelCategory } from '@/lib/types/chat';
import { useGuildMentions, useGuildUnread, useHasUnreadDms } from '@/lib/unread';
import { useVoice, voice } from '@/lib/voice';

const noCategories: ChannelCategory[] = [];
const leaveVoice = () => void voice().leave();
let restored = false;

export default function Hub() {
  const user = useSession((s) => s.user);
  const servers = useChat((s) => s.servers);
  const hubServer = useChat((s) => s.hubServer);
  const categories = useChat((s) =>
    hubServer ? (s.channelsByServer[hubServer] ?? noCategories) : noCategories
  );
  const members = useChat((s) => s.members);
  const voiceStates = useChat((s) => s.voiceStates);
  const voiceChannelName = useChannelName(useVoice((s) => s.channelId));
  const guildMentions = useGuildMentions();
  const guildUnread = useGuildUnread();
  const navigation = useNavigation();
  const hasUnreadDms = useHasUnreadDms();
  const server = servers.find((item) => item.id === hubServer) ?? null;

  // the guild's members, for the avatars in its voice channels and its settings
  const firstChannel = categories[0]?.channels[0]?.id;
  useEffect(() => {
    if (firstChannel) void chat().loadMembers(firstChannel);
  }, [firstChannel]);

  // back where you left off, once per launch (before the focus effect below forgets the last chat); not when a
  // link already opened a chat over the hub
  useEffect(() => {
    if (restored) return;
    restored = true;
    const server = lastHubServer();
    if (server && chat().servers.some((item) => item.id === server)) chat().selectServer(server);
    const channelId = lastChat();
    const path = channelId && channelPath(channelId);
    if (path && path !== '/guilds' && navigation.isFocused()) goto(path);
  }, [navigation]);

  // no channel is open while the hub is on screen (notifications and unread marks follow this)
  useFocusEffect(useCallback(() => chat().setRoute({ kind: 'home' }), []));

  const selectServer = useCallback((id?: string) => chat().selectServer(id), []);
  const serverId = server?.id;
  const openChannel = useCallback((id: string) => goto(guildPath(serverId, id)), [serverId]);

  // swipe left on the channel list to open the selected channel (the last one you were in, or the first), or on
  // Home the last DM you were in (or the most recent one)
  const openSelected = () => {
    if (!serverId) {
      const list = dms().list;
      const last = list.find((item) => item.id === lastGuildChannel('dms'));
      const recent = (item: DmEntry) => new Date(item.lastMessageAt ?? item.joinedAt).getTime();
      const dm = last ?? [...list].sort((a, b) => recent(b) - recent(a))[0];
      if (dm) goto(dmPath(dm.id));
      return;
    }
    const text = categories
      .flatMap((category) => category.channels)
      .filter((item) => item.type !== 'VOICE');
    const channel = text.find((item) => item.id === lastGuildChannel(serverId)) ?? text[0];
    if (channel) openChannel(channel.id);
  };
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX(-15)
    .failOffsetX(15)
    .failOffsetY([-15, 15])
    .onEnd((event) => {
      if (event.translationX < -60 || event.velocityX < -800) openSelected();
    });

  return (
    <View className="flex-1 bg-sidebar">
      <View className="min-h-0 flex-1 flex-row">
        <GuildSidebar
          servers={servers}
          activeId={server?.id ?? null}
          mentions={guildMentions}
          unread={guildUnread}
          hasUnreadDms={hasUnreadDms}
          onSelect={selectServer}
        />
        <GestureDetector gesture={swipe}>
          <View className="flex-1">
            {/* Home's list stays mounted while a server is open, so switching back to it is instant */}
            <View className="flex-1" style={server ? { display: 'none' } : undefined}>
              <DmSidebar />
            </View>
            {server && (
              <ChannelSidebar
                server={server}
                categories={categories}
                onSelectChannel={openChannel}
                members={members}
                voiceStates={voiceStates}
              />
            )}
          </View>
        </GestureDetector>
      </View>
      {user && (
        <UserArea user={user} voiceChannelName={voiceChannelName} onLeaveVoice={leaveVoice} />
      )}
    </View>
  );
}
