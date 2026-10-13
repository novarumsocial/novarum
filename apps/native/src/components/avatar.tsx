// Port of apps/frontend/src/lib/components/avatar.svelte + animated-image.svelte
// expo-image plays GIFs and caches on disk; `focused={false}` pauses them like the web's frozen frame.
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { Text } from './ui/text';

export function Avatar({
  src,
  name,
  className,
  focused = false,
  fallback,
  bgColor,
}: {
  src?: string | null;
  name: string;
  className?: string;
  focused?: boolean;
  fallback?: string;
  bgColor?: string | null;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<Image>(null);

  useEffect(() => setFailed(false), [src]);
  useEffect(() => {
    // The native view may be gone or not attached yet (frozen/recycled screens); `autoplay` covers that case.
    const image = imageRef.current;
    (focused ? image?.startAnimating() : image?.stopAnimating())?.catch(() => {});
  }, [focused]);

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={name}
      className={cn(
        'size-10 shrink-0 items-center justify-center overflow-hidden bg-primary/20',
        circleIcons && 'rounded-full',
        className
      )}
      style={bgColor ? { backgroundColor: bgColor } : undefined}
    >
      {src && !failed ? (
        <Image
          ref={imageRef}
          source={{ uri: src }}
          contentFit="contain"
          autoplay={focused}
          cachePolicy="memory-disk"
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <Text className="font-bold text-white">
          {fallback || name.charAt(0).toUpperCase() || '?'}
        </Text>
      )}
    </View>
  );
}
