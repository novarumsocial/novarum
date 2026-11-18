import crypto from 'node:crypto';
import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { db, pushSubscriptions } from '../src/db';
import { getConfig } from './config';
import { postSignedFederationJson } from './discovery';
import { safePost } from './safePost';
import { effectiveLevel, levelAllows } from './notificationLevel';
import { getVapidKeys, vapidSubject } from './vapid';
import { isUserActive } from '../modules/realtime/services';

export const maxSnippetLength = 200;
const pushTimeoutMs = 10_000;
const maxPushesPerUserPerMinute = 60;
const pushWindows = new Map<string, { start: number; count: number }>();

function allowPushTo(userId: string) {
  const now = Date.now();
  if (pushWindows.size > 10_000) {
    for (const [id, window] of pushWindows) if (now - window.start > 60_000) pushWindows.delete(id);
  }

  const window = pushWindows.get(userId);
  if (!window || now - window.start > 60_000) {
    pushWindows.set(userId, { start: now, count: 1 });
    return true;
  }
  return ++window.count <= maxPushesPerUserPerMinute;
}

// ids are local to whoever receives this: fed: ids for things hosted elsewhere.
export type PushPayload = {
  guildId: string | null;
  channelId: string;
  messageId: string;
  author: {
    username: string;
    displayName: string | null;
    homeserver: string;
    avatarUrl: string | null;
  };
  snippet: string | null;
};

export type PushRecipient = { userId: string; homeserver: string; handle: string };

// a stable numeric id per tag: expo-unified-push drops a notification without one
const notificationId = (tag: string) =>
  [...tag].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 0) & 0x7fffffff;

// android can only open an absolute url (the app's novarum:// scheme), browsers resolve the path
const forDevice = (subscription: typeof pushSubscriptions.$inferSelect, message: { url: string }) =>
  JSON.stringify(
    subscription.kind === 'UNIFIEDPUSH' ? { ...message, url: `novarum:/${message.url}` } : message
  );

// a remote author's avatar lives on a server we don't control, and showing it would tell that
// server when and where this user got the notification
const iconFor = (author: { homeserver: string; avatarUrl: string | null }) =>
  author.homeserver.toLowerCase() === getConfig().server.homeserver.toLowerCase()
    ? (author.avatarUrl ?? undefined)
    : undefined;

// the users who should hear about something in this channel, with their devices: push on, level
// allows it, no open window to see it in, and not over the rate limit
async function pushTargets(
  userIds: string[],
  target: { channelId: string; guildId: string | null }
) {
  const targetIds = [target.channelId, ...(target.guildId ? [target.guildId] : [])];
  const [preferences, settings, subscriptions] = await Promise.all([
    db.query.notificationPreferences.findMany({ where: { userId: { in: userIds } } }),
    db.query.notificationSettings.findMany({
      where: { userId: { in: userIds }, targetId: { in: targetIds } },
    }),
    db.query.pushSubscriptions.findMany({ where: { userId: { in: userIds } } }),
  ]);

  return [...new Set(userIds)].flatMap((userId) => {
    const devices = subscriptions.filter((subscription) => subscription.userId === userId);
    if (!devices.length || isUserActive(userId)) return [];

    const preference = preferences.find((item) => item.userId === userId);
    if (preference && !preference.push) return [];

    const entries = Object.fromEntries(
      settings.filter((item) => item.userId === userId).map((item) => [item.targetId, item])
    );
    // everything pushed is a DM, a call or a mention, so it always counts as one
    if (!levelAllows(effectiveLevel(entries, target), true)) return [];
    if (!allowPushTo(userId)) return [];
    return [{ userId, devices, preview: preference?.messagePreview ?? true }];
  });
}

