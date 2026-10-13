// The hub: the first screen of the chat stack (the web's left column). The guild rail picks a server, next to it
// are that server's channels, or your DMs and friends for Home. Opening a channel pushes the channel screen.
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { View } from 'react-native';
import { ChannelSidebar } from '@/components/channel-sidebar';
import { DmSidebar } from '@/components/dm-sidebar';
import { GuildSidebar } from '@/components/guild-sidebar';
import { UserArea } from '@/components/user-area';
import { chat, guildPath, useChannelName, useChat } from '@/lib/chat-state';
import { goto } from '@/lib/navigation';
import { useSession } from '@/lib/session';
import type { ChannelCategory } from '@/lib/types/chat';
import { useGuildMentions, useHasUnreadDms } from '@/lib/unread';
import { useVoice, voice } from '@/lib/voice';

const noCategories: ChannelCategory[] = [];

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
  const hasUnreadDms = useHasUnreadDms();
  const server = servers.find((item) => item.id === hubServer) ?? null;

  // no channel is open while the hub is on screen (notifications and unread marks follow this)
  useFocusEffect(useCallback(() => chat().setRoute({ kind: 'home' }), []));

  return (
    <View className="flex-1 bg-sidebar">
      <View className="min-h-0 flex-1 flex-row">
        <GuildSidebar
          servers={servers}
          activeId={server?.id ?? null}
          mentions={guildMentions}
          hasUnreadDms={hasUnreadDms}
          onSelect={(id) => chat().selectServer(id)}
        />
        <View className="flex-1">
          {server ? (
            <ChannelSidebar
              server={server}
              categories={categories}
              onSelectChannel={(id) => goto(guildPath(server.id, id))}
              members={members}
              voiceStates={voiceStates}
            />
          ) : (
            <DmSidebar />
          )}
        </View>
      </View>
      {user && (
        <UserArea
          user={user}
          voiceChannelName={voiceChannelName}
          onLeaveVoice={() => void voice().leave()}
        />
      )}
    </View>
  );
}
