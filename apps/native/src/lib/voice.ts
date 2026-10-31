// Port of apps/frontend/src/lib/voice.svelte.ts
// Not ported (web/desktop only): RNNoise worklet (WebRTC `noiseSuppression` instead), input/output device
// pickers (audio route + camera facing instead), "audio playback blocked" (no autoplay policy on phones),
// system audio in screen shares and iOS screen share (needs a broadcast extension), and the loopback playback
// of the mic test (RN has no audio element).
import { registerGlobals, AudioSession } from '@livekit/react-native';
import * as Haptics from 'expo-haptics';
import {
  ConnectionState,
  createLocalAudioTrack,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrackPublication,
  type VideoTrack,
} from 'livekit-client';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { anchor } from './anchor';
import { chat } from './chat-state';
import { realtime } from './realtime';
import { settings } from './settings';
import { playSound, setInCall } from './sounds';

// must run once before `Room` is used
registerGlobals();

const livekitConnectionTimeoutMs = 15_000;
const microphoneCaptureOptions = () => ({
  echoCancellation: settings().voiceEchoCancellation,
  autoGainControl: settings().voiceAutoGainControl,
  noiseSuppression: settings().noiseCancellation,
  channelCount: 1,
  sampleRate: 48000,
});

// sounds (same files and volume as the web)
const sources = {
  join: require('../../assets/sounds/join.opus'),
  leave: require('../../assets/sounds/leave.opus'),
  mute: require('../../assets/sounds/mute.opus'),
  unmute: require('../../assets/sounds/mute-reverse.opus'),
  deafen: require('../../assets/sounds/deafen.opus'),
  undeafen: require('../../assets/sounds/deafen-reverse.opus'),
  camera: require('../../assets/sounds/camera.opus'),
  cameraOff: require('../../assets/sounds/camera-off.opus'),
  screen: require('../../assets/sounds/screen.opus'),
  screenOff: require('../../assets/sounds/screen-off.opus'),
};
const play = (name: keyof typeof sources, keepAudioSessionActive?: boolean) =>
  playSound(sources[name], 1, keepAudioSessionActive);

export interface VoiceState {
  userId: string;
  channelId: string;

  selfMuted: boolean;
  selfDeafened: boolean;
  serverMuted: boolean;

  camera: boolean;
  cameraTrack: VoiceVideoTrack | null;
  screenShare: boolean;
  screenTrack: VoiceVideoTrack | null;
  speaking: boolean;
}

// what `VideoView` from @livekit/react-native renders
export type VoiceVideoTrack = VideoTrack;

export type AudioOutput = 'speaker' | 'earpiece' | 'bluetooth';
export type CameraFacing = 'user' | 'environment';
type ParticipantAudio = { volume: number; muted: boolean; screenVolume: number };

type VoiceStore = {
  room: Room | null;
  channelId: string | null;
  connectionState: ConnectionState;
  selfMuted: boolean;
  mutedBeforeDeafen: boolean;
  selfDeafened: boolean;
  selfCamera: boolean;
  selfScreenShare: boolean;
  cameraFacing: CameraFacing;
  audioOutput: AudioOutput;
  audioOutputs: AudioOutput[];
  voiceStates: Map<string, VoiceState>;
  // remote screen shares are only subscribed to once the user chooses to watch them
  watchedStreams: Set<string>;
  participantAudio: Record<string, ParticipantAudio>;
  // mic test: a local track whose level `MicLevelMeter` shows (no loopback playback on phones)
  audioLoopbackTesting: boolean;
  audioLoopbackTrack: LocalAudioTrack | null;

  join: (channelId: string) => Promise<void>;
  leave: () => Promise<void>;
  watchStream: (identity: string) => void;
  stopWatchingStream: (identity: string) => void;
  setMuted: (muted: boolean) => Promise<void>;
  setDeafened: (deafened: boolean) => Promise<void>;
  setAudioLoopbackTesting: (testing: boolean) => Promise<void>;
  participantVolume: (identity: string) => number;
  participantMuted: (identity: string) => boolean;
  participantScreenVolume: (identity: string) => number;
  setParticipantVolume: (identity: string, volume: number) => void;
  setParticipantMuted: (identity: string, muted: boolean) => void;
  setParticipantScreenVolume: (identity: string, volume: number) => void;
  setCamera: (enabled: boolean) => Promise<void>;
  setCameraFacing: (facing: CameraFacing) => Promise<void>;
  // Android only: iOS needs a broadcast upload extension
  setScreenShare: (enabled: boolean) => Promise<void>;
  setAudioOutput: (output: AudioOutput) => Promise<void>;
  setNoiseCancellation: (enabled: boolean) => Promise<void>;
  setEchoCancellation: (enabled: boolean) => Promise<void>;
  setAutoGainControl: (enabled: boolean) => Promise<void>;
};

