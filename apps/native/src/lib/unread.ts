// Port of the `guildMentions`, `hasUnreadDms` and `unreadTotal` values in apps/frontend/src/lib/components/app-shell.svelte,
// shared by the shell (app badge) and the sidebars. The hooks also re-render when the notification levels change.
import { useMemo } from 'react';
import { useChat } from './chat-state';
import { useDms } from './dms';
import { notificationSettings, useNotificationSettings } from './notification-settings';

export const selectGuildMentions = (
  channelsByServer: ReturnType<typeof useChat.getState>['channelsByServer']
) =>
  Object.fromEntries(
    Object.entries(channelsByServer).map(([guildId, categories]) => [
      guildId,
      categories
        .flatMap((category) => category.channels)
        .reduce(
          (sum, channel) =>
            notificationSettings().showsMentions({ channelId: channel.id, guildId })
              ? sum + channel.mention
              : sum,
          0
        ),
    ])
  );

const unreadDms = (list: ReturnType<typeof useDms.getState>['list']) =>
  list.filter(
    (dm) => dm.unread && notificationSettings().showsUnread({ channelId: dm.id, guildId: null })
  );

export function useGuildMentions() {
  const channelsByServer = useChat((s) => s.channelsByServer);
  const entries = useNotificationSettings((s) => s.entries);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => selectGuildMentions(channelsByServer), [channelsByServer, entries]);
}

// native-only: guilds with an unread channel, for the rail's unread pill
export function useGuildUnread() {
  const channelsByServer = useChat((s) => s.channelsByServer);
  const entries = useNotificationSettings((s) => s.entries);
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(channelsByServer).map(([guildId, categories]) => [
          guildId,
          categories.some((category) =>
            category.channels.some(
              (channel) =>
                channel.unread &&
                notificationSettings().showsUnread({ channelId: channel.id, guildId })
            )
          ),
        ])
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelsByServer, entries]
  );
}

export function useHasUnreadDms() {
  const list = useDms((s) => s.list);
  const entries = useNotificationSettings((s) => s.entries);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => unreadDms(list).length > 0, [list, entries]);
}

// shown as the app icon badge (the web: tab title and the desktop badge)
export function useUnreadTotal() {
  const guildMentions = useGuildMentions();
  const list = useDms((s) => s.list);
  const entries = useNotificationSettings((s) => s.entries);
  return useMemo(
    () =>
      Object.values(guildMentions).reduce((sum, count) => sum + count, 0) + unreadDms(list).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guildMentions, list, entries]
  );
}