// pushes to every device of the users who should hear about this message. content only goes out
// when the user turned previews on.
export async function notifyLocal(userIds: string[], payload: PushPayload) {
  if (!userIds.length) return;

  const [targets, channel, guild] = await Promise.all([
    pushTargets(userIds, { channelId: payload.channelId, guildId: payload.guildId }),
    db.query.channels.findFirst({ where: { id: payload.channelId } }),
    payload.guildId ? db.query.guilds.findFirst({ where: { id: payload.guildId } }) : null,
  ]);

  const name = payload.author.displayName || payload.author.username;
  const url = payload.guildId
    ? `/guilds/${[payload.guildId, payload.channelId, payload.messageId].map(encodeURIComponent).join('/')}`
    : `/guilds/dms/${encodeURIComponent(payload.channelId)}`;

  for (const { devices, preview } of targets) {
    const message = {
      title: payload.guildId
        ? `${name} (#${channel?.name ?? 'channel'} · ${guild?.name ?? 'server'})`
        : channel?.type === 'GROUP_DM' && channel.name
          ? `${name} (${channel.name})`
          : name,
      body:
        preview && payload.snippet
          ? payload.snippet
          : payload.guildId
            ? 'Mentioned you'
            : 'Sent you a message',
      icon: iconFor(payload.author),
      tag: payload.channelId,
      // one per channel, like `tag`
      id: notificationId(payload.channelId),
      url,
      channelId: payload.channelId,
      messageId: payload.messageId,
    };

    await Promise.all(devices.map((device) => sendPush(device, forDevice(device, message))));
  }
}

// a ring is over after 30 seconds, so a phone that comes back later must not start ringing
const ringTtl = 30;

// the notification's Decline runs without the app, so the push carries a link that declines this
// one ring for this one person; it expires shortly after the ring would have
const declineSignature = (channelId: string, userId: string, exp: number) =>
  crypto
    .createHmac('sha256', `ring-decline:${getConfig().files.s3_secret_key}`)
    .update(`${channelId}:${userId}:${exp}`)
    .digest('base64url');

function declineUrl(channelId: string, userId: string) {
  const exp = Math.floor(Date.now() / 1000) + ringTtl * 2;
  const url = new URL(
    `/dm/${encodeURIComponent(channelId)}/ring/decline`,
    getConfig().server.base_url
  );
  url.search = new URLSearchParams({
    user: userId,
    exp: String(exp),
    sig: declineSignature(channelId, userId, exp),
  }).toString();
  return url.toString();
}

export function isValidDeclineSignature(
  channelId: string,
  userId: string,
  exp: number,
  sig: string
) {
  const expected = Buffer.from(declineSignature(channelId, userId, exp));
  const given = Buffer.from(sig);
  return (
    exp > Date.now() / 1000 &&
    expected.length === given.length &&
    crypto.timingSafeEqual(expected, given)
  );
}

export type CallPush = {
  channelId: string;
  caller: {
    username: string;
    displayName: string | null;
    homeserver: string;
    avatarUrl: string | null;
  };
  ringing: boolean;
};

// rings the phones of these users for a call in a DM, or stops them ringing. The app turns a
// `type: 'call'` push into its call screen (modules/incoming-call in the native app).
export async function notifyCall(userIds: string[], { channelId, caller, ringing }: CallPush) {
  if (!userIds.length) return;

  const tag = `call:${channelId}`;
  if (!ringing) {
    // a browser has to show something for every push, so only phones are told to stop ringing;
    // the browser's notification stays until it's dismissed
    const devices = await db.query.pushSubscriptions.findMany({
      where: { userId: { in: userIds }, kind: 'UNIFIEDPUSH' },
    });
    const message = { type: 'call', ringing: false, id: notificationId(tag), tag, channelId };
    await Promise.all(devices.map((device) => sendPush(device, JSON.stringify(message), ringTtl)));
    return;
  }

  const [targets, channel] = await Promise.all([
    pushTargets(userIds, { channelId, guildId: null }),
    db.query.channels.findFirst({ where: { id: channelId } }),
  ]);
  const message = {
    type: 'call',
    ringing: true,
    title: caller.displayName || caller.username,
    body:
      channel?.type === 'GROUP_DM' ? `Calling ${channel.name || 'your group'}` : 'Is calling you',
    icon: iconFor(caller),
    tag,
    id: notificationId(tag),
    url: `/guilds/dms/${encodeURIComponent(channelId)}`,
    channelId,
  };
  await Promise.all(
    targets.flatMap(({ userId, devices }) => {
      const push = { ...message, decline: declineUrl(channelId, userId) };
      return devices.map((device) => sendPush(device, forDevice(device, push), ringTtl));
    })
  );
}

