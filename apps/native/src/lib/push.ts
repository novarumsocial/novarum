// Port of apps/frontend/src/lib/push.ts
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import UnifiedPush, { requestPermissions, subscribeDistributorMessages } from 'expo-unified-push';
import { z } from 'zod';
import { anchor } from './anchor';
import { storage } from './storage';

// push when the app is closed: UnifiedPush on Android (expo-unified-push). Web push does not exist here.
// iOS: the backend has no APNs sender yet, so everything is a no-op there until that decision is made
// (see "Backend changes" in NATIVE_APP_PLAN.md).
// the session cookie is per homeserver, so a homeserver is an account: each gets its own subscription
const subscriptionIdKey = () => `novarum:push-subscription-id:${anchor().homeServer}`;

const subscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

const isAndroid = Platform.OS === 'android';

export const pushAvailable = () => isAndroid;

// the server pushes to this device for the account on the current homeserver
export const hasPushSubscription = () => Boolean(storage.getString(subscriptionIdKey()));

async function vapidKey() {
  const result = await anchor().client.notifications['vapid-key'].get();
  if (result.error || !result.data) throw new Error('Could not reach your homeserver');
  return result.data.publicKey;
}

// false when another account on this device still owns the endpoint
async function saveSubscription(subscription: z.infer<typeof subscriptionSchema>) {
  const result = await anchor().client.notifications.subscriptions.post({
    kind: 'UNIFIEDPUSH',
    ...subscription,
  });
  if (result.status === 409) return false;
  if (result.error || !result.data) {
    const reason = z.object({ error: z.string() }).safeParse(result.error?.value);
    throw new Error(reason.success ? reason.data.error : 'Your homeserver rejected this device');
  }
  storage.set(subscriptionIdKey(), result.data.id);
  return true;
}

async function saveEndpoint(data: { url: string; pubKey: string; auth: string }) {
  const subscription = subscriptionSchema.safeParse({
    endpoint: data.url,
    keys: { p256dh: data.pubKey, auth: data.auth },
  });
  if (subscription.success && !(await saveSubscription(subscription.data))) {
    throw new Error('This device is already registered to another account');
  }
}

// resolves once the distributor has handed us an endpoint, which comes back as an event
function subscribeUnifiedPush() {
  const instance = anchor().homeServer;
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      stop();
      return error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => finish(new Error('Your push service did not answer')), 20_000);

    const stop = subscribeDistributorMessages(({ action, data }) => {
      if (action === 'registered' && data.instance === instance)
        void saveEndpoint(data).then(
          () => finish(),
          (error: Error) => finish(error)
        );
      else if (action === 'registrationFailed' && data.instance === instance)
        finish(new Error(`Your push service refused: ${data.reason}`));
    });

    void (async () => {
      if ((await requestPermissions()) !== 'granted')
        throw new Error('Notifications are blocked for Novarum');
      // pick the first installed UnifiedPush app (ntfy, ...) when none was chosen yet
      if (!UnifiedPush.getSavedDistributor()) {
        const distributor = UnifiedPush.getDistributors().find((d) => !d.isInternal);
        if (!distributor)
          throw new Error('Install a UnifiedPush app such as ntfy to get notifications');
        UnifiedPush.saveDistributor(distributor.id);
      }
      await UnifiedPush.registerDevice(await vapidKey(), instance);
    })().catch((error: Error) => finish(new Error(error.message || 'Could not register for push')));
  });
}

// throws a message fit to show the user when this device can't be set up
export async function enablePush() {
  if (isAndroid) await subscribeUnifiedPush();
}

export async function disablePush() {
  const id = storage.getString(subscriptionIdKey());
  storage.remove(subscriptionIdKey());
  if (id)
    await anchor()
      .client.notifications.subscriptions({ id })
      .delete()
      .catch(() => null);

  if (isAndroid) UnifiedPush.unregisterDevice(anchor().homeServer);
}

// subscriptions go stale: endpoints change and sessions get replaced, so re-send them on start.
// registerDevice re-checks the distributor connection and replays the `registered` event, which we save.
export async function syncPush() {
  try {
    if (isAndroid && UnifiedPush.getSavedDistributor()) await subscribeUnifiedPush();
  } catch (error) {
    console.warn('Could not refresh push subscription', error);
  }
}

export const chatPathSchema = z.string().regex(/^\/guilds(\/[^/?#\\]+)*$/);

// the path of a tapped notification's url: a bare `/guilds/...` path, `https://app.novarum.me/guilds/...`
// or `novarum://guilds/...`
function pathOf(url: string) {
  const { scheme, hostname, path } = Linking.parse(url);
  return '/' + [scheme === 'novarum' ? hostname : null, path].filter(Boolean).join('/');
}

// a tapped notification opens the chat it came from, whether the app was open, backgrounded or closed
//
// expo-unified-push builds its native notification with a PendingIntent that is an ACTION_VIEW intent on the
// payload's `url` (flags NEW_TASK | CLEAR_TASK, ExpoUPService.getOpenUrlIntent), or the plain launch intent when
// the payload has no `url`. It sends nothing to JS when tapped, so the only signal is the launch URL, which
// we read with expo-linking. Android only delivers it to us if the url is absolute and matches an intent filter
// of the app (`https://app.novarum.me/guilds...` or `novarum://...`): a relative `/guilds/...` payload url like
// the web's Web Push one can not be resolved by Android, so the backend must send an absolute url for UnifiedPush.
let coldStartHandled = false;

export function watchNotificationTaps(openUrl: (url: string) => void) {
  const open = (url: string | null | undefined) => {
    const path = chatPathSchema.safeParse(url && pathOf(url));
    if (path.success) openUrl(path.data);
  };

  // only once per app start: the shell can mount again (account switch) and must not reopen an old tap
  if (!coldStartHandled) {
    coldStartHandled = true;
    // CLEAR_TASK restarts the activity, so a tap normally arrives as the initial url
    void Linking.getInitialURL().then(open);
    // cold start from a local notification (warm taps are routed in notifications.ts)
    void Notifications.getLastNotificationResponseAsync().then((response) =>
      open(z.string().safeParse(response?.notification.request.content.data?.url).data)
    );
  }
  const link = Linking.addEventListener('url', ({ url }) => open(url));

  return () => link.remove();
}
