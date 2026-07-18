import { ConnectionState, Participant, Room, RoomEvent, Track, TrackEvent } from 'livekit-client';
import { LocalAudioTrack, type RemoteTrack } from 'livekit-client';
import { anchor } from './anchor.svelte';
import { realtime } from './realtime.svelte';
import { SvelteMap } from 'svelte/reactivity';
import { Sound } from 'svelte-sound';
import { DeepFilterNoiseFilterProcessor } from 'deepfilternet3-noise-filter';
import JoinEffect from './sounds/join.opus?url';
import Leave from './sounds/leave.opus?url';
import Mute from './sounds/mute.opus?url';
import Deafen from './sounds/deafen.opus?url';
import MuteReverse from './sounds/mute-reverse.opus?url';
import DeafenReverse from './sounds/deafen-reverse.opus?url';
import Camera from './sounds/camera.opus?url';
import CameraOff from './sounds/camera-off.opus?url';
import Screen from './sounds/screen.opus?url';
import ScreenOff from './sounds/screen-off.opus?url';

const livekitConnectionTimeoutMs = 15_000;

const joinSound = new Sound(JoinEffect);
const leaveSound = new Sound(Leave);
const muteSound = new Sound(Mute);
const deafenSound = new Sound(Deafen);
const muteReverseSound = new Sound(MuteReverse);
const deafenReverseSound = new Sound(DeafenReverse);
const cameraSound = new Sound(Camera);
const cameraOffSound = new Sound(CameraOff);
const screenSound = new Sound(Screen);
const screenOffSound = new Sound(ScreenOff);

export class Voice {
  room = $state<Room | null>(null);
  channelId = $state<string | null>(null);
  connectionState = $state<ConnectionState>(ConnectionState.Disconnected);
  private connectionAttempt = 0;

  selfMuted = $state<boolean>(false);
  mutedBeforeDeafen = $state<boolean>(false);
  selfDeafened = $state<boolean>(false);
  selfCamera = $state<boolean>(false);
  selfScreenShare = $state<boolean>(false);
  audioPlaybackBlocked = $state<boolean>(false);

  voiceStates = new SvelteMap<string, VoiceState>();
  private participantAudio = new SvelteMap<string, { volume: number; muted: boolean }>();
  private remoteAudioElements = new Map<RemoteTrack, HTMLMediaElement>();
  private endedTrackListeners = new WeakSet<VoiceVideoTrack>();

  connected = $derived(this.connectionState === ConnectionState.Connected);
  connecting = $derived(this.connectionState === ConnectionState.Connecting);

  noiseCancellationEnabled = $state<boolean>(true);
  private noiseProcessor: DeepFilterNoiseFilterProcessor | null = null;
  private processedMicTrack: LocalAudioTrack | null = null;
  private noiseProcessorOperation: Promise<void> = Promise.resolve();

  get participantCount() {
    return this.voiceStates.size;
  }

  get localIdentity(): string | null {
    return this.room?.localParticipant.identity ?? null;
  }