// iOS only knows "default" and "force_speaker"; Android has the real routes
const iosOutputs: Record<string, AudioOutput> = { default: 'earpiece', force_speaker: 'speaker' };
const toRoute = (output: AudioOutput) =>
  Platform.OS === 'ios' ? (output === 'speaker' ? 'force_speaker' : 'default') : output;

const clampVolume = (volume: number) => Math.max(0, Math.min(3, volume));

export const useVoice = create<VoiceStore>((set, get) => {
  let connectionAttempt = 0;
  // the leave sound of a channel switch must not end the audio session the next call is starting
  let switchingChannel = false;
  let captureSettingsOperation: Promise<void> = Promise.resolve();
  // start / stop calls run one after another so a quick leave + join can't end with the session stopped
  let audioSessionOperation: Promise<void> = Promise.resolve();
  const runAudioSession = (operation: () => Promise<void>) =>
    (audioSessionOperation = audioSessionOperation.catch(() => undefined).then(operation));
  const stopAudioSession = () =>
    runAudioSession(async () => {
      if (!get().room) await AudioSession.stopAudioSession();
    }).catch(() => undefined);

  const micTrack = (room: Room) =>
    room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;

  const updateVoiceState = (identity: string, state: VoiceState) =>
    set((s) => ({ voiceStates: new Map(s.voiceStates).set(identity, state) }));

  const resetRoom = () => {
    set({
      room: null,
      channelId: null,
      connectionState: ConnectionState.Disconnected,
      selfCamera: false,
      selfScreenShare: false,
      voiceStates: new Map(),
      watchedStreams: new Set(),
    });
  };

  const syncSubscription = (publication: RemoteTrackPublication, identity: string) => {
    const isStream =
      publication.source === Track.Source.ScreenShare ||
      publication.source === Track.Source.ScreenShareAudio;
    publication.setSubscribed(!isStream || get().watchedStreams.has(identity));
  };

  const syncStreamSubscriptions = (identity: string) => {
    const participant = get().room?.remoteParticipants.get(identity);
    for (const publication of participant?.trackPublications.values() ?? []) {
      syncSubscription(publication, identity);
    }
  };

  // remote audio is played natively by WebRTC; deafening sets every remote volume to 0
  const updateParticipantAudio = (identity: string) => {
    const participant = get().room?.remoteParticipants.get(identity);
    if (!participant) return;

    const silent = get().selfDeafened || get().participantMuted(identity);
    participant.setVolume(silent ? 0 : get().participantVolume(identity), Track.Source.Microphone);
    participant.setVolume(
      silent ? 0 : get().participantScreenVolume(identity),
      Track.Source.ScreenShareAudio
    );
  };

  const setParticipantAudio = (identity: string, patch: Partial<ParticipantAudio>) => {
    const current = {
      volume: get().participantVolume(identity),
      muted: get().participantMuted(identity),
      screenVolume: get().participantScreenVolume(identity),
    };
    set((s) => ({
      participantAudio: { ...s.participantAudio, [identity]: { ...current, ...patch } },
    }));
    updateParticipantAudio(identity);
  };

  const syncLocalMicrophone = async (room: Room) => {
    const enabled = !get().selfMuted && !get().selfDeafened;

    try {
      await room.localParticipant.setMicrophoneEnabled(enabled, microphoneCaptureOptions());
    } catch {
      if (get().room === room && enabled) set({ selfMuted: true });
    }
  };

  const activeVideoTrack = (isMuted: boolean | undefined, track: Track | undefined) => {
    if (isMuted || track?.kind !== Track.Kind.Video) return null;
    return track.mediaStreamTrack?.readyState === 'ended' ? null : (track as VideoTrack);
  };

  const syncParticipant = (participant: Participant) => {
    // ignore late events and awaits that finish after leaving, or for someone who already left
    const { room, channelId } = get();
    const current = participant.isLocal
      ? room?.localParticipant
      : room?.remoteParticipants.get(participant.identity);
    if (!channelId || current !== participant) return;

    const micPub = participant.getTrackPublication(Track.Source.Microphone);
    const screenPub = participant.getTrackPublication(Track.Source.ScreenShare);
    const cameraPub = participant.getTrackPublication(Track.Source.Camera);

    const isLocal = participant.isLocal;
    const cameraTrack = activeVideoTrack(cameraPub?.isMuted, cameraPub?.track);
    const screenTrack = activeVideoTrack(screenPub?.isMuted, screenPub?.track);

    if (isLocal) {
      // the system can end a share on its own (notification, status bar chip), which unpublishes the track
      if (get().selfScreenShare !== !!screenTrack) play(screenTrack ? 'screen' : 'screenOff');
      set({ selfCamera: !!cameraTrack, selfScreenShare: !!screenTrack });
    }

    updateVoiceState(participant.identity, {
      userId: participant.identity,
      channelId,
      selfMuted: isLocal ? get().selfMuted : !micPub || micPub.isMuted,
      selfDeafened: isLocal ? get().selfDeafened : false,
      serverMuted: false,
      camera: !!cameraTrack,
      cameraTrack,
      screenShare: !!screenTrack || (!isLocal && !!screenPub && !screenPub.isMuted),
      screenTrack,
      speaking: participant.isSpeaking,
    });
  };

  // on = the track turned on (unmuted / published); video sources only react to publish changes too
  const playRemoteSound = (source: Track.Source, on: boolean, published = false) => {
    if (!settings().othersCallSounds) return;
    if (source === Track.Source.Microphone && !published) play(on ? 'unmute' : 'mute');
    if (source === Track.Source.Camera) play(on ? 'camera' : 'cameraOff');
    if (source === Track.Source.ScreenShare) play(on ? 'screen' : 'screenOff');
  };

  const bindRoomEvents = (room: Room) => {
    room
      .on(RoomEvent.ConnectionStateChanged, (state) => set({ connectionState: state }))
      .on(RoomEvent.Disconnected, () => {
        if (get().room !== room) return;

        resetRoom();
        void stopAudioSession();
        realtime().leaveVoice();
      })
      .on(RoomEvent.Reconnected, () => {
        for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) {
          syncParticipant(participant);
        }
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        syncParticipant(participant);
        if (settings().othersCallSounds) play('join');
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        set((s) => {
          const voiceStates = new Map(s.voiceStates);
          const watchedStreams = new Set(s.watchedStreams);
          voiceStates.delete(participant.identity);
          watchedStreams.delete(participant.identity);
          return { voiceStates, watchedStreams };
        });
        if (settings().othersCallSounds) play('leave');
      })
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        if (!participant.isLocal) playRemoteSound(publication.source, false);
        // livekit mutes the mic on its own when the device drops out (sleep, unplug, bluetooth),
        // so turn it back on, or show the user as muted if that fails
        else if (
          publication.source === Track.Source.Microphone &&
          !get().selfMuted &&
          !get().selfDeafened
        ) {
          void syncLocalMicrophone(room).then(() => syncParticipant(participant));
        }
        syncParticipant(participant);
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
        if (!participant.isLocal) playRemoteSound(publication.source, true);
        syncParticipant(participant);
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        playRemoteSound(publication.source, true, true);
        syncSubscription(publication, participant.identity);
        syncParticipant(participant);
      })
      .on(RoomEvent.TrackUnpublished, (publication, participant) => {
        playRemoteSound(publication.source, false, true);
        if (publication.source === Track.Source.ScreenShare) {
          get().stopWatchingStream(participant.identity);
        }
        syncParticipant(participant);
      })
      .on(RoomEvent.LocalTrackPublished, (_publication, participant) => {
        syncParticipant(participant);
      })
      .on(RoomEvent.LocalTrackUnpublished, (_publication, participant) => {
        syncParticipant(participant);
      })
      .on(RoomEvent.TrackSubscribed, (_track, _publication, participant) => {
        updateParticipantAudio(participant.identity);
        syncParticipant(participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
        syncParticipant(participant);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const speaking = new Set(speakers.map((speaker) => speaker.identity));
        set((s) => {
          if ([...s.voiceStates].every(([id, state]) => state.speaking === speaking.has(id)))
            return s;
          return {
            voiceStates: new Map(
              [...s.voiceStates].map(([id, state]) => [
                id,
                // unchanged people keep their object, so only their own views re-render
                state.speaking === speaking.has(id)
                  ? state
                  : { ...state, speaking: !state.speaking },
              ])
            ),
          };
        });
      });
  };

  // restart the mic capture so changed echo / gain / noise constraints apply
  const applyCaptureSettings = async () => {
    const room = get().room;
    if (!room || get().selfMuted || get().selfDeafened) return;

    captureSettingsOperation = captureSettingsOperation
      .catch(() => undefined)
      .then(async () => {
        const track = micTrack(room);
        if (get().room !== room || !(track instanceof LocalAudioTrack)) return;
        await track.restartTrack(microphoneCaptureOptions());
      });

    try {
      await captureSettingsOperation;
    } catch (error) {
      console.error('could not apply microphone settings', error);
    }
  };

  const loadAudioOutputs = async () => {
    const outputs = (await AudioSession.getAudioOutputs()).flatMap((id) =>
      Platform.OS === 'ios' ? (iosOutputs[id] ?? []) : [id as AudioOutput]
    );
    set({
      audioOutputs: outputs.filter((o) => ['speaker', 'earpiece', 'bluetooth'].includes(o)),
    });
  };

  return {
    room: null,
    channelId: null,
    connectionState: ConnectionState.Disconnected,
    selfMuted: false,
    mutedBeforeDeafen: false,
    selfDeafened: false,
    selfCamera: false,
    selfScreenShare: false,
    cameraFacing: 'user',
    audioOutput: 'speaker',
    audioOutputs: ['speaker', 'earpiece'],
    voiceStates: new Map(),
    watchedStreams: new Set(),
    participantAudio: {},
    audioLoopbackTesting: false,
    audioLoopbackTrack: null,

    async join(channelId) {
      const { connectionState } = get();
      const busy =
        connectionState === ConnectionState.Connected ||
        connectionState === ConnectionState.Connecting;
      if (get().channelId === channelId && busy) return;

      if (get().room) {
        if (get().channelId === channelId) return;
        switchingChannel = true;
        try {
          await get().leave();
        } finally {
          switchingChannel = false;
        }
      }

      const attempt = ++connectionAttempt;
      set({ channelId, connectionState: ConnectionState.Connecting });
      play('join');

      const { data, error } = await anchor().client.channel({ id: channelId }).call.token.get();
      if (connectionAttempt !== attempt) return;

      if (error) {
        set({ channelId: null, connectionState: ConnectionState.Disconnected });
        throw error;
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: microphoneCaptureOptions(),
        videoCaptureDefaults: { facingMode: get().cameraFacing },
      });
      set({ room });
      bindRoomEvents(room);

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await runAudioSession(() => AudioSession.startAudioSession());
        if (connectionAttempt !== attempt || get().room !== room) return;

        if (get().audioOutput !== 'speaker') {
          get()
            .setAudioOutput(get().audioOutput)
            .catch(() => null);
        }
        void loadAudioOutputs().catch(() => null);

        const connectPromise = room.connect(data.serverUrl, data.token, { autoSubscribe: false });
        connectPromise.catch(() => null);
        await Promise.race([
          connectPromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Voice connection timed out')),
              livekitConnectionTimeoutMs
            );
          }),
        ]);
      } catch (error) {
        if (connectionAttempt !== attempt || get().room !== room) return;

        resetRoom();
        // a connect that timed out may still finish later, so cancel it
        room.removeAllListeners();
        await room.disconnect().catch(() => null);
        void stopAudioSession();
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      if (connectionAttempt !== attempt || get().room !== room) {
        await room.disconnect().catch(() => null);
        return;
      }

      set({ connectionState: ConnectionState.Connected });

      await syncLocalMicrophone(room);
      if (connectionAttempt !== attempt || get().room !== room) {
        await room.disconnect().catch(() => null);
        return;
      }

      syncParticipant(room.localParticipant);
      realtime().joinVoice(channelId);
      for (const participant of room.remoteParticipants.values()) {
        syncParticipant(participant);
        for (const publication of participant.trackPublications.values()) {
          syncSubscription(publication, participant.identity);
        }
      }
    },

    watchStream(identity) {
      set((s) => ({ watchedStreams: new Set(s.watchedStreams).add(identity) }));
      syncStreamSubscriptions(identity);
    },

    stopWatchingStream(identity) {
      set((s) => {
        const watchedStreams = new Set(s.watchedStreams);
        watchedStreams.delete(identity);
        return { watchedStreams };
      });
      syncStreamSubscriptions(identity);
    },

    async leave() {
      connectionAttempt++;

      const { room, channelId } = get();
      resetRoom();

      if (!room) return;

      room.removeAllListeners();
      await room.disconnect().catch(() => null);
      await stopAudioSession();
      if (channelId) realtime().leaveVoice();
      play('leave', switchingChannel);
    },

    async setMuted(muted) {
      set({ selfMuted: muted });
      play(muted ? 'mute' : 'unmute');
      void Haptics.selectionAsync();

      const { room } = get();
      if (!room) return;

      await syncLocalMicrophone(room);

      // keep the local participant in sync
      syncParticipant(room.localParticipant);
    },

    async setDeafened(deafened) {
      // deafening also mutes
      set((s) => ({
        selfDeafened: deafened,
        mutedBeforeDeafen: deafened ? s.selfMuted : s.mutedBeforeDeafen,
        selfMuted: deafened ? true : s.mutedBeforeDeafen,
      }));
      play(deafened ? 'deafen' : 'undeafen');
      void Haptics.selectionAsync();

      const { room } = get();
      if (!room) return;

      for (const identity of room.remoteParticipants.keys()) updateParticipantAudio(identity);
      await syncLocalMicrophone(room);

      syncParticipant(room.localParticipant);
    },

    async setAudioLoopbackTesting(testing) {
      if (get().audioLoopbackTesting === testing) return;
      set({ audioLoopbackTesting: testing });

      if (!testing) {
        const track = get().audioLoopbackTrack;
        set({ audioLoopbackTrack: null });
        track?.stop();
        return;
      }

      try {
        const track = await createLocalAudioTrack(microphoneCaptureOptions());
        get().audioLoopbackTrack?.stop();
        if (get().audioLoopbackTesting) set({ audioLoopbackTrack: track });
        else track.stop();
      } catch (error) {
        console.error('could not start microphone test', error);
        set({ audioLoopbackTesting: false });
        throw error;
      }
    },

    participantVolume: (identity) => get().participantAudio[identity]?.volume ?? 1,
    participantMuted: (identity) => get().participantAudio[identity]?.muted ?? false,
    participantScreenVolume: (identity) => get().participantAudio[identity]?.screenVolume ?? 1,

    setParticipantVolume: (identity, volume) =>
      setParticipantAudio(identity, { volume: clampVolume(volume) }),
    setParticipantMuted: (identity, muted) => setParticipantAudio(identity, { muted }),
    setParticipantScreenVolume: (identity, volume) =>
      setParticipantAudio(identity, { screenVolume: clampVolume(volume) }),

    async setCamera(enabled) {
      const room = get().room;
      if (!room) return;

      try {
        await room.localParticipant.setCameraEnabled(enabled, { facingMode: get().cameraFacing });
        play(enabled ? 'camera' : 'cameraOff');
      } catch {
        play('cameraOff');
      }

      // sets `selfCamera` from the actual track
      syncParticipant(room.localParticipant);
    },

    async setScreenShare(enabled) {
      const room = get().room;
      if (!room || Platform.OS === 'ios') return;

      try {
        // starts the MediaProjection foreground service and shows the system capture prompt
        await room.localParticipant.setScreenShareEnabled(enabled);
      } catch (error) {
        // the prompt was dismissed or the user denied the capture
        console.error('could not change screen share', error);
      }

      // sets `selfScreenShare` and plays the sound from the actual track
      syncParticipant(room.localParticipant);
    },

    async setCameraFacing(facing) {
      const previous = get().cameraFacing;
      set({ cameraFacing: facing });

      const room = get().room;
      const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (!room || !(track instanceof LocalVideoTrack)) return;

      try {
        await track.restartTrack({ facingMode: facing });
        syncParticipant(room.localParticipant);
      } catch (error) {
        set({ cameraFacing: previous });
        console.error('could not change camera', error);
        throw error;
      }
    },

    async setAudioOutput(output) {
      const previous = get().audioOutput;
      set({ audioOutput: output });

      // before a call there is no audio session to route yet; join applies it
      if (!get().room) return;

      try {
        await AudioSession.selectAudioOutput(toRoute(output));
      } catch (error) {
        set({ audioOutput: previous });
        console.error('could not change audio output', error);
        throw error;
      }
    },

    async setNoiseCancellation(enabled) {
      settings().update({ noiseCancellation: enabled });
      await applyCaptureSettings();
    },

    async setEchoCancellation(enabled) {
      settings().update({ voiceEchoCancellation: enabled });
      await applyCaptureSettings();
    },

    async setAutoGainControl(enabled) {
      settings().update({ voiceAutoGainControl: enabled });
      await applyCaptureSettings();
    },
  };
});

useVoice.subscribe((s) => setInCall(s.channelId !== null));

// Same name as on the web, for code that runs outside React: `voice().join(channelId)`
export const voice = useVoice.getState;

// `$derived` fields of the web class: `const connected = useVoice(selectConnected)`
export const selectConnected = (s: VoiceStore) => s.connectionState === ConnectionState.Connected;
export const selectConnecting = (s: VoiceStore) => s.connectionState === ConnectionState.Connecting;
export const selectParticipantCount = (s: VoiceStore) => s.voiceStates.size;
export const selectLocalIdentity = (s: VoiceStore) => s.room?.localParticipant.identity ?? null;

// join a DM call, and ring the other side when nobody is in it yet
export function startCall(channelId: string) {
  const ring = !chat().voiceStates[channelId]?.length;
  void voice()
    .join(channelId)
    .then(() => {
      if (ring && voice().channelId === channelId) realtime().ringCall(channelId);
    })
    .catch(() => null);
}
