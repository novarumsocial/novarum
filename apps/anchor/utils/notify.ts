import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { db, pushSubscriptions } from '../src/db';
import { getConfig } from './config';
import { assertSafeFederationUrl, postSignedFederationJson } from './discovery';
import { effectiveLevel, levelAllows } from './notificationLevel';
import { getVapidKeys, vapidSubject } from './vapid';
import { isUserActive } from '../modules/realtime/services';

export const maxSnippetLength = 200;
const pushTimeoutMs = 10_000;

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

// pushes to every device of the users who should hear about this: push on, level allows it,
// and no open window to see it in. content only goes out when the user turned previews on.
export async function notifyLocal(userIds: string[], payload: PushPayload) {
  if (!userIds.length) return;

  const targetIds = [payload.channelId, ...(payload.guildId ? [payload.guildId] : [])];
  const [preferences, settings, subscriptions, channel, guild] = await Promise.all([
    db.query.notificationPreferences.findMany({ where: { userId: { in: userIds } } }),
    db.query.notificationSettings.findMany({
      where: { userId: { in: userIds }, targetId: { in: targetIds } },
    }),
    db.query.pushSubscriptions.findMany({ where: { userId: { in: userIds } } }),
    db.query.channels.findFirst({ where: { id: payload.channelId } }),
    payload.guildId ? db.query.guilds.findFirst({ where: { id: payload.guildId } }) : null,
  ]);

  const target = { channelId: payload.channelId, guildId: payload.guildId };
  const name = payload.author.displayName || payload.author.username;
  const url = payload.guildId
    ? `/guilds/${[payload.guildId, payload.channelId, payload.messageId].map(encodeURIComponent).join('/')}`
    : `/guilds/dms/${encodeURIComponent(payload.channelId)}`;

  for (const userId of new Set(userIds)) {
    const userSubscriptions = subscriptions.filter((subscription) => subscription.userId === userId);
    if (!userSubscriptions.length || isUserActive(userId)) continue;

    const preference = preferences.find((item) => item.userId === userId);
    if (preference && !preference.push) continue;

    const entries = Object.fromEntries(
      settings.filter((item) => item.userId === userId).map((item) => [item.targetId, item])
    );
    // everything pushed is a DM or a mention, so it always counts as one
    if (!levelAllows(effectiveLevel(entries, target), true)) continue;

    const preview = preference?.messagePreview ?? true;
    const message = JSON.stringify({
      title: payload.guildId
        ? `${name} (#${channel?.name ?? 'channel'} · ${guild?.name ?? 'server'})`
        : name,
      body:
        preview && payload.snippet
          ? payload.snippet
          : payload.guildId
            ? 'Mentioned you'
            : 'Sent you a message',
      icon: payload.author.avatarUrl ?? undefined,
      tag: payload.channelId,
      url,
      channelId: payload.channelId,
      messageId: payload.messageId,
    });

    await Promise.all(userSubscriptions.map((subscription) => sendPush(subscription, message)));
  }
}

async function sendPush(
  subscription: typeof pushSubscriptions.$inferSelect,
  message: string
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
        TTL: 60 * 60,
        urgency: 'high',
        vapidDetails: { subject: vapidSubject(), ...vapid },
      }
    );
    await assertSafeFederationUrl(new URL(request.endpoint));

    const response = await fetch(request.endpoint, {
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(request.body),
      redirect: 'error',
      signal: AbortSignal.timeout(pushTimeoutMs),
    });
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
    [...byHomeserver].map(([recipientHomeserver, group]) =>
      recipientHomeserver === localHomeserver
        ? notifyLocal(
            group.map((recipient) => recipient.userId),
            body
          )
        : postSignedFederationJson(recipientHomeserver, '/federation/push', {
            ...body,
            handles: group.map((recipient) => recipient.handle),
          }).catch(() => null)
    )
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
