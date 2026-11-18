// Port of apps/frontend/src/lib/components/voice-area.svelte
// Differences: reads the single `voice` store instead of taking it as a prop; no fullscreen button (the app
// is already full screen). The controls are a thumb-sized bar: mute, deafen, camera and "more" (output, screen
// share, flip camera, stream volume), then hang up, set apart. They only fade out while there is video on the
// stage, so an audio call never needs a tap just to wake them. The lobby shows who is already in the channel and
// lets you pick your mic before joining. Screen share is Android only (iOS needs a broadcast extension).
import { router } from 'expo-router';
import { ConnectionState } from 'livekit-client';
import {
  Bluetooth,
  Headphones,
  HeadphoneOff,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MoreHorizontal,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  Smartphone,
  SwitchCamera,
  Users,
  Video,
  VideoOff,
  Volume2,
  type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VolumeSlider } from '@/components/participant-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VoiceStage } from '@/components/voice-stage';
import { useChat } from '@/lib/chat-state';
import { useSettings } from '@/lib/settings';
import type { Author, Channel } from '@/lib/types/chat';
import { cn } from '@/lib/utils';
import { fallbackAvatarBg, type VoiceTile } from '@/lib/voice-layout';
import {
  selectConnected,
  selectConnecting,
  selectLocalIdentity,
  selectParticipantCount,
  useVoice,
  voice,
  type AudioOutput,
} from '@/lib/voice';

const outputs: Record<AudioOutput, { label: string; icon: LucideIcon }> = {
  speaker: { label: 'Speaker', icon: Volume2 },
  earpiece: { label: 'Earpiece', icon: Smartphone },
  bluetooth: { label: 'Bluetooth', icon: Bluetooth },
};

const CONTROLS_IDLE_MS = 4000;

function ControlButton({
  label,
  icon,
  onPress,
  tone = 'default',
  selected,
  large,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  tone?: 'default' | 'on' | 'off' | 'danger';
  selected?: boolean;
  large?: boolean;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={4}
      className={cn(
        'items-center justify-center active:opacity-70',
        large ? 'size-14' : 'size-12',
        tone === 'danger'
          ? 'bg-rose-600'
          : tone === 'off'
            ? 'bg-foreground'
            : tone === 'on'
              ? 'bg-primary'
              : 'bg-secondary',
        circleIcons && 'rounded-full'
      )}
    >
      <Icon
        as={icon}
        size={large ? 24 : 20}
        className={
          tone === 'danger'
            ? 'text-white'
            : tone === 'off'
              ? 'text-background'
              : tone === 'on'
                ? 'text-primary-foreground'
                : 'text-secondary-foreground'
        }
      />
    </Pressable>
  );
}

