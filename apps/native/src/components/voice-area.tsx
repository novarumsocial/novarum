// Port of apps/frontend/src/lib/components/voice-area.svelte
// Differences: reads the single `voice` store instead of taking it as a prop; no fullscreen button (the app
// is already full screen); the web's hover-driven controls fade after a few seconds without touches.
// Screen share is Android only (iOS needs a broadcast extension), so the button is hidden on iOS.
import { ConnectionState } from 'livekit-client';
import {
  Bluetooth,
  Headphones,
  HeadphoneOff,
  Maximize2,
  Menu,
  Mic,
  MicOff,
  Minimize2,
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
import { Platform, View } from 'react-native';
import { VolumeSlider } from '@/components/participant-sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VoiceStage } from '@/components/voice-stage';
import { useSettings } from '@/lib/settings';
import type { Author, Channel } from '@/lib/types/chat';
import { cn } from '@/lib/utils';
import type { VoiceTile } from '@/lib/voice-layout';
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

export function VoiceArea({
  channel,
  members,
  onJoin,
  onLeave,
  onOpenNavigation,
  onOpenMembers,
  embedded = false,
  expanded = false,
  onToggleExpand,
}: {
  channel: Channel;
  members: Author[];
  onJoin: () => void;
  onLeave: () => void;
  onOpenNavigation?: () => void;
  onOpenMembers?: () => void;
  embedded?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
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

  // In a 1:1 DM call, tune into the other person's stream automatically, once per stream,
  // so stopping it sticks until they share again.
  const autoWatched = useRef(new Set<string>());
  useEffect(() => {
    const dmOneOnOne = channel.type === 'DM' && voiceStates.size === 2;
    for (const [identity, state] of voiceStates) {
      if (identity === localIdentity) continue;
      if (!state.screenShare) autoWatched.current.delete(identity);
      else if (dmOneOnOne && !autoWatched.current.has(identity)) {
        autoWatched.current.add(identity);
        voice().watchStream(identity);
      }
    }
  }, [voiceStates, localIdentity, channel.type]);

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

  // Controls fade out after a few seconds without touches; while hidden, a tap only brings them
  // back instead of also spotlighting whatever tile was under the finger.
  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showControls = controlsVisible || volumeOpen || outputOpen;

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    wakeControls();
    return () => clearTimeout(idleTimer.current);
  }, [wakeControls, active]);

  const controlClass = cn('size-10', circleIcons && 'rounded-full');
  const micLabel = selfDeafened ? 'Undeafen' : selfMuted ? 'Unmute' : 'Mute';
  const available = audioOutputs.includes(audioOutput)
    ? audioOutputs
    : [...audioOutputs, audioOutput];

  return (
    <View className="min-h-0 min-w-0 flex-1 bg-background">
      {!embedded && (
        <View className="h-12 shrink-0 flex-row items-center gap-2 border-b border-border px-2">
          {onOpenNavigation && (
            <Button
              variant="ghost"
              size="icon"
              accessibilityLabel="Open channels"
              onPress={onOpenNavigation}
            >
              <Icon as={Menu} size={20} />
            </Button>
          )}
          <Icon as={Volume2} size={20} className="text-muted-foreground" />
          <Text numberOfLines={1} className="shrink text-sm font-semibold">
            {channel.name}
          </Text>
          {active && !connecting && (
            <Text className="text-xs text-muted-foreground">{participantCount}</Text>
          )}
          <View className="ml-auto flex-row items-center gap-1">
            {onOpenMembers && (
              <Button
                variant="ghost"
                size="icon"
                accessibilityLabel="Open members"
                onPress={onOpenMembers}
              >
                <Icon as={Users} size={20} />
              </Button>
            )}
          </View>
        </View>
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
            <Text className="text-xs text-amber-400">Reconnecting to voice...</Text>
          </View>
        )}

        {!active ? (
          <View className="min-h-0 flex-1 items-center justify-center gap-4 p-6">
            <View className="items-center">
              <Text className="text-sm font-medium">Join {channel.name}</Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Connect when you are ready.
              </Text>
            </View>
            <Button onPress={onJoin}>
              <Icon as={Volume2} size={16} className="text-primary-foreground" />
              <Text>Join Voice</Text>
            </Button>
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
                'absolute inset-x-0 bottom-3 z-10 items-center transition-opacity duration-300',
                !showControls && 'opacity-0'
              )}
            >
              <View
                accessibilityLabel="Call controls"
                className={cn(
                  'max-w-full flex-row flex-wrap items-center justify-center gap-1.5 border border-border bg-sidebar/80 p-2',
                  circleIcons && 'rounded-full'
                )}
              >
                <Button
                  variant={selfMuted ? 'destructive' : 'secondary'}
                  size="icon"
                  className={controlClass}
                  accessibilityLabel={micLabel}
                  accessibilityState={{ selected: selfMuted }}
                  onPress={() =>
                    selfDeafened ? voice().setDeafened(false) : voice().setMuted(!selfMuted)
                  }
                >
                  <Icon
                    as={selfMuted ? MicOff : Mic}
                    size={14}
                    className={
                      selfMuted ? 'text-destructive-foreground' : 'text-secondary-foreground'
                    }
                  />
                </Button>

                <Button
                  variant={selfDeafened ? 'destructive' : 'secondary'}
                  size="icon"
                  className={controlClass}
                  accessibilityLabel={selfDeafened ? 'Undeafen' : 'Deafen'}
                  accessibilityState={{ selected: selfDeafened }}
                  onPress={() => voice().setDeafened(!selfDeafened)}
                >
                  <Icon
                    as={selfDeafened ? HeadphoneOff : Headphones}
                    size={14}
                    className={
                      selfDeafened ? 'text-destructive-foreground' : 'text-secondary-foreground'
                    }
                  />
                </Button>

                <Button
                  variant={selfCamera ? 'default' : 'secondary'}
                  size="icon"
                  className={controlClass}
                  accessibilityLabel={selfCamera ? 'Turn camera off' : 'Turn camera on'}
                  accessibilityState={{ selected: selfCamera }}
                  onPress={() => voice().setCamera(!selfCamera)}
                >
                  <Icon
                    as={selfCamera ? Video : VideoOff}
                    size={14}
                    className={selfCamera ? 'text-primary-foreground' : 'text-secondary-foreground'}
                  />
                </Button>

                {Platform.OS !== 'ios' && (
                  <Button
                    variant={selfScreenShare ? 'default' : 'secondary'}
                    size="icon"
                    className={controlClass}
                    accessibilityLabel={selfScreenShare ? 'Stop sharing screen' : 'Share screen'}
                    accessibilityState={{ selected: selfScreenShare }}
                    onPress={() => voice().setScreenShare(!selfScreenShare)}
                  >
                    <Icon
                      as={selfScreenShare ? MonitorOff : MonitorUp}
                      size={14}
                      className={
                        selfScreenShare ? 'text-primary-foreground' : 'text-secondary-foreground'
                      }
                    />
                  </Button>
                )}

                {selfCamera && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className={controlClass}
                    accessibilityLabel="Flip camera"
                    onPress={() =>
                      voice().setCameraFacing(cameraFacing === 'user' ? 'environment' : 'user')
                    }
                  >
                    <Icon as={SwitchCamera} size={14} className="text-secondary-foreground" />
                  </Button>
                )}

                <Button
                  variant="secondary"
                  size="icon"
                  className={controlClass}
                  accessibilityLabel="Audio output"
                  onPress={() => setOutputOpen(true)}
                >
                  <Icon
                    as={outputs[audioOutput].icon}
                    size={14}
                    className="text-secondary-foreground"
                  />
                </Button>

                {spotlightScreenShare && (
                  <>
                    <Button
                      variant="secondary"
                      size="icon"
                      className={controlClass}
                      accessibilityLabel={`Stream volume for ${spotlightScreenShare.name}`}
                      onPress={() => setVolumeOpen(true)}
                    >
                      <Icon as={Volume2} size={14} className="text-secondary-foreground" />
                    </Button>
                    <Button
                      variant="secondary"
                      size="icon"
                      className={controlClass}
                      accessibilityLabel={`Stop watching ${spotlightScreenShare.name}`}
                      onPress={() => {
                        voice().stopWatchingStream(spotlightScreenShare.identity);
                        showGrid();
                      }}
                    >
                      <Icon as={MonitorOff} size={14} className="text-secondary-foreground" />
                    </Button>
                  </>
                )}

                <Button
                  variant="destructive"
                  size="icon"
                  className={controlClass}
                  accessibilityLabel="Leave call"
                  onPress={onLeave}
                >
                  <Icon as={PhoneOff} size={14} className="text-destructive-foreground" />
                </Button>
              </View>
            </View>

            {onToggleExpand && (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  controlClass,
                  'absolute bottom-5 right-3 z-10 transition-opacity duration-300',
                  !showControls && 'opacity-0'
                )}
                pointerEvents={showControls ? 'auto' : 'none'}
                accessibilityLabel={expanded ? 'Show messages' : 'Expand call'}
                onPress={onToggleExpand}
              >
                <Icon
                  as={expanded ? Minimize2 : Maximize2}
                  size={16}
                  className="text-muted-foreground"
                />
              </Button>
            )}
          </>
        )}
      </View>

      <Sheet open={outputOpen} onClose={() => setOutputOpen(false)}>
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

      <Sheet open={volumeOpen} onClose={() => setVolumeOpen(false)}>
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
