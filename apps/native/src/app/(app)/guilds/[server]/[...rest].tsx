// The channel screen, pushed over the hub: `/guilds/<server>/<channel>[/<message>]` and
// `/guilds/dms/<dm>[/<message>]`. A text channel or DM shows the chat (with the DM call above it),
// a voice channel the call. Port of the center column of apps/frontend/src/lib/components/app-shell.svelte.
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { ChatArea } from '@/components/chat-area';
import { MemberSidebar } from '@/components/member-sidebar';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { VoiceArea } from '@/components/voice-area';
import {
  chat,
  pathSegments,
  routeFromPath,
  selectCurrentChannel,
  selectCurrentMessagesLoading,
  useChat,
} from '@/lib/chat-state';
import { useDms } from '@/lib/dms';
import { realtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import type { Author, Message } from '@/lib/types/chat';
import { startCall, useVoice, voice } from '@/lib/voice';

const noMessages: Message[] = [];

export default function ChannelScreen() {
  const params = useLocalSearchParams<{ server: string; rest: string[] }>();
  const path = [params.server, ...pathSegments.parse(params.rest)];
  const key = path.join('/');
  const { width } = useWindowDimensions();

  // this screen's own route, not the store's: the screen below a pushed one keeps showing its channel
  const route = useMemo(() => routeFromPath(path), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeMessage = route.kind === 'home' ? null : (route.messageId ?? null);

  // the focused screen owns the store's route (loading, read state and notifications follow it)
  useFocusEffect(useCallback(() => chat().setRoute(route), [route]));

  const channel = useChat((s) => selectCurrentChannel({ ...s, route }));
  const messages = useChat((s) => (channel && s.messagesByChannel[channel.id]) || noMessages);
  const loading = useChat((s) => selectCurrentMessagesLoading({ ...s, route }));
  const members = useChat((s) => s.members);
  const showMemberList = useSettings((s) => s.showMemberList);
  const user = useSession((s) => s.user);
  const dm = useDms((s) => s.list.find((item) => item.id === channel?.id));
  const inCall = useVoice((s) => !!channel && s.channelId === channel.id);
  // phones have no room for the call and the chat together, so a call starts full screen
  const [callExpanded, setCallExpanded] = useState(width < 768);

  if (!channel) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader>
          <Text className="text-sm font-semibold">Not found</Text>
        </ScreenHeader>
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-muted-foreground">
            This channel does not exist or you no longer have access to it.
          </Text>
        </View>
      </View>
    );
  }

  const openMembers = () => router.push('/guilds/members');
  const join = () =>
    void voice()
      .join(channel.id)
      .catch(() => null);
  const leave = () => void voice().leave();

  if (channel.type === 'VOICE') {
    return <VoiceArea channel={channel} members={members} onJoin={join} onLeave={leave} />;
  }

  // a DM call shows you and the other person
  const callMembers: Author[] =
    dm && user
      ? [
          { ...user, userId: user.id, server: user.homeserver },
          ...dm.participants.map(({ homeserver, ...other }) => ({ ...other, server: homeserver })),
        ]
      : members;
  const wide = width >= 1024 && channel.type !== 'DM' && showMemberList;

  return (
    <View className="flex-1 flex-row bg-background">
      <ChatArea
        channel={channel}
        messages={messages}
        loading={loading}
        activeMessage={activeMessage}
        onSend={(content, files, replyTo) =>
          chat().sendMessage(channel.id, content, files, replyTo)
        }
        onDelete={(messageId) => chat().deleteMessage(channel.id, messageId)}
        onEdit={(messageId, content) => chat().editMessage(channel.id, messageId, content)}
        onOpenMembers={width < 1024 && channel.type !== 'DM' ? openMembers : undefined}
        onCall={() => {
          if (width < 768) setCallExpanded(true);
          startCall(channel.id);
        }}
        onRing={() => realtime().ringCall(channel.id)}
        call={
          channel.type === 'DM' && inCall ? (
            <VoiceArea
              channel={channel}
              members={callMembers}
              onJoin={() => startCall(channel.id)}
              onLeave={() => {
                setCallExpanded(false);
                leave();
              }}
              embedded
              expanded={callExpanded}
              onToggleExpand={() => setCallExpanded((expanded) => !expanded)}
            />
          ) : undefined
        }
        callExpanded={callExpanded}
      />
      {wide && (
        <View className="w-56 border-l border-border bg-sidebar">
          <MemberSidebar members={members} />
        </View>
      )}
    </View>
  );
}
