// Native-only: the banner shown while the app is open (the OS notification is suppressed in the foreground)
import { useEffect } from 'react';
import { Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInAppBanner } from '@/lib/notifications';
import { Text } from '@/components/ui/text';

export function InAppBanner() {
  const { banner, dismiss } = useInAppBanner();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!banner) return;
    const timeout = setTimeout(dismiss, 5000);
    return () => clearTimeout(timeout);
  }, [banner, dismiss]);

  if (!banner) return null;

  return (
    <Pressable
      onPress={() => {
        dismiss();
        banner.onClick?.();
      }}
      style={{ paddingTop: insets.top + 8 }}
      className="absolute inset-x-0 top-0 z-50 border-b border-border bg-popover px-4 pb-3"
    >
      <Text className="font-semibold" numberOfLines={1}>
        {banner.title}
      </Text>
      {banner.body ? (
        <Text className="text-sm text-muted-foreground" numberOfLines={2}>
          {banner.body}
        </Text>
      ) : null}
    </Pressable>
  );
}
