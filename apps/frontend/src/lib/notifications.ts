import { browser } from '$app/environment';
import { Howl } from 'howler';
import NotificationSound from './sounds/notification.opus?url';
import { settings } from './settings.svelte';
import { effectiveLevel, levelAllows, type NotificationEntries } from 'anchor/notification-level';

export function notificationsSupported(): boolean {
  return browser && 'Notification' in window;
}

export async function getNotificationPermission() {
  if (!notificationsSupported()) {
    return 'denied';
  }

  return Notification.permission;
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) {
    return 'denied';
  }

  return await Notification.requestPermission();
}

export async function sendNotification(notification: NotificationOptions): Promise<boolean> {
  if ((await getNotificationPermission()) !== 'granted') {
    return false;
  }

  const n = new Notification(notification.title, {
    body: notification.body,
    icon: notification.icon,
    tag: notification.tag,
    // a newer message in the same channel replaces the old notification, and still alerts
    renotify: !!notification.tag,
  } as ConstructorParameters<typeof Notification>[1]);

  if (notification.onClick) {
    n.onclick = () => {
      window.focus();
      notification.onClick?.();
      n.close();
    };
  }

  return true;
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
  const sound = new Howl({
    src: [NotificationSound],
    volume: settings.value.notificationVolume,
  });
  sound.play();
}

export type NotificationOptions = {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  onClick?: () => void;
};