export function VoiceArea({
  channel,
  members,
  onJoin,
  onLeave,
  embedded = false,
  expanded = false,
  onToggleExpand,
}: {
  channel: Channel;
  members: Author[];
  onJoin: () => void;
  onLeave: () => void;
  embedded?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  // the controls sit above the home indicator when the call reaches the bottom of the screen
  const insets = useSafeAreaInsets();
  const bottomInset = !embedded || expanded ? insets.bottom : 0;
  const channelId = useVoice((s) => s.channelId);
  const connectionState = useVoice((s) => s.connectionState);
  const connected = useVoice(selectConnected);
  const connecting = useVoice(selectConnecting);
  const participantCount = useVoice(selectParticipantCount);
  const localIdentity = useVoice(selectLocalIdentity);
  const voiceStates = useVoice((s) => s.voiceStates);
  const selfMuted = useVoice((s) => s.selfMuted);
  const selfDeafened = useVoice((s) => s.selfDeafened);
  const selfCamera = useVoice((s) => s.selfCamera);
  const selfScreenShare = useVoice((s) => s.selfScreenShare);
  const cameraFacing = useVoice((s) => s.cameraFacing);
  const audioOutput = useVoice((s) => s.audioOutput);
  const audioOutputs = useVoice((s) => s.audioOutputs);

  const active = channelId === channel.id && (connected || connecting);
  const reconnecting =
    channelId === channel.id &&
    (connectionState === ConnectionState.Reconnecting ||
      connectionState === ConnectionState.SignalReconnecting);

  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);

  const tiles = useMemo<VoiceTile[]>(() => {
    const entries = [...voiceStates.entries()];
    const build = (kind: 'screen' | 'participant') =>
      entries
        .filter(([, state]) => (kind === 'screen' ? state.screenShare : true))
        .map(([identity, state]) => {
          const member = memberById.get(identity);
          return {
            key: kind === 'screen' ? `screen:${identity}` : identity,
            identity,
            state,
            kind,
            member,
            name: member?.displayName || member?.username || identity,
          };
        });

    // Screen shares first so they sort ahead of the people sharing them.
    return [...build('screen'), ...build('participant')];
  }, [voiceStates, memberById]);

  // The tile someone explicitly tapped into the spotlight. Beats screen-share
  // auto-promotion, same as tapping a face over a presentation in a real call.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [manualGrid, setManualGrid] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // who is in the channel before you join (the channel list's voice presence)
  const lobby = useChat((s) => s.voiceStates[channel.id]) ?? [];

  // only streams that are actually playing take over the stage; unwatched ones wait for a tap
  const autoSpotlightKey =
    tiles.find(
      (tile) => tile.kind === 'screen' && tile.state.screenTrack && tile.identity !== localIdentity
    )?.key ?? null;

  const spotlightKey =
    focusedKey && tiles.some((tile) => tile.key === focusedKey)
      ? focusedKey
      : manualGrid
        ? null
        : autoSpotlightKey;

  // Discord-style stream volume: only shown while spotlit on someone else's
  // screen share, and only affects that share's audio, not their mic.
  const spotlightScreenShare =
    tiles.find(
      (tile) =>
        tile.key === spotlightKey &&
        tile.kind === 'screen' &&
        tile.state.screenTrack &&
        tile.identity !== localIdentity
    ) ?? null;
  const screenVolume = useVoice(
    (s) => s.participantAudio[spotlightScreenShare?.identity ?? '']?.screenVolume ?? 1
  );

  // Tune into other people's streams automatically, once per stream,
  // so stopping it sticks until they share again.
  const autoWatched = useRef(new Set<string>());
  useEffect(() => {
    for (const [identity, state] of voiceStates) {
      if (identity === localIdentity) continue;
      if (!state.screenShare) autoWatched.current.delete(identity);
      else if (!autoWatched.current.has(identity)) {
        autoWatched.current.add(identity);
        voice().watchStream(identity);
      }
    }
  }, [voiceStates, localIdentity]);

  // A newly started screen share takes over the stage, even if the user had chosen grid.
  const lastAutoKey = useRef<string | null>(null);
  useEffect(() => {
    if (autoSpotlightKey && autoSpotlightKey !== lastAutoKey.current) setManualGrid(false);
    lastAutoKey.current = autoSpotlightKey;
  }, [autoSpotlightKey]);

  // If the person you focused on leaves, fall back instead of silently re-focusing
  // whoever reuses that identity next.
  useEffect(() => {
    if (focusedKey && !tiles.some((tile) => tile.key === focusedKey)) setFocusedKey(null);
  }, [focusedKey, tiles]);

  // Tapping a tile in the grid or filmstrip spotlights it: a person with or
  // without a camera, or a screen share all work the same way.
  const focusTile = (key: string) => {
    const tile = tiles.find((tile) => tile.key === key);
    if (tile?.kind === 'screen' && !tile.state.screenTrack) voice().watchStream(tile.identity);
    setFocusedKey(key);
    setManualGrid(false);
  };

  const showGrid = () => {
    setFocusedKey(null);
    setManualGrid(true);
  };

  // With video on the stage, controls fade out after a few seconds without touches; while hidden, a tap only
  // brings them back instead of also spotlighting whatever tile was under the finger. Audio-only calls keep them.
  const hasVideo = tiles.some((tile) => tile.state.camera || tile.state.screenShare);
  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showControls = !hasVideo || controlsVisible || volumeOpen || outputOpen || moreOpen;

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    wakeControls();
    return () => clearTimeout(idleTimer.current);
  }, [wakeControls, active]);

  // deafened also mutes, so the mic button says what tapping it does
  const micLabel = selfDeafened ? 'Unmute (also undeafens)' : selfMuted ? 'Unmute' : 'Mute';
  const then = (action: () => unknown) => () => {
    setMoreOpen(false);
    void action();
  };
  const available = audioOutputs.includes(audioOutput)
    ? audioOutputs
    : [...audioOutputs, audioOutput];

  return (
    <View className="min-h-0 min-w-0 flex-1 bg-background">
      {!embedded && (
        <ScreenHeader
          actions={
            <Button
              variant="ghost"
              size="icon"
              accessibilityLabel="Open members"
              onPress={() => router.push('/guilds/members')}
            >
              <Icon as={Users} size={20} />
            </Button>
          }
        >
          <Icon as={Volume2} size={20} className="text-muted-foreground" />
          <Text numberOfLines={1} className="shrink text-base font-semibold">
            {channel.name}
          </Text>
          {active && !connecting && (
            <Text className="text-sm text-muted-foreground">{participantCount}</Text>
          )}
        </ScreenHeader>
      )}

      <View
        className="relative min-h-0 min-w-0 flex-1 bg-background"
        accessibilityLabel="Call"
        onTouchStart={wakeControls}
        onStartShouldSetResponderCapture={() => {
          if (showControls) return false;
          wakeControls();
          return true;
        }}
      >
        {reconnecting && (
          <View
            className="shrink-0 flex-row items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-2"
            accessibilityRole="alert"
          >
            <Spinner />
            <Text className="text-sm text-amber-400">Reconnecting to voice…</Text>
          </View>
        )}

        {!active ? (
          <View className="min-h-0 flex-1 items-center justify-center gap-5 p-6">
            <View className="items-center">
              <Text className="text-lg font-semibold">{channel.name}</Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                {lobby.length === 0
                  ? 'No one is here yet.'
                  : `${lobby.length} ${lobby.length === 1 ? 'person is' : 'people are'} here`}
              </Text>
            </View>
            {lobby.length > 0 && (
              <View className="max-w-full flex-row flex-wrap justify-center gap-3">
                {lobby.slice(0, 8).map((state) => {
                  const member = memberById.get(state.userId);
                  const name = member?.displayName || member?.username || state.name || '?';
                  return (
                    <View key={state.userId} className="w-16 items-center gap-1">
                      <Avatar
                        src={member?.avatarUrl}
                        name={name}
                        bgColor={member?.avatarColor ?? fallbackAvatarBg(state.userId)}
                        className="size-12"
                      />
                      <Text numberOfLines={1} className="text-xs text-muted-foreground">
                        {name}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
            <View className="flex-row items-center gap-3">
              <ControlButton
                label={selfMuted ? 'Join muted. Tap to unmute' : 'Join with mic on. Tap to mute'}
                icon={selfMuted ? MicOff : Mic}
                tone={selfMuted ? 'off' : 'default'}
                selected={selfMuted}
                onPress={() => void voice().setMuted(!selfMuted)}
              />
              <Button size="lg" onPress={onJoin}>
                <Icon as={Volume2} size={18} className="text-primary-foreground" />
                <Text>Join voice</Text>
              </Button>
            </View>
            <Text className="text-sm text-muted-foreground">
              {selfMuted ? 'You will join muted.' : 'Your mic will be on.'}
            </Text>
          </View>
        ) : connecting ? (
          <View className="min-h-0 flex-1 items-center justify-center gap-3">
            <Spinner size="large" />
            <Text className="text-sm text-muted-foreground">Joining voice channel...</Text>
          </View>
        ) : tiles.length === 0 ? (
          <View className="min-h-0 flex-1 items-center justify-center">
            <Text className="text-sm font-medium">Connected</Text>
            <Text className="mt-1 text-sm text-muted-foreground">No one else is here yet.</Text>
          </View>
        ) : (
          <VoiceStage
            tiles={tiles}
            spotlightKey={spotlightKey}
            onFocus={focusTile}
            onExitSpotlight={showGrid}
          />
        )}

        {active && (
          <>
            <View
              pointerEvents={showControls ? 'box-none' : 'none'}
              className={cn(
                'absolute inset-x-0 z-10 items-center transition-opacity duration-300',
                !showControls && 'opacity-0'
              )}
              style={{ bottom: bottomInset + 12 }}
            >
              <View
                accessibilityLabel="Call controls"
                className={cn(
                  'flex-row items-center gap-3 border border-border bg-sidebar/90 px-3 py-2',
                  circleIcons && 'rounded-full'
                )}
              >
                <ControlButton
                  large
                  label={micLabel}
                  icon={selfMuted || selfDeafened ? MicOff : Mic}
                  tone={selfMuted || selfDeafened ? 'off' : 'default'}
                  selected={selfMuted}
                  onPress={() =>
                    void (selfDeafened ? voice().setDeafened(false) : voice().setMuted(!selfMuted))
                  }
                />
                <ControlButton
                  label={selfDeafened ? 'Undeafen' : 'Deafen'}
                  icon={selfDeafened ? HeadphoneOff : Headphones}
                  tone={selfDeafened ? 'off' : 'default'}
                  selected={selfDeafened}
                  onPress={() => void voice().setDeafened(!selfDeafened)}
                />
                <ControlButton
                  label={selfCamera ? 'Turn camera off' : 'Turn camera on'}
                  icon={selfCamera ? Video : VideoOff}
                  tone={selfCamera ? 'on' : 'default'}
                  selected={selfCamera}
                  onPress={() => void voice().setCamera(!selfCamera)}
                />
                <ControlButton
                  label="More call options"
                  icon={MoreHorizontal}
                  onPress={() => setMoreOpen(true)}
                />
                <View className="w-3" />
                <ControlButton
                  large
                  label="Leave call"
                  icon={PhoneOff}
                  tone="danger"
                  onPress={onLeave}
                />
              </View>
            </View>

            {onToggleExpand && (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'absolute top-3 right-3 z-10 bg-sidebar/80 transition-opacity duration-300',
                  circleIcons && 'rounded-full',
                  !showControls && 'opacity-0'
                )}
                pointerEvents={showControls ? 'auto' : 'none'}
                accessibilityLabel={expanded ? 'Show messages' : 'Expand call'}
                onPress={onToggleExpand}
              >
                <Icon as={expanded ? Minimize2 : Maximize2} size={20} className="text-foreground" />
              </Button>
            )}
          </>
        )}
      </View>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Call options">
        <SheetItem
          icon={outputs[audioOutput].icon}
          label={`Audio output: ${outputs[audioOutput].label}`}
          onPress={() => {
            setMoreOpen(false);
            setOutputOpen(true);
          }}
        />
        {Platform.OS !== 'ios' && (
          <SheetItem
            icon={selfScreenShare ? MonitorOff : MonitorUp}
            label={selfScreenShare ? 'Stop sharing screen' : 'Share screen'}
            onPress={then(() => voice().setScreenShare(!selfScreenShare))}
          />
        )}
        {selfCamera && (
          <SheetItem
            icon={SwitchCamera}
            label="Flip camera"
            onPress={then(() =>
              voice().setCameraFacing(cameraFacing === 'user' ? 'environment' : 'user')
            )}
          />
        )}
        {spotlightScreenShare && (
          <>
            <SheetItem
              icon={Volume2}
              label={`Stream volume for ${spotlightScreenShare.name}`}
              onPress={() => {
                setMoreOpen(false);
                setVolumeOpen(true);
              }}
            />
            <SheetItem
              icon={MonitorOff}
              label={`Stop watching ${spotlightScreenShare.name}`}
              onPress={then(() => {
                voice().stopWatchingStream(spotlightScreenShare.identity);
                showGrid();
              })}
            />
          </>
        )}
      </Sheet>

      <Sheet open={outputOpen} onClose={() => setOutputOpen(false)} title="Audio output">
        {available.map((output) => (
          <SheetItem
            key={output}
            icon={outputs[output].icon}
            label={outputs[output].label + (output === audioOutput ? ' (current)' : '')}
            onPress={() => {
              void voice().setAudioOutput(output);
              setOutputOpen(false);
            }}
          />
        ))}
      </Sheet>

      <Sheet open={volumeOpen} onClose={() => setVolumeOpen(false)} title="Stream volume">
        {spotlightScreenShare && (
          <VolumeSlider
            label="Stream volume"
            value={screenVolume}
            onChange={(volume) =>
              voice().setParticipantScreenVolume(spotlightScreenShare.identity, volume)
            }
          />
        )}
      </Sheet>
    </View>
  );
}
