// Port of apps/frontend/src/lib/components/voice-tile.svelte
import { VideoView } from '@livekit/react-native';
import { HeadphoneOff, MicOff, MonitorUp, ZoomOut } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { ParticipantSheet } from '@/components/participant-sheet';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { fallbackAvatarBg, initialsFor, type VoiceTile } from '@/lib/voice-layout';
import { selectConnected, selectLocalIdentity, useVoice } from '@/lib/voice';

const MAX_ZOOM = 5;
const clamp = (value: number, min: number, max: number) => {
  'worklet';
  return Math.min(max, Math.max(min, value));
};

// native-only shape of the web's zoom-pan.svelte.ts: pinch, double-tap and (while zoomed) drag a
// spotlighted stream. A single tap only leaves the spotlight while not zoomed in.
function ZoomableVideo({
  width,
  height,
  resetSignal,
  onZoomChange,
  onTap,
  onLongPress,
  children,
}: {
  width: number;
  height: number;
  resetSignal: number;
  onZoomChange: (zoomed: boolean) => void;
  onTap?: () => void;
  onLongPress?: () => void;
  children: ReactNode;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const zoomed = useSharedValue(false);

  const setZoomed = (value: boolean) => {
    'worklet';
    if (zoomed.value === value) return;
    zoomed.value = value;
    runOnJS(onZoomChange)(value);
  };
  const keepInside = () => {
    'worklet';
    const maxX = (width * (scale.value - 1)) / 2;
    const maxY = (height * (scale.value - 1)) / 2;
    x.value = withSpring(clamp(x.value, -maxX, maxX));
    y.value = withSpring(clamp(y.value, -maxY, maxY));
    savedX.value = clamp(x.value, -maxX, maxX);
    savedY.value = clamp(y.value, -maxY, maxY);
  };
  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    savedScale.value = 1;
    x.value = withTiming(0);
    y.value = withTiming(0);
    savedX.value = 0;
    savedY.value = 0;
    setZoomed(false);
  };

  useEffect(() => {
    if (resetSignal) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = clamp(savedScale.value * event.scale, 1, MAX_ZOOM);
      if (scale.value > 1.02) setZoomed(true);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value < 1.05) reset();
      else keepInside();
    });

  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesMove((_event, manager) => {
      if (scale.value > 1.02) manager.activate();
      else manager.fail();
    })
    .onUpdate((event) => {
      x.value = savedX.value + event.translationX;
      y.value = savedY.value + event.translationY;
    })
    .onEnd(() => keepInside());

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDistance(10)
    .onEnd((event) => {
      if (scale.value > 1.05) return reset();
      const next = 2.5;
      const maxX = (width * (next - 1)) / 2;
      const maxY = (height * (next - 1)) / 2;
      scale.value = withTiming(next);
      savedScale.value = next;
      // zoom towards the tapped point
      savedX.value = clamp((width / 2 - event.x) * (next - 1), -maxX, maxX);
      savedY.value = clamp((height / 2 - event.y) * (next - 1), -maxY, maxY);
      x.value = withTiming(savedX.value);
      y.value = withTiming(savedY.value);
      setZoomed(true);
    });
  const singleTap = Gesture.Tap()
    .maxDistance(10)
    .onEnd(() => {
      if (!zoomed.value && onTap) runOnJS(onTap)();
    });
  const longPress = Gesture.LongPress().onStart(() => {
    if (onLongPress) runOnJS(onLongPress)();
  });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector
      gesture={Gesture.Race(
        Gesture.Simultaneous(pinch, pan),
        Gesture.Exclusive(longPress, doubleTap, singleTap)
      )}
    >
      <Animated.View style={[{ width: '100%', height: '100%' }, style]}>{children}</Animated.View>
    </GestureDetector>
  );
}

