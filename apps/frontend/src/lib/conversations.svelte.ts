import { chat } from './chat-state.svelte';
import { dms } from './dms.svelte';
import { notificationSettings } from './notification-settings.svelte';
import type { Server } from './types/chat';

export type Conversation = {
  id: string;
  name: string;
  server: Server | null;
  unread: boolean;
  mention: number;
  avatarUrl?: string | null;
  avatarColor?: string | null;
};

// every text channel and direct message the user can open, across all servers
export function listConversations(): Conversation[] {
  const direct = dms.list.map((dm) => {
    const other = dm.participants[0];
    return {
      id: dm.id,
      name: other ? other.displayName || other.username : 'Direct message',
      server: null,
      unread: dm.unread && notificationSettings.showsUnread({ channelId: dm.id, guildId: null }),
      mention: 0,
      avatarUrl: other?.avatarUrl,
      avatarColor: other?.avatarColor,
    };
  });

  const channels = chat.servers.flatMap((server) =>
    (chat.channelsByServer[server.id] ?? [])
      .flatMap((category) => category.channels)
      .filter((channel) => channel.type === 'TEXT')
      .map((channel) => {
        const target = { channelId: channel.id, guildId: server.id };
        return {
          id: channel.id,
          name: channel.label || channel.name,
          server,
          unread: channel.unread && notificationSettings.showsUnread(target),
          mention: notificationSettings.showsMentions(target) ? channel.mention : 0,
        };
      })
  );

  return [...direct, ...channels];
}
