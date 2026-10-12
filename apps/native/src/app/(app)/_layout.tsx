// Port of apps/frontend/src/lib/components/app-shell.svelte, the boot part
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { InitialLoader } from '@/components/initial-loader';
import { chat } from '@/lib/chat-state';
import { friends } from '@/lib/friends';
import { goto } from '@/lib/navigation';
import { notificationSettings } from '@/lib/notification-settings';
import { setBadgeCount } from '@/lib/notifications';
import { syncPush, watchNotificationTaps } from '@/lib/push';
import { realtime } from '@/lib/realtime';
import { session, useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { useUnreadTotal } from '@/lib/unread';
import { voice } from '@/lib/voice';

export default function AppLayout() {
  const user = useSession((s) => s.user);
  const pushNotifications = useSettings((s) => s.pushNotifications);
  const unreadTotal = useUnreadTotal();
  const [booting, setBooting] = useState(true);
  const [bootFinished, setBootFinished] = useState(false);
  const pushSynced = useRef(false);

  useEffect(() => {
    async function boot() {
      if (!(await session().refresh())) {
        router.replace('/login');
        return;
      }

      await Promise.all([
        chat().loadInitialData(),
        friends().load(),
        notificationSettings().load(),
      ]);
      setBootFinished(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      setBooting(false);
    }

    const disconnect = realtime().connect();
    void boot();

    return () => {
      disconnect();
      void voice().leave();
    };
  }, []);

  // push subscriptions go stale (endpoints change, sessions get replaced), so renew them once per start
  useEffect(() => {
    if (booting || pushSynced.current || !pushNotifications) return;
    pushSynced.current = true;
    void syncPush();
  }, [booting, pushNotifications]);

  useEffect(() => watchNotificationTaps((url) => void goto(url)), []);

  useEffect(() => {
    void setBadgeCount(unreadTotal);
  }, [unreadTotal]);

  if (booting) return <InitialLoader finished={bootFinished} />;
  if (!user) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