export function VoiceTileView({
  tile,
  width,
  height,
  compact = false,
  fitWithin,
  onSelect,
  ariaLabel,
  zoomable = false,
}: {
  tile: VoiceTile;
  width?: number;
  height?: number;
  compact?: boolean;
  // Size the tile to its video's own aspect ratio inside this box, instead of stretching.
  fitWithin?: { width: number; height: number };
  // Tap: grid/filmstrip tiles spotlight, the spotlighted tile exits back to the grid.
  onSelect?: () => void;
  ariaLabel?: string;
  // lets the viewer pinch-zoom and pan the video (the spotlighted stream)
  zoomable?: boolean;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  const connected = useVoice(selectConnected);
  const isSelf = useVoice(selectLocalIdentity) === tile.identity;
  const mirror = useVoice((s) => s.cameraFacing === 'user');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);

  const isScreen = tile.kind === 'screen';
  // your own screen is not rendered: capturing the app showing itself would loop
  const track = isScreen ? (isSelf ? null : tile.state.screenTrack) : tile.state.cameraTrack;
  const ringColor = tile.member?.speakingRingColor ?? '#00d492';

  const settings = track?.mediaStreamTrack?.getSettings?.();
  const aspect = settings?.width && settings.height ? settings.width / settings.height : 16 / 9;
  const box = (() => {
    if (!fitWithin) return { width, height };
    const fitted = Math.min(fitWithin.width, fitWithin.height * aspect);
    return { width: Math.floor(fitted), height: Math.floor(fitted / aspect) };
  })();

  return (
    <>
      <Pressable
        disabled={!onSelect && !connected}
        accessibilityLabel={onSelect ? (ariaLabel ?? `Spotlight ${tile.name}`) : tile.name}
        // a zoomable stream handles its own taps, so a tap while zoomed doesn't leave the spotlight
        onPress={zoomable && track ? undefined : onSelect}
        onLongPress={connected && !(zoomable && track) ? () => setSheetOpen(true) : undefined}
        className={cn(
          'relative overflow-hidden border border-border bg-muted',
          isScreen && 'bg-black',
          box.width === undefined && 'size-full'
        )}
        style={{ width: box.width, height: box.height }}
      >
        {track && zoomable && box.width && box.height ? (
          <ZoomableVideo
            width={box.width}
            height={box.height}
            resetSignal={resetSignal}
            onZoomChange={setZoomed}
            onTap={onSelect}
            onLongPress={connected ? () => setSheetOpen(true) : undefined}
          >
            <VideoView
              style={{ width: '100%', height: '100%' }}
              videoTrack={track}
              objectFit="contain"
            />
          </ZoomableVideo>
        ) : track ? (
          // contain, not cover: never crop someone's camera to fit the tile shape
          <VideoView
            style={{ width: '100%', height: '100%' }}
            videoTrack={track}
            objectFit="contain"
            mirror={isSelf && !isScreen && mirror}
          />
        ) : isScreen ? (
          <View className="size-full items-center justify-center gap-2">
            <Icon as={MonitorUp} size={compact ? 20 : 32} className="text-white" />
            {!compact && (
              <Text className="bg-white/10 px-3 py-1.5 text-sm font-medium text-white">
                {isSelf ? 'Sharing your screen' : 'Watch Stream'}
              </Text>
            )}
          </View>
        ) : (
          <View
            className={cn(
              'size-full items-center justify-center',
              !tile.member?.avatarColor && fallbackAvatarBg(tile.identity)
            )}
            style={
              tile.member?.avatarColor ? { backgroundColor: tile.member.avatarColor } : undefined
            }
          >
            <Avatar
              src={tile.member?.avatarUrl}
              name={tile.name}
              fallback={initialsFor(tile.name)}
              bgColor={tile.member?.avatarColor}
              className={cn(
                'rounded-full border-2 border-white/30 bg-black/20',
                compact ? 'size-10' : 'size-20'
              )}
            />
          </View>
        )}

        {/* speaking ring, drawn inside so it never changes the tile's box */}
        {tile.state.speaking && (
          <View
            pointerEvents="none"
            className="absolute inset-0 border-2"
            style={{ borderColor: ringColor }}
          />
        )}

        <View className="absolute bottom-0 left-0 max-w-full flex-row items-center gap-1.5 bg-black/65 px-2 py-1">
          {isScreen && <Icon as={MonitorUp} size={14} className="text-white" />}
          <Text
            numberOfLines={1}
            className={cn('shrink font-medium text-white', compact ? 'text-[11px]' : 'text-xs')}
          >
            {tile.name}
          </Text>
          {isSelf && <Text className="text-xs text-white/70">(you)</Text>}
        </View>

        {zoomable && zoomed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset zoom"
            onPress={() => setResetSignal((n) => n + 1)}
            className={cn(
              'absolute top-2 left-2 h-8 flex-row items-center gap-1.5 bg-black/60 px-2.5 active:bg-black/75',
              circleIcons && 'rounded-full'
            )}
          >
            <Icon as={ZoomOut} size={14} className="text-white" />
            <Text className="text-xs font-medium text-white">Reset zoom</Text>
          </Pressable>
        )}

        {!isScreen && (tile.state.selfMuted || tile.state.selfDeafened) && (
          <View
            className={cn(
              'absolute bottom-1.5 right-1.5 items-center justify-center bg-rose-600',
              compact ? 'size-5' : 'size-7',
              circleIcons && 'rounded-full'
            )}
          >
            <Icon
              as={tile.state.selfDeafened ? HeadphoneOff : MicOff}
              size={compact ? 12 : 16}
              className="text-white"
            />
          </View>
        )}
      </Pressable>

      {connected && sheetOpen && (
        <ParticipantSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          identity={tile.identity}
          name={tile.name}
          hasStream={isScreen}
        />
      )}
    </>
  );
}
