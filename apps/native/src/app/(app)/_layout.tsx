// Port of apps/frontend/src/lib/components/app-shell.svelte, the boot part
import { router, Stack, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { InitialLoader } from '@/components/initial-loader';
import { chat } from '@/lib/chat-state';
import { friends } from '@/lib/friends';
import { dms } from '@/lib/dms';
import { notificationSettings } from '@/lib/notification-settings';
import { setBadgeCount } from '@/lib/notifications';
import { syncPush, watchNotificationTaps } from '@/lib/push';
import { realtime } from '@/lib/realtime';
import { session, useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { useUnreadTotal } from '@/lib/unread';
import { voice } from '@/lib/voice';

const screenOptions = { headerShown: false };

// the app icon badge, in its own component so unread changes don't re-render the whole app
function BadgeSync() {
  const unreadTotal = useUnreadTotal();
  useEffect(() => {
    void setBadgeCount(unreadTotal);
  }, [unreadTotal]);
  return null;
}

export default function AppLayout() {
  const user = useSession((s) => s.user);
  const epoch = useSession((s) => s.epoch);
  const pushNotifications = useSettings((s) => s.pushNotifications);
  const [booting, setBooting] = useState(true);
  const [bootFinished, setBootFinished] = useState(false);
  const pushSynced = useRef(false);

  // runs again when the account changes (`epoch`): the web reloads the page, here every store is reset
  useEffect(() => {
    let cancelled = false;
    setBooting(true);
    setBootFinished(false);
    pushSynced.current = false;

    async function boot() {
      if (!(await session().refresh())) {
        if (!cancelled) router.replace('/login');
        return;
      }

      await Promise.all([
        chat().loadInitialData(),
        friends().load(),
        notificationSettings().load(),
      ]);
      if (cancelled) return;
      setBootFinished(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!cancelled) setBooting(false);
    }

    const disconnect = realtime().connect();
    void boot();

    return () => {
      cancelled = true;
      disconnect();
      void voice().leave();
      chat().reset();
      dms().reset();
      friends().reset();
      notificationSettings().clear();
      void setBadgeCount(0);
    };
  }, [epoch]);

  // push subscriptions go stale (endpoints change, sessions get replaced), so renew them once per start
  useEffect(() => {
    if (booting || pushSynced.current || !pushNotifications) return;
    pushSynced.current = true;
    void syncPush();
  }, [booting, pushNotifications]);

  // navigate (not push): expo-router already opens the same link when it launched or resumed the app
  useEffect(() => watchNotificationTaps((url) => router.navigate(url as Href)), []);

  if (booting) return <InitialLoader finished={bootFinished} />;
  if (!user) return null;
  return (
    <>
      <BadgeSync />
      <Stack screenOptions={screenOptions} />
    </>
  );
}
