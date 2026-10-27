// Port of apps/frontend/src/lib/notifications.ts
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { AppState, Platform } from 'react-native';
import { create } from 'zustand';
import { effectiveLevel, levelAllows, type NotificationEntries } from 'anchor/notification-level';
import { chatPathSchema, hasPushSubscription } from './push';
import { settings } from './settings';
import { playSound } from './sounds';

// the app shows its own in-app banner (components/in-app-banner.tsx) while it is open,
// so the OS never shows a notification for the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// a tapped notification opens the chat it came from (a cold start is handled by watchNotificationTaps in push.ts)
Notifications.addNotificationResponseReceivedListener((response) => {
  const url = chatPathSchema.safeParse(response.notification.request.content.data?.url);
  if (url.success) router.navigate(url.data as never);
});

export function notificationsSupported(): boolean {
  return true;
}

export async function getNotificationPermission() {
  const { granted, canAskAgain } = await Notifications.getPermissionsAsync();
  return granted ? 'granted' : canAskAgain ? 'default' : 'denied';
}

export async function requestNotificationPermission() {
  const { granted } = await Notifications.requestPermissionsAsync();
  return granted ? 'granted' : 'denied';
}

export const useInAppBanner = create<{
  banner: NotificationOptions | null;
  show: (banner: NotificationOptions) => void;
  dismiss: () => void;
}>((set) => ({
  banner: null,
  show: (banner) => set({ banner }),
  dismiss: () => set({ banner: null }),
}));

const channel =
  Platform.OS === 'android'
    ? Notifications.setNotificationChannelAsync('messages', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
      })
    : Promise.resolve();

export async function sendNotification(notification: NotificationOptions): Promise<boolean> {
  // while the app is open the OS stays quiet and we show our own banner
  if (AppState.currentState === 'active') {
    useInAppBanner.getState().show(notification);
    return true;
  }

  // with a push subscription the server already notifies a user whose app is not in the foreground
  // (calls are not pushed)
  if (!notification.tag?.startsWith('call:') && hasPushSubscription()) return false;

  if ((await getNotificationPermission()) !== 'granted') {
    return false;
  }

  await channel;
  await Notifications.scheduleNotificationAsync({
    // a newer message in the same channel replaces the old notification, and still alerts
    identifier: notification.tag,
    content: {
      title: notification.title,
      body: notification.body,
      data: { url: notification.url },
    },
    trigger: Platform.OS === 'android' ? { channelId: 'messages' } : null,
  });
  return true;
}

export function setBadgeCount(count: number) {
  return Notifications.setBadgeCountAsync(count).catch(() => false);
}

type NotifyMessage = {
  channelId: string;
  guildId: string | null;
  pingedHandles: string[];
  author: { userId: string };
};

// one place decides whether a new message is worth a sound or a notification; the server's push
// uses the same effectiveLevel/levelAllows pair, so the two never disagree.
export function shouldNotify(
  message: NotifyMessage,
  context: {
    user: { id: string; handle: string };
    activeChannelId: string | null;
    hasFocus: boolean;
    entries: NotificationEntries;
  }
) {
  const { user, activeChannelId, hasFocus, entries } = context;
  if (message.author.userId === user.id) return false;
  if (activeChannelId === message.channelId && hasFocus) return false;

  const isDm = message.guildId === null;
  const mentioned =
    isDm ||
    message.pingedHandles.some((handle) => handle.toLowerCase() === user.handle.toLowerCase());

  return levelAllows(effectiveLevel(entries, message), mentioned);
}

export function messageNotificationTitle(
  author: { displayName: string | null; username: string },
  names: { channel?: string; guild?: string } | null
) {
  const name = author.displayName || author.username;
  return names ? `${name} (#${names.channel ?? 'channel'} · ${names.guild ?? 'server'})` : name;
}

export function notificationSound() {
  // notification sound by universfield in pixabay
  // https://pixabay.com/users/universfield-28281460/
  playSound(require('../../assets/sounds/notification.opus'), settings().notificationVolume);
}

export type NotificationOptions = {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  // the chat path to open when the OS notification is tapped (native-only; the web's onClick focuses the window)
  url?: string;
  onClick?: () => void;
};
