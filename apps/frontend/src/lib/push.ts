import { browser, dev } from '$app/environment';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';
import { anchor } from './anchor.svelte';

// push when the app is closed: Web Push in browsers, UnifiedPush on Android (through our own
// native plugin). Electron can't receive either; it keeps its realtime connection in the tray.
const subscriptionIdKey = 'novarum:push-subscription-id';

const webSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
type Endpoint = { endpoint?: string; p256dh?: string; auth?: string };

const UnifiedPush = registerPlugin<{
  register(options: { vapid: string }): Promise<void>;
  unregister(): Promise<void>;
  getEndpoint(): Promise<Endpoint>;
  getLaunchUrl(): Promise<{ url: string | null }>;
  addListener(event: 'endpoint', callback: (data: Endpoint) => void): Promise<PluginListenerHandle>;
  addListener(
    event: 'registrationFailed',
    callback: (data: { reason: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'notificationTapped',
    callback: (data: { url: string }) => void
  ): Promise<PluginListenerHandle>;
}>('UnifiedPush');

const isAndroid = () => Capacitor.getPlatform() === 'android';

export function webPushSupported() {
  return (
    browser &&
    !isAndroid() &&
    !window.electron &&
    !Capacitor.isNativePlatform() &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export const pushAvailable = () => browser && (isAndroid() || webPushSupported());

async function vapidKey() {
  const result = await anchor.client.notifications['vapid-key'].get();
  if (result.error || !result.data) throw new Error('Could not reach your homeserver');
  return result.data.publicKey;
}

async function saveSubscription(
  kind: 'WEBPUSH' | 'UNIFIEDPUSH',
  subscription: z.infer<typeof webSubscriptionSchema>
) {
  const result = await anchor.client.notifications.subscriptions.post({ kind, ...subscription });
  if (result.error || !result.data) throw new Error('Your homeserver rejected this device');
  localStorage.setItem(subscriptionIdKey, result.data.id);
}

const toBytes = (base64Url: string) =>
  Uint8Array.from(atob(base64Url.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
    char.charCodeAt(0)
  );

async function subscribeWebPush() {
  const registration = await navigator.serviceWorker.register('/service-worker.js', {
    type: dev ? 'module' : 'classic',
  });
  await navigator.serviceWorker.ready;

  const key = await vapidKey();
  let subscription = await registration.pushManager.getSubscription();
  // a browser subscription is tied to one VAPID key, and every homeserver has its own
  const current = subscription?.options.applicationServerKey;
  const bytes = toBytes(key);
  if (current && !(current.byteLength === bytes.length && new Uint8Array(current).every((v, i) => v === bytes[i]))) {
    await subscription!.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: bytes,
  });

  await saveSubscription('WEBPUSH', webSubscriptionSchema.parse(subscription.toJSON()));
}

// resolves once the distributor has handed us an endpoint, which comes back as an event
function subscribeUnifiedPush() {
  return new Promise<void>((resolve, reject) => {
    const handles: Promise<PluginListenerHandle>[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      void Promise.all(handles).then((all) => all.forEach((handle) => void handle.remove()));
      return error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => finish(new Error('Your push service did not answer')), 20_000);

    handles.push(
      UnifiedPush.addListener('endpoint', (data) =>
        void saveEndpoint(data).then(() => finish(), (error: Error) => finish(error))
      ),
      UnifiedPush.addListener('registrationFailed', ({ reason }) =>
        finish(new Error(`Your push service refused: ${reason}`))
      )
    );
    void vapidKey()
      .then((vapid) => UnifiedPush.register({ vapid }))
      .catch((error: { code?: string; message?: string }) =>
        finish(
          new Error(
            error.code === 'NO_DISTRIBUTOR'
              ? 'Install a UnifiedPush app such as ntfy to get notifications'
              : (error.message ?? 'Could not register for push')
          )
        )
      );
  });
}

async function saveEndpoint(data: Endpoint) {
  const subscription = webSubscriptionSchema.safeParse({
    endpoint: data.endpoint,
    keys: { p256dh: data.p256dh, auth: data.auth },
  });
  if (subscription.success) await saveSubscription('UNIFIEDPUSH', subscription.data);
}

// throws a message fit to show the user when this device can't be set up
export async function enablePush() {
  if (isAndroid()) await subscribeUnifiedPush();
  else if (webPushSupported()) await subscribeWebPush();
}

export async function disablePush() {
  const id = localStorage.getItem(subscriptionIdKey);
  localStorage.removeItem(subscriptionIdKey);
  if (id) await anchor.client.notifications.subscriptions({ id }).delete().catch(() => null);

  if (isAndroid()) await UnifiedPush.unregister().catch(() => null);
  else if (webPushSupported()) {
    const registration = await navigator.serviceWorker.getRegistration('/service-worker.js');
    await (await registration?.pushManager.getSubscription())?.unsubscribe().catch(() => null);
  }
}

// subscriptions go stale: endpoints change and sessions get replaced, so re-send them on start
export async function syncPush() {
  try {
    if (isAndroid()) await saveEndpoint(await UnifiedPush.getEndpoint());
    else if (webPushSupported()) await subscribeWebPush();
  } catch (error) {
    console.warn('Could not refresh push subscription', error);
  }
}

// a tapped notification opens the chat it came from, whether the app was open, backgrounded or closed
export function watchNotificationTaps(open: (url: string) => void) {
  const onMessage = (event: MessageEvent) => {
    const message = z.object({ type: z.literal('navigate'), url: z.string() }).safeParse(event.data);
    if (message.success) open(message.data.url);
  };
  if (browser && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', onMessage);
  }

  const handle = isAndroid()
    ? UnifiedPush.addListener('notificationTapped', ({ url }) => open(url))
    : null;
  if (isAndroid()) {
    void UnifiedPush.getLaunchUrl().then(({ url }) => url && open(url));
  }

  return () => {
    if (browser && 'serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', onMessage);
    }
    void handle?.then((listener) => listener.remove());
  };
}
