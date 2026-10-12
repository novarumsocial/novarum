// Port of apps/frontend/src/lib/components/participant-context-menu.svelte
// The right-click menu becomes a bottom sheet opened by long-pressing a tile.
import { Mic, MicOff, MonitorOff, MonitorUp } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { selectLocalIdentity, useVoice, voice } from '@/lib/voice';

const MAX = 300;

// 0-300 %, drag or tap anywhere on the track (no slider package is installed)
export function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (volume: number) => void;
}) {
  const [width, setWidth] = useState(1);
  const percent = Math.round(value * 100);
  const set = (x: number) => onChange(Math.round(Math.max(0, Math.min(1, x / width)) * MAX) / 100);
  const gesture = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .activeOffsetX([-4, 4])
    .failOffsetY([-16, 16])
    .onBegin((e) => set(e.x))
    .onUpdate((e) => set(e.x));

  return (
    <View className="gap-2 px-4 py-3">
      <View className="flex-row justify-between">
        <Text className="text-base">{label}</Text>
        <Pressable onPress={() => onChange(1)} hitSlop={8}>
          <Text className="text-base text-muted-foreground">{percent}%</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityValue={{ min: 0, max: MAX, now: percent }}
          className="h-8 justify-center"
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          <View className="h-1.5 bg-muted">
            <View className="h-1.5 bg-primary" style={{ width: `${(percent / MAX) * 100}%` }} />
          </View>
          <View
            className="absolute size-4 bg-primary"
            style={{ left: Math.max(0, (percent / MAX) * width - 8) }}
          />
        </View>
      </GestureDetector>
    </View>
  );
}

export function ParticipantSheet({
  open,
  onClose,
  identity,
  name,
  hasStream = false,
}: {
  open: boolean;
  onClose: () => void;
  identity: string;
  name: string;
  // they are sharing their screen (tiles of a screen share offer Watch / Stop watching)
  hasStream?: boolean;
}) {
  const isSelf = useVoice(selectLocalIdentity) === identity;
  const selfMuted = useVoice((s) => s.selfMuted);
  const muted = useVoice((s) => s.participantAudio[identity]?.muted ?? false);
  const volume = useVoice((s) => s.participantAudio[identity]?.volume ?? 1);
  const watching = useVoice((s) => s.watchedStreams.has(identity));

  return (
    <Sheet open={open} onClose={onClose}>
      {isSelf ? (
        <SheetItem
          icon={selfMuted ? Mic : MicOff}
          label={selfMuted ? 'Unmute' : 'Mute'}
          onPress={() => void voice().setMuted(!selfMuted)}
        />
      ) : (
        <>
          <SheetItem
            icon={muted ? Mic : MicOff}
            label={muted ? 'Remove local mute' : 'Local mute'}
            onPress={() => voice().setParticipantMuted(identity, !muted)}
          />
          <VolumeSlider
            label={`Volume for ${name}`}
            value={volume}
            onChange={(next) => voice().setParticipantVolume(identity, next)}
          />
          {hasStream && (
            <SheetItem
              icon={watching ? MonitorOff : MonitorUp}
              label={watching ? 'Stop watching stream' : 'Watch stream'}
              onPress={() => {
                if (watching) voice().stopWatchingStream(identity);
                else voice().watchStream(identity);
                onClose();
              }}
            />
          )}
        </>
      )}
    </Sheet>
  );
}
