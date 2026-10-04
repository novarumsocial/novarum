/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { z } from 'zod';

const sw = self as unknown as ServiceWorkerGlobalScope;

// what the homeserver pushes (see anchor's utils/notify.ts); only ever shown as plain text
const pushSchema = z.object({
  title: z.string(),
  body: z.string().optional(),
  icon: z.string().optional(),
  tag: z.string().optional(),
  url: z.string(),
});

sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener('push', (event) => {
  const payload = pushSchema.safeParse(
    (() => {
      try {
        return event.data?.json();
      } catch {
        return null;
      }
    })()
  );
  if (!payload.success) return;

  const { title, body, icon, tag, url } = payload.data;
  event.waitUntil(
    sw.registration.showNotification(title, {
      body,
      icon,
      // one notification per channel: a newer message replaces the old one and still alerts
      tag,
      renotify: !!tag,
      data: { url },
    } as NotificationOptions)
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = z.string().catch('/').parse(event.notification.data?.url);

  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => client.url.startsWith(sw.location.origin));
      if (!open) return void (await sw.clients.openWindow(url));

      await open.focus();
      open.postMessage({ type: 'navigate', url });
    })()
  );
});
