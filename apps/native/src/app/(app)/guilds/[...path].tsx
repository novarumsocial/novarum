// Port of apps/frontend/src/lib/components/app-shell.svelte (the part below the boot) on the single `guilds/[...path]` route:
// home (friends), DMs and every guild channel. The three panels come from `Panels`.
import { router, useLocalSearchParams } from 'expo-router';
import { ConnectionState } from 'livekit-client';
import { useEffect, useLayoutEffect, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';
import { CallRinging } from '@/components/call-ringing';
import { ChannelSidebar } from '@/components/channel-sidebar';
import { ChatArea } from '@/components/chat-area';
import { DmSidebar } from '@/components/dm-sidebar';
import { FriendsHome } from '@/components/friends-home';
import { GuildSidebar } from '@/components/guild-sidebar';
import { MemberSidebar } from '@/components/member-sidebar';
import { Panels } from '@/components/panels';
import { Text } from '@/components/ui/text';
import { UserArea } from '@/components/user-area';
import { VoiceArea } from '@/components/voice-area';
import {
  chat,
  guildPath,
  routeFromPath,
  selectActiveChannel,
  selectActiveServer,
  selectCurrentCategories,
  selectCurrentChannel,
  selectCurrentMessages,
  selectCurrentMessagesLoading,
  selectCurrentServer,
  useChat,
} from '@/lib/chat-state';
import { dmPath, dms, useDms } from '@/lib/dms';
import { goto } from '@/lib/navigation';
import { panels } from '@/lib/panels';
import { realtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import type { Author } from '@/lib/types/chat';
import { useGuildMentions, useHasUnreadDms } from '@/lib/unread';
import { useVoice, voice } from '@/lib/voice';

// `[...path]` is an array, or a plain string when there is only one segment
const pathSchema = z
  .string()
  .transform((path) => [path])
  .or(z.array(z.string()))
  .catch([]);

export default function Guilds() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const path = pathSchema.parse(useLocalSearchParams<{ path?: string[] }>().path);
  const key = path.join('/');

  const currentUser = useSession((s) => s.user);
  const route = useChat((s) => s.route);
  const servers = useChat((s) => s.servers);
  const members = useChat((s) => s.members);
  const voiceStates = useChat((s) => s.voiceStates);
  const channelsByServer = useChat((s) => s.channelsByServer);
  const activeServer = useChat(selectActiveServer);
  const activeChannel = useChat(selectActiveChannel);
  const currentServer = useChat(selectCurrentServer);
  const currentCategories = useChat(selectCurrentCategories);
  const currentChannel = useChat(selectCurrentChannel);
  const currentMessages = useChat(selectCurrentMessages);
  const currentMessagesLoading = useChat(selectCurrentMessagesLoading);
  const dmList = useDms((s) => s.list);
  const voiceChannelId = useVoice((s) => s.channelId);
  const guildMentions = useGuildMentions();
  const hasUnreadDms = useHasUnreadDms();
  const [callExpanded, setCallExpanded] = useState(false);

  // the route comes from the URL on the web; here this screen hands it to the chat store
  useLayoutEffect(() => chat().setRoute(routeFromPath(path)), [key]);

  // `/guilds/<server>` without a channel opens the server's first channel
  useEffect(() => {
    if (route.kind !== 'guild' || route.channelId || !currentServer) return;
    const first = currentCategories[0]?.channels.find((channel) => channel.type === 'TEXT');
    if (first) router.replace(guildPath(currentServer.id, first.id) as never);
  }, [route, currentServer, currentCategories]);

  useEffect(() => chat().syncActiveChannel(), [currentChannel?.id]);

  const callMembers: Author[] =
    route.kind === 'dms' && currentUser
      ? [
          { ...currentUser, userId: currentUser.id, server: currentUser.homeserver },
          ...(dmList
            .find((dm) => dm.id === activeChannel)
            ?.participants.map(({ homeserver, ...user }) => ({ ...user, server: homeserver })) ??
            []),
        ]
      : members;

  const voiceChannelName =
    Object.values(channelsByServer)
      .flat()
      .flatMap((category) => category.channels)
      .find((channel) => channel.id === voiceChannelId)?.name ??
    (voiceChannelId ? dms().get(voiceChannelId)?.participants[0]?.username : null) ??
    null;

  function startCall(id: string) {
    // phones have no room for the call and the chat side by side, so start it expanded.
    if (width < 768) setCallExpanded(true);
    const ring = !chat().voiceStates[id]?.length;
    void voice()
      .join(id)
      .then(() => {
        if (ring && voice().channelId === id) realtime().ringCall(id);
      })
      .catch(() => null);
  }

  function selectChannel(id: string) {
    const channel = selectCurrentCategories(chat())
      .flatMap((category) => category.channels)
      .find((item) => item.id === id);
    if (!channel) return;

    panels().close();
    // if you squint you'll understand...
    if (
      channel.type !== 'VOICE' ||
      (voice().connectionState !== ConnectionState.Disconnected && voice().channelId === id)
    ) {
      chat().selectChannel(id);
    }
    if (channel.type === 'VOICE')
      void voice()
        .join(id)
        .catch(() => null);
  }

  const leaveVoice = () => void voice().leave();
  const openNavigation = () => panels().openLeft();
  const openMembers = () => panels().openRight();

  const left = (
    <View className="flex-1">
      <View className="min-h-0 flex-1 flex-row">
        <GuildSidebar
          servers={servers}
          activeId={activeServer}
          mentions={guildMentions}
          hasUnreadDms={hasUnreadDms}
          onSelect={(id) => chat().selectServer(id)}
        />
        <View className="flex-1">
          {currentServer ? (
            <ChannelSidebar
              server={currentServer}
              categories={currentCategories}
              activeChannel={activeChannel}
              onSelectChannel={selectChannel}
              members={members}
              voiceStates={voiceStates}
            />
          ) : route.kind === 'home' || route.kind === 'dms' ? (
            <DmSidebar />
          ) : null}
        </View>
      </View>
      {currentUser && (
        <UserArea
          user={currentUser}
          voiceChannelName={voiceChannelName}
          onLeaveVoice={leaveVoice}
        />
      )}
    </View>
  );

  const center =
    route.kind === 'home' ? (
      <FriendsHome onOpenNavigation={openNavigation} />
    ) : currentChannel && (currentChannel.type === 'TEXT' || currentChannel.type === 'DM') ? (
      <ChatArea
        channel={currentChannel}
        messages={currentMessages}
        loading={currentMessagesLoading}
        onSend={(content, files, replyTo) =>
          chat().sendMessage(currentChannel.id, content, files, replyTo)
        }
        onDelete={(messageId) => chat().deleteMessage(currentChannel.id, messageId)}
        onEdit={(messageId, content) => chat().editMessage(currentChannel.id, messageId, content)}
        onOpenNavigation={openNavigation}
        onOpenMembers={openMembers}
        onCall={() => startCall(currentChannel.id)}
        onRing={() => realtime().ringCall(currentChannel.id)}
        call={
          currentChannel.type === 'DM' && voiceChannelId === currentChannel.id ? (
            <VoiceArea
              channel={currentChannel}
              members={callMembers}
              onJoin={() => startCall(currentChannel.id)}
              onLeave={() => {
                setCallExpanded(false);
                leaveVoice();
              }}
              embedded
              expanded={callExpanded}
              onToggleExpand={() => setCallExpanded((expanded) => !expanded)}
            />
          ) : undefined
        }
        callExpanded={callExpanded}
      />
    ) : currentChannel && currentChannel.type === 'VOICE' ? (
      <VoiceArea
        channel={currentChannel}
        members={members}
        onJoin={() =>
          void voice()
            .join(currentChannel.id)
            .catch(() => null)
        }
        onLeave={leaveVoice}
        onOpenNavigation={openNavigation}
        onOpenMembers={openMembers}
      />
    ) : (
      <View
        className="min-w-0 flex-1 items-center justify-center bg-background px-6"
        style={{ paddingTop: insets.top }}
      >
        {width < 768 && (
          <Pressable
            onPress={openNavigation}
            className="absolute left-3 min-h-11 justify-center border border-border px-3"
            style={{ top: insets.top + 12 }}
          >
            <Text className="text-sm font-medium">Browse channels</Text>
          </Pressable>
        )}
        <View className="max-w-sm items-center">
          <Text className="text-sm font-medium">
            {route.kind === 'dms' ? 'No conversation selected' : 'No channel selected'}
          </Text>
          <Text className="mt-1 text-center text-sm text-muted-foreground">
            {route.kind === 'dms'
              ? 'Pick a direct message to begin.'
              : 'Pick a server or create one to begin.'}
          </Text>
        </View>
      </View>
    );

  return (
    <>
      <Panels
        left={left}
        right={
          route.kind === 'guild' && currentServer ? (
            <MemberSidebar server={currentServer} members={members} />
          ) : undefined
        }
      >
        {center}
      </Panels>
      <CallRinging
        onAccept={(id) => {
          goto(dmPath(id));
          startCall(id);
        }}
      />
    </>
  );
}
