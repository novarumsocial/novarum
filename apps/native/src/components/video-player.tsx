// Port of apps/frontend/src/lib/components/video-player.svelte
// Shows the poster until tapped, then mounts the native player (expo-video) with its own controls,
// fullscreen and picture-in-picture. A chat full of videos would otherwise load every file.
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Play } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import type { Attachment } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

function Playing({ attachment }: { attachment: Attachment }) {
  const player = useVideoPlayer(attachment.url, (instance) => instance.play());

  return (
    <VideoView
      player={player}
      nativeControls
      allowsPictureInPicture
      fullscreenOptions={{ enable: true }}
      contentFit="contain"
      style={{ width: '100%', height: '100%' }}
    />
  );
}

export function VideoPlayer({
  attachment,
  autoPlay = false,
  className,
}: {
  attachment: Attachment;
  autoPlay?: boolean;
  className?: string;
}) {
  const [active, setActive] = useState(autoPlay);

  return (
    <View
      className={cn('aspect-video w-full overflow-hidden border border-border bg-black', className)}
    >
      {active ? (
        <Playing attachment={attachment} />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Play ${attachment.filename}`}
          className="flex-1 items-center justify-center"
          onPress={() => setActive(true)}
        >
          <Image
            source={{ uri: attachment.previewUrl }}
            contentFit="cover"
            style={{ position: 'absolute', width: '100%', height: '100%' }}
          />
          <View className="size-14 items-center justify-center bg-black/60">
            <Icon as={Play} size={28} className="text-white" />
          </View>
        </Pressable>
      )}
    </View>
  );
}
