// Port of the "notifications" tab of apps/frontend/src/lib/components/settings-dialog.svelte
import { useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { SettingsRow } from '@/components/settings-row';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { notificationSettings } from '@/lib/notification-settings';
import {
  getNotificationPermission,
  notificationSound,
  notificationsSupported,
  requestNotificationPermission,
  sendNotification,
} from '@/lib/notifications';
import { disablePush, enablePush, pushAvailable } from '@/lib/push';
import { useSettings } from '@/lib/settings';

// native-only: a slider like the web's ui/slider (drag or tap; reports the value when you let go)
function Slider({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [width, setWidth] = useState(1);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const at = (x: number) => Math.round(Math.min(1, Math.max(0, x / width)) * 100) / 100;

  // a sideways drag moves it and a vertical one scrolls the page instead
  const drag = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-5, 5])
    .failOffsetY([-5, 5])
    .onUpdate((e) => setDragging(at(e.x)))
    .onEnd((e) => onCommit(at(e.x)))
    .onFinalize(() => setDragging(null));
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e) => onCommit(at(e.x)));
  const gesture = Gesture.Race(drag, tap);

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        className="h-11 justify-center"
      >
        <View className="h-1 bg-muted">
          <View className="h-1 bg-primary" style={{ width: `${shown * 100}%` }} />
        </View>
        <View
          className="absolute size-5 -translate-x-2.5 bg-primary"
          style={{ left: `${shown * 100}%` }}
        />
      </View>
    </GestureDetector>
  );
}

export default function Notifications() {
  const pushNotifications = useSettings((s) => s.pushNotifications);
  const messagePreview = useSettings((s) => s.messagePreview);
  const mentionSound = useSettings((s) => s.mentionSound);
  const notificationVolume = useSettings((s) => s.notificationVolume);
  const update = useSettings((s) => s.update);
  const [pushError, setPushError] = useState<string | null>(null);

  async function setPushNotifications(enabled: boolean) {
    setPushError(null);
    if (!enabled) {
      update({ pushNotifications: false });
      void disablePush();
      void notificationSettings().savePreferences({ push: false });
      return;
    }

    const canShow = notificationsSupported();
    if (!canShow && !pushAvailable()) {
      update({ pushNotifications: false });
      return;
    }

    const permission = await getNotificationPermission();
    const granted =
      !canShow || permission === 'granted' || (await requestNotificationPermission()) === 'granted';
    if (!granted) {
      setPushError('Notifications are turned off for Novarum in your system settings.');
      update({ pushNotifications: false });
      return;
    }

    try {
      await enablePush();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : 'Could not set up push notifications');
      update({ pushNotifications: false });
      return;
    }

    update({ pushNotifications: true });
    void notificationSettings().savePreferences({ push: true });
    if (canShow) void sendNotification({ title: 'Novarum notifications enabled' });
  }

  // the server decides what a push contains, so it needs to know about this one too
  function setMessagePreview(enabled: boolean) {
    update({ messagePreview: enabled });
    void notificationSettings().savePreferences({ messagePreview: enabled });
  }

  return (
    <SettingsPage description="Choose how Novarum gets your attention.">
      <SettingsGroup title="Alerts">
        <SettingsRow
          title="Push notifications"
          description="Get notified about mentions and replies."
        >
          <Switch value={pushNotifications} onValueChange={setPushNotifications} />
        </SettingsRow>
        <SettingsRow title="Message preview" description="Show the message text in notifications.">
          <Switch value={messagePreview} onValueChange={setMessagePreview} />
        </SettingsRow>
        {pushError ? (
          <Text className="px-4 py-2 text-xs text-destructive" accessibilityLiveRegion="polite">
            {pushError}
          </Text>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Sound">
        <SettingsRow title="Mention sound" description="Play a sound when someone mentions you.">
          <Switch value={mentionSound} onValueChange={(value) => update({ mentionSound: value })} />
        </SettingsRow>
        <SettingsRow title="Volume" stacked>
          <Slider
            value={notificationVolume}
            onCommit={(value) => {
              update({ notificationVolume: value });
              notificationSound();
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
