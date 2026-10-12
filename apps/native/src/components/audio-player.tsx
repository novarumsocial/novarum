// Port of apps/frontend/src/lib/components/audio-player.svelte
// Native player (expo-audio). The player is created on the first tap, so a long chat doesn't load every file.
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Download, Pause, Play } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { Attachment } from '@/lib/types/chat';

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function Controls({
  attachment,
  playing = false,
  current = 0,
  duration = 0,
  onToggle,
  onSeek,
}: {
  attachment: Attachment;
  playing?: boolean;
  current?: number;
  duration?: number;
  onToggle: () => void;
  onSeek?: (fraction: number) => void;
}) {
  const [width, setWidth] = useState(1);

  return (
    <View className="w-full gap-1 border border-border bg-muted/30 p-2">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          onPress={onToggle}
          className="size-11 items-center justify-center bg-primary active:opacity-80"
        >
          <Icon as={playing ? Pause : Play} size={18} className="text-primary-foreground" />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text className="text-xs" numberOfLines={1}>
            {attachment.filename}
          </Text>
          {/* tap anywhere on the bar to seek (dragging would fight the row's swipe-to-reply) */}
          <Pressable
            accessibilityRole="adjustable"
            className="h-6 justify-center"
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            onPress={(event) => onSeek?.(event.nativeEvent.locationX / width)}
          >
            <View className="h-1 bg-muted">
              <View
                className="h-1 bg-primary"
                style={{ width: duration ? `${Math.min(100, (current / duration) * 100)}%` : 0 }}
              />
            </View>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Download ${attachment.filename}`}
          hitSlop={8}
          onPress={() => void Linking.openURL(attachment.url)}
          className="size-11 items-center justify-center"
        >
          <Icon as={Download} size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      <Text className="font-mono text-[10px] text-muted-foreground">
        {clock(current)} / {clock(duration)}
      </Text>
    </View>
  );
}

// plays as soon as it loads (the tap that mounted it was the "play")
function LoadedPlayer({ attachment }: { attachment: Attachment }) {
  const player = useAudioPlayer(attachment.url);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    if (status.isLoaded) player.play();
  }, [status.isLoaded, player]);

  return (
    <Controls
      attachment={attachment}
      playing={status.playing}
      current={status.currentTime}
      duration={status.duration}
      onToggle={() => {
        if (status.playing) return player.pause();
        if (status.didJustFinish) void player.seekTo(0);
        player.play();
      }}
      onSeek={(fraction) =>
        void player.seekTo(Math.max(0, Math.min(1, fraction)) * status.duration)
      }
    />
  );
}

export function AudioPlayer({ attachment }: { attachment: Attachment }) {
  const [started, setStarted] = useState(false);

  if (started) return <LoadedPlayer attachment={attachment} />;

  return (
    <Controls
      attachment={attachment}
      onToggle={() => {
        void Haptics.selectionAsync();
        setStarted(true);
      }}
    />
  );
}