// `ttl`: how long the push service keeps trying a phone that is offline, in seconds
async function sendPush(
  subscription: typeof pushSubscriptions.$inferSelect,
  message: string,
  ttl = 60 * 60
) {
  try {
    const vapid = await getVapidKeys();
    const request = webpush.generateRequestDetails(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      message,
      {
        TTL: ttl,
        urgency: 'high',
        vapidDetails: { subject: vapidSubject(), ...vapid },
      }
    );
    const response = await safePost(
      request.endpoint,
      request.headers as Record<string, string>,
      new Uint8Array(request.body),
      pushTimeoutMs
    );
    // the push service says this device is gone for good
    if (response.status === 404 || response.status === 410) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
    }
  } catch (error) {
    console.warn('push delivery failed', subscription.id, error);
  }
}

// the host of a guild or DM works out who to notify and sends one call per homeserver. If a
// homeserver is down the push is lost on purpose: /federation/unread-mentions brings the
// badges back on the next load, and there is no retry queue.
const maxPushHandles = 1000;

export async function notifyMessage(
  message: { id: string; content: string | null; author: { id: string } & PushPayload['author'] },
  channel: { id: string; guildId: string | null },
  recipients: PushRecipient[]
) {
  const localHomeserver = getConfig().server.homeserver.toLowerCase();
  const byHomeserver = Map.groupBy(
    recipients.filter((recipient) => recipient.userId !== message.author.id),
    (recipient) => recipient.homeserver.toLowerCase()
  );

  const { username, displayName, homeserver, avatarUrl } = message.author;
  const body: PushPayload = {
    guildId: channel.guildId,
    channelId: channel.id,
    messageId: message.id,
    author: { username, displayName, homeserver, avatarUrl },
    snippet: message.content?.slice(0, maxSnippetLength) ?? null,
  };

  await Promise.all(
    [...byHomeserver].flatMap<Promise<unknown>>(([recipientHomeserver, group]) => {
      if (recipientHomeserver === localHomeserver) {
        return [
          notifyLocal(
            group.map((recipient) => recipient.userId),
            body
          ),
        ];
      }
      // a homeserver takes up to 1000 handles per push, which an @everyone can go over
      return Array.from({ length: Math.ceil(group.length / maxPushHandles) }, (_, i) =>
        postSignedFederationJson(recipientHomeserver, '/federation/push', {
          ...body,
          handles: group
            .slice(i * maxPushHandles, (i + 1) * maxPushHandles)
            .map((recipient) => recipient.handle),
        }).catch(() => null)
      );
    })
  );
}

// who hears about a message in a DM: everyone else in it
export async function dmRecipients(channelId: string): Promise<PushRecipient[]> {
  const members = await db.query.channelMembers.findMany({
    where: { channelId },
    with: { user: true },
  });
  return members.map(({ user }) => ({
    userId: user.id,
    homeserver: user.homeserver,
    handle: `@${user.username}:${user.homeserver}`,
  }));
}

// fire and forget, called once the message is saved. a failed push must never fail the request.
export function notifyInBackground(
  message: Parameters<typeof notifyMessage>[0],
  channel: Parameters<typeof notifyMessage>[1],
  recipients: PushRecipient[] | Promise<PushRecipient[]>
) {
  void Promise.resolve(recipients)
    .then((resolved) => notifyMessage(message, channel, resolved))
    .catch((error) => console.warn('notify failed', error));
}
