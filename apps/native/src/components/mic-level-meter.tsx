// Port of apps/frontend/src/lib/components/mic-level-meter.svelte
// The web reads a MediaStream through an AnalyserNode; React Native has no Web Audio, so LiveKit's native
// volume processor (`useTrackVolume`) measures the local mic track instead.
import { useTrackVolume } from '@livekit/react-native';
import type { LocalAudioTrack } from 'livekit-client';
import { View } from 'react-native';
import { cn } from '@/lib/utils';

const N = 20;

// green most of the bar, yellow when getting loud, red when too loud
const barColor = (i: number) =>
  i / (N - 1) < 0.7 ? 'bg-green-500' : i / (N - 1) < 0.9 ? 'bg-yellow-400' : 'bg-red-500';

export function MicLevelMeter({ track }: { track: LocalAudioTrack | null }) {
  const level = useTrackVolume(track ?? undefined);
  const litCount = track ? Math.round(Math.min(1, level) * N) : 0;

  return (
    <View className="h-5 flex-row items-end gap-[3px]">
      {Array.from({ length: N }, (_, i) => (
        <View
          key={i}
          className={cn(
            'h-5 w-[3px] rounded-[1px]',
            i < litCount ? barColor(i) : 'bg-muted-foreground/25'
          )}
        />
      ))}
    </View>
  );
}
