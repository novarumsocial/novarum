// Port of apps/frontend/src/lib/components/voice-tile.svelte
import { VideoView } from '@livekit/react-native';
import { HeadphoneOff, MicOff, MonitorUp } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { ParticipantSheet } from '@/components/participant-sheet';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { fallbackAvatarBg, initialsFor, type VoiceTile } from '@/lib/voice-layout';
import { selectConnected, selectLocalIdentity, useVoice } from '@/lib/voice';

export function VoiceTileView({
  tile,
  width,
  height,
  compact = false,
  fitWithin,
  onSelect,
  ariaLabel,
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
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  const connected = useVoice(selectConnected);
  const isSelf = useVoice(selectLocalIdentity) === tile.identity;
  const mirror = useVoice((s) => s.cameraFacing === 'user');
  const [sheetOpen, setSheetOpen] = useState(false);

  const isScreen = tile.kind === 'screen';
  const track = isScreen ? tile.state.screenTrack : tile.state.cameraTrack;
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
        onPress={onSelect}
        onLongPress={connected ? () => setSheetOpen(true) : undefined}
        className={cn(
          'relative overflow-hidden border border-border bg-muted',
          isScreen && 'bg-black',
          box.width === undefined && 'size-full'
        )}
        style={{ width: box.width, height: box.height }}
      >
        {track ? (
          // contain, not cover: never crop someone's camera to fit the tile shape
          <VideoView
            style={{ width: '100%', height: '100%' }}
            videoTrack={track}
            objectFit="contain"
            mirror={isSelf && !isScreen && mirror}
          />
        ) : isScreen && !isSelf ? (
          <View className="size-full items-center justify-center gap-2">
            <Icon as={MonitorUp} size={compact ? 20 : 32} className="text-white" />
            {!compact && (
              <Text className="bg-white/10 px-3 py-1.5 text-sm font-medium text-white">
                Watch Stream
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

      {connected && (
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
