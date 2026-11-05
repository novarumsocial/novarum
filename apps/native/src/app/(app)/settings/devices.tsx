// Port of apps/frontend/src/lib/components/settings-devices.svelte (the "devices" tab of settings-dialog.svelte)
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { RefreshCw, Smartphone } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { formatDate } from '@/lib/format-date';
import { disablePush } from '@/lib/push';
import { settings, useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

type Device = {
  id: string;
  kind: 'WEBPUSH' | 'UNIFIEDPUSH';
  host: string;
  createdAt: string;
  current: boolean;
};

function addedLabel(createdAt: string) {
  const date = formatDate(new Date(createdAt));
  return `Added ${date === 'Today' || date === 'Yesterday' ? date.toLowerCase() : date}`;
}

export default function Devices() {
  const circleIcons = useSettings((s) => s.circleIcons);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    const result = await anchor()
      .client.notifications.subscriptions.get()
      .catch(() => null);
    if (result?.data) setDevices(result.data.subscriptions);
    else setLoadError(true);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    return () => clearTimeout(confirmTimer.current);
  }, []);

  const remove = async (device: Device) => {
    setRemoveError(null);
    clearTimeout(confirmTimer.current);
    if (confirmingId !== device.id) {
      void Haptics.selectionAsync();
      setConfirmingId(device.id);
      confirmTimer.current = setTimeout(() => setConfirmingId(null), 4000);
      return;
    }

    setConfirmingId(null);
    setRemovingId(device.id);
    const drop = () => setDevices((list) => list.filter((item) => item.id !== device.id));
    // this app would register itself again on its next start, so it stops asking for pushes too
    if (device.current) {
      settings().update({ pushNotifications: false });
      await disablePush();
      drop();
    } else {
      const result = await anchor()
        .client.notifications.subscriptions({ id: device.id })
        .delete()
        .catch(() => null);
      if (result?.data || result?.status === 404) drop();
      else setRemoveError(`Couldn't remove ${device.host}. Check your connection and try again.`);
    }
    setRemovingId(null);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const unifiedPushDevices = devices.filter((device) => device.kind === 'UNIFIEDPUSH');

  return (
    <SettingsPage description="Phones that get your notifications.">
      <SettingsGroup
        title="Push notifications"
        description="Remove a phone to stop its notifications. Signing out of it does the same."
      >
        {loading ? (
          <View className="flex-row items-center gap-2 px-4 py-6">
            <Spinner />
            <Text className="text-sm text-muted-foreground">Loading devices…</Text>
          </View>
        ) : loadError ? (
          <View className="gap-3 px-4 py-4">
            <Text className="text-sm text-muted-foreground">
              Couldn&apos;t load your devices. Check your connection and try again.
            </Text>
            <Button variant="outline" size="sm" className="flex-row gap-2 self-start" onPress={load}>
              <Icon as={RefreshCw} size={14} />
              <Text>Retry</Text>
            </Button>
          </View>
        ) : unifiedPushDevices.length === 0 ? (
          <View className="flex-row items-start gap-3 px-4 py-3.5">
            <View
              className={cn(
                'size-9 items-center justify-center border border-dashed border-muted-foreground/30',
                circleIcons && 'rounded-full'
              )}
            >
              <Icon as={Smartphone} size={16} className="text-muted-foreground" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium">No phones yet</Text>
              <Text className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Turn on push notifications, with a UnifiedPush distributor like ntfy.
              </Text>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 self-start"
                onPress={() => router.push('/settings/notifications')}
              >
                <Text>Notification settings</Text>
              </Button>
            </View>
          </View>
        ) : (
          unifiedPushDevices.map((device) => {
            const confirming = confirmingId === device.id;
            const removing = removingId === device.id;
            return (
              <Animated.View
                key={device.id}
                exiting={FadeOut.duration(160)}
                layout={LinearTransition.duration(160)}
                className="flex-row items-center gap-3 px-4 py-3.5"
              >
                <View
                  className={cn(
                    'size-9 items-center justify-center bg-muted',
                    circleIcons && 'rounded-full'
                  )}
                >
                  <Icon as={Smartphone} size={16} className="text-muted-foreground" />
                </View>
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="shrink text-sm font-medium" numberOfLines={1}>
                      {device.host}
                    </Text>
                    {device.current && (
                      <View className="bg-primary/30 px-1.5 py-0.5">
                        <Text className="text-[11px] font-medium text-foreground">This device</Text>
                      </View>
                    )}
                  </View>
                  <Text
                    className={cn(
                      'mt-0.5 text-xs',
                      confirming ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {confirming
                      ? device.current
                        ? 'Tap again to remove. This also turns off push notifications here.'
                        : 'Tap again to remove. It stops getting notifications.'
                      : addedLabel(device.createdAt)}
                  </Text>
                </View>
                <Button
                  variant={confirming ? 'destructive' : 'ghost'}
                  size="sm"
                  disabled={removing}
                  accessibilityLabel={
                    confirming ? `Confirm removing ${device.host}` : `Remove ${device.host}`
                  }
                  onPress={() => void remove(device)}
                >
                  {removing ? (
                    <Spinner />
                  ) : (
                    <Text>
                      {confirming ? 'Confirm remove' : 'Remove'}
                    </Text>
                  )}
                </Button>
              </Animated.View>
            );
          })
        )}
      </SettingsGroup>
      {removeError ? <Text className="text-xs text-destructive">{removeError}</Text> : null}
    </SettingsPage>
  );
}