  async join(channelId: string) {
    if (this.channelId === channelId && (this.connected || this.connecting)) return;

    if (this.room) {
      if (this.channelId === channelId) return;
      await this.leave();
      leaveSound.play();
    }

    joinSound.play();
    const connectionAttempt = ++this.connectionAttempt;
    this.channelId = channelId;
    this.connectionState = ConnectionState.Connecting;

    const { data, error } = await anchor.client.channel({ id: channelId }).call.token.get();
    if (this.connectionAttempt !== connectionAttempt) return;

    if (error) {
      this.connectionState = ConnectionState.Disconnected;
      throw error;
    }

    const room = new Room({ webAudioMix: true });
    this.room = room;
    this.bindRoomEvents(room, channelId);

    const connectPromise = room.connect(data.serverUrl, data.token);
    connectPromise.catch(() => null);

    try {
      await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('Voice connection timed out')),
            livekitConnectionTimeoutMs
          );
        }),
      ]);
    } catch (error) {
      if (this.connectionAttempt !== connectionAttempt || this.room !== room) return;

      this.room = null;
      this.channelId = null;
      this.connectionState = ConnectionState.Disconnected;
      throw error;
    }

    if (this.connectionAttempt !== connectionAttempt || this.room !== room) {
      await room.disconnect().catch(() => null);
      return;
    }

    this.connectionState = ConnectionState.Connected;
    this.audioPlaybackBlocked = !room.canPlaybackAudio;

    await this.syncLocalMicrophone(room);
    if (this.connectionAttempt !== connectionAttempt || this.room !== room) {
      await room.disconnect().catch(() => null);
      return;
    }

    this.syncParticipant(room.localParticipant, channelId);
    realtime.joinVoice(channelId);
    for (const participant of room.remoteParticipants.values()) {
      this.syncParticipant(participant, channelId);
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) this.attachRemoteAudio(publication.track, participant.identity);
      }
    }
  }

  async leave() {
    this.connectionAttempt++;

    const room = this.room;
    const channelId = this.channelId;
    await this.removeNoiseCancellation();
    this.room = null;
    this.channelId = null;
    this.connectionState = ConnectionState.Disconnected;
    this.audioPlaybackBlocked = false;
    this.selfCamera = false;
    this.selfScreenShare = false;
    this.voiceStates.clear();
    this.detachRemoteAudio();

    if (!room) return;

    await room.disconnect().catch(() => null);
    if (channelId) realtime.leaveVoice();
    leaveSound.play();
  }

  async setMuted(muted: boolean) {
    this.selfMuted = muted;
    if (muted) {
      muteSound.play();
    } else {
      muteReverseSound.play();
    }

    if (!this.room) return;

    await this.syncLocalMicrophone(this.room);

    // keep the local participant in sync
    this.syncParticipant(this.room.localParticipant, this.channelId!);
  }

  async setDeafened(deafened: boolean) {
    this.selfDeafened = deafened;
    this.updateRemoteAudioMuted();

    // deafening also mutes
    if (deafened) {
      deafenSound.play();
      this.mutedBeforeDeafen = this.selfMuted;
      this.selfMuted = true;
    } else {
      deafenReverseSound.play();
      this.selfMuted = this.mutedBeforeDeafen;
    }

    if (!this.room) return;

    await this.syncLocalMicrophone(this.room);

    this.syncParticipant(this.room.localParticipant, this.channelId!);
  }

  async startAudio() {
    if (!this.room) return;

    await this.room.startAudio();
    this.audioPlaybackBlocked = !this.room.canPlaybackAudio;
  }

  participantVolume(identity: string) {
    return this.participantAudio.get(identity)?.volume ?? 1;
  }

  participantMuted(identity: string) {
    return this.participantAudio.get(identity)?.muted ?? false;
  }

  setParticipantVolume(identity: string, volume: number) {
    this.participantAudio.set(identity, {
      volume: Math.max(0, Math.min(3, volume)),
      muted: this.participantMuted(identity),
    });
    this.updateParticipantAudio(identity);
  }

  setParticipantMuted(identity: string, muted: boolean) {
    this.participantAudio.set(identity, { volume: this.participantVolume(identity), muted });
    this.updateParticipantAudio(identity);
  }

  async setCamera(enabled: boolean) {
    if (!this.room) return;

    try {
      await this.room.localParticipant.setCameraEnabled(enabled);
      this.selfCamera = enabled;
      if (enabled) {
        cameraSound.play();
      } else {
        cameraOffSound.play();
      }
    } catch {
      cameraOffSound.play();
      this.selfCamera = false;
    }

    this.syncParticipant(this.room.localParticipant, this.channelId!);
  }

  async setScreenShare(enabled: boolean) {
    if (!this.room) return;

    try {
      await this.room.localParticipant.setScreenShareEnabled(enabled, { audio: true });
      this.selfScreenShare = enabled;
      if (enabled) {
        screenSound.play();
      } else {
        screenOffSound.play();
      }
    } catch {
      screenOffSound.play();
      this.selfScreenShare = false;
    }

    this.syncParticipant(this.room.localParticipant, this.channelId!);
  }

  private async syncLocalMicrophone(room: Room) {
    const enabled = !this.selfMuted && !this.selfDeafened;

    try {
      await room.localParticipant.setMicrophoneEnabled(enabled, {
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: false,
        channelCount: 1,
        sampleRate: 48000,
      });
    } catch {
      if (this.room === room && enabled) {
        this.selfMuted = true;
      }
      return;
    }

    if (enabled && this.noiseCancellationEnabled) await this.setNoiseCancellation(true);
  }

  private async ensureNoiseCancellation(room: Room) {
    if (this.room !== room || !this.noiseCancellationEnabled) return;

    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);

    // funny livekit doing strange typing stuff
    const track = publication?.track as LocalAudioTrack | undefined;

    // don't ask, 5.6 sol asked me to do that
    if (!(track instanceof LocalAudioTrack)) throw new Error('Local microphone track is unavailable');

    if (this.processedMicTrack === track && this.noiseProcessor) {
      await this.noiseProcessor.setEnabled(true);
      return;
    }

    // remove any previous noise cancellation from previous tracks
    await this.removeNoiseCancellation();

    if (this.room !== room || !this.noiseCancellationEnabled) return;

    const processor = new DeepFilterNoiseFilterProcessor({
      sampleRate: 48_000,
      noiseReductionLevel: 60,
      enabled: true,
      assetConfig: {
        cdnUrl: 'https://dfn3.srizan.dev',
      }
    });

    try {
      await track.setProcessor(processor);

      if (this.room !== room || !this.noiseCancellationEnabled) {
        await track.stopProcessor().catch(() => undefined);
        return;
      }

      this.noiseProcessor = processor;
      this.processedMicTrack = track;
    } catch (error) {
      processor.setEnabled(false);
      throw error;
    }
  }

  async setNoiseCancellation(enabled: boolean) {
    this.noiseCancellationEnabled = enabled;

    const room = this.room;
    if (!room) return;

    // queuing the operation to avoid race conditions :3333
    this.noiseProcessorOperation = this.noiseProcessorOperation
      .catch(() => undefined)
      .then(async () => {
        if (this.room !== room) return;

        if (enabled) {
          await this.ensureNoiseCancellation(room);
        } else {
          await this.removeNoiseCancellation();
        }
      });

    try {
      await this.noiseProcessorOperation;
    } catch (error) {
      console.error('could not change noise cancellation', error);

      if (enabled) {
        this.noiseCancellationEnabled = false;
        await this.removeNoiseCancellation();
      }
    }
  }

  private async removeNoiseCancellation() {
    const track = this.processedMicTrack;

    this.noiseProcessor?.setEnabled(false);
    this.noiseProcessor = null;
    this.processedMicTrack = null;

    if (track) {
      // idk why we are catching but copilot does its thing i guess
      await track.stopProcessor().catch(() => undefined);
    }
  }

  private bindRoomEvents(room: Room, channelId: string) {
    room
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        this.connectionState = state;
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return;

        this.noiseProcessor?.setEnabled(false);
        this.noiseProcessor = null;
        this.processedMicTrack = null;

        this.room = null;
        this.channelId = null;
        this.connectionState = ConnectionState.Disconnected;
        this.audioPlaybackBlocked = false;
        this.selfCamera = false;
        this.selfScreenShare = false;
        this.voiceStates.clear();
        this.detachRemoteAudio();
        realtime.leaveVoice();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.audioPlaybackBlocked = !room.canPlaybackAudio;
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        this.syncParticipant(participant, channelId);
        joinSound.play();
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.voiceStates.delete(participant.identity);
        leaveSound.play();
      })
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.TrackUnpublished, (publication, participant) => {
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.LocalTrackUnpublished, (publication, participant) => {
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        this.attachRemoteAudio(track, participant.identity);
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        this.detachRemoteAudio(track);
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const speakingSet = new Set(speakers.map((s) => s.identity));
        for (const [identity, state] of this.voiceStates) {
          state.speaking = speakingSet.has(identity);
          this.voiceStates.set(identity, { ...state });
        }
      });
  }

  private syncParticipant(participant: Participant, channelId: string) {
    const micPub = participant.getTrackPublication(Track.Source.Microphone);
    const screenPub = participant.getTrackPublication(Track.Source.ScreenShare);
    const cameraPub = participant.getTrackPublication(Track.Source.Camera);

    const isLocal = participant.isLocal;
    const micMuted = isLocal ? this.selfMuted : !micPub || micPub.isMuted;
    const cameraTrack = this.activeVideoTrack(cameraPub?.isMuted, cameraPub?.track);
    const screenTrack = this.activeVideoTrack(screenPub?.isMuted, screenPub?.track);

    if (screenTrack) {
      this.syncWhenTrackEnds(screenTrack, participant, channelId);
    }

    if (isLocal) {
      this.selfCamera = !!cameraTrack;
      this.selfScreenShare = !!screenTrack;
    }

    if (isLocal && micMuted && !this.selfMuted) {
      muteSound.play();
    }
    if (isLocal && !micMuted && this.selfMuted) {
      muteReverseSound.play();
    }

    if (isLocal && cameraTrack && !this.selfCamera) {
      cameraSound.play();
    }
    if (isLocal && !cameraTrack && this.selfCamera) {
      cameraOffSound.play();
    }

    if (isLocal && screenTrack && !this.selfScreenShare) {
      screenSound.play();
    }
    if (isLocal && !screenTrack && this.selfScreenShare) {
      screenOffSound.play();
    }

    this.voiceStates.set(participant.identity, {
      userId: participant.identity,
      channelId,
      selfMuted: micMuted,
      selfDeafened: isLocal ? this.selfDeafened : false,
      serverMuted: false,
      camera: !!cameraTrack,
      cameraTrack,
      screenShare: !!screenTrack,
      screenTrack,
      speaking: participant.isSpeaking,
    });
  }

  private activeVideoTrack(isMuted: boolean | undefined, track: unknown): VoiceVideoTrack | null {
    if (
      isMuted ||
      !(track && typeof track === 'object') ||
      (track as { kind?: Track.Kind }).kind !== Track.Kind.Video
    ) {
      return null;
    }

    const videoTrack = track as VoiceVideoTrack;
    return videoTrack.mediaStreamTrack?.readyState === 'ended' ? null : videoTrack;
  }

  private syncWhenTrackEnds(track: VoiceVideoTrack, participant: Participant, channelId: string) {
    if (!track.on || this.endedTrackListeners.has(track)) return;

    this.endedTrackListeners.add(track);
    track.on(TrackEvent.Ended, () => {
      if (this.channelId !== channelId) return;

      this.syncParticipant(participant, channelId);
    });
  }

  private attachRemoteAudio(track: RemoteTrack, identity: string) {
    if (track.kind !== Track.Kind.Audio) return;
    if (this.remoteAudioElements.has(track)) return;

    const element = track.attach();
    element.autoplay = true;
    element.muted = this.selfDeafened;
    element.style.display = 'none';
    document.body.appendChild(element);
    this.remoteAudioElements.set(track, element);
    this.updateParticipantAudio(identity);
  }

  private updateParticipantAudio(identity: string) {
    this.room?.remoteParticipants
      .get(identity)
      ?.setVolume(this.participantMuted(identity) ? 0 : this.participantVolume(identity));
  }

  private detachRemoteAudio(track?: RemoteTrack) {
    const elements = track ? track.detach() : [...this.remoteAudioElements.values()];

    for (const element of elements) {
      element.remove();
    }

    if (track) this.remoteAudioElements.delete(track);
    else this.remoteAudioElements.clear();
  }

  private updateRemoteAudioMuted() {
    for (const element of this.remoteAudioElements.values()) {
      element.muted = this.selfDeafened;
    }
  }
}

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

export type VoiceVideoTrack = {
  kind?: Track.Kind;
  mediaStreamTrack?: MediaStreamTrack;
  on?(event: TrackEvent.Ended, callback: () => void): void;
  attach(element?: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): HTMLMediaElement[];
};
