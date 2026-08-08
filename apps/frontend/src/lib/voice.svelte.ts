import {
  ConnectionState,
  createLocalAudioTrack,
  Participant,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
} from 'livekit-client';
import { LocalAudioTrack, type RemoteTrack } from 'livekit-client';
import { anchor } from './anchor.svelte';
import { realtime } from './realtime.svelte';
import { SvelteMap } from 'svelte/reactivity';
import { Sound } from 'svelte-sound';

// sounds
import JoinEffect from './sounds/join.opus?url';
import Leave from './sounds/leave.opus?url';
import Mute from './sounds/mute.opus?url';
import Unmute from './sounds/mute-reverse.opus?url';
import Deafen from './sounds/deafen.opus?url';
import Undeafen from './sounds/deafen-reverse.opus?url';
import Camera from './sounds/camera.opus?url';
import CameraOff from './sounds/camera-off.opus?url';
import Screen from './sounds/screen.opus?url';
import ScreenOff from './sounds/screen-off.opus?url';

// guille: no freedesktop? :(

import { settings } from './settings.svelte';
import { RnnoiseProcessor } from './rnnoise-processor';

const livekitConnectionTimeoutMs = 15_000;
const microphoneCaptureOptions = () => ({
  echoCancellation: settings.value.voiceEchoCancellation,
  autoGainControl: settings.value.voiceAutoGainControl,
  noiseSuppression: false,
  channelCount: 1,
  sampleRate: 48000,
  deviceId: settings.value.voiceInputDeviceId,
});

const joinSound = new Sound(JoinEffect);
const leaveSound = new Sound(Leave);
const muteSound = new Sound(Mute);
const deafenSound = new Sound(Deafen);
const unmuteSound = new Sound(Unmute);
const undeafenSound = new Sound(Undeafen);
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

  noiseCancellationEnabled = $state<boolean>(settings.value.noiseCancellation);
  audioLoopbackTesting = $state(false);
  audioLoopbackStream = $state<MediaStream | null>(null);
  private noiseProcessorTrack: LocalAudioTrack | null = null;
  private noiseCancellationOperation: Promise<void> = Promise.resolve();
  private captureSettingsOperation: Promise<void> = Promise.resolve();
  private audioLoopbackTrack: LocalAudioTrack | null = null;
  private audioLoopbackElement: HTMLMediaElement | null = null;
  private audioLoopbackContext: AudioContext | null = null;
  private audioLoopbackDeafenedBefore = false;
  private audioLoopbackOperation: Promise<void> = Promise.resolve();

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

    const room = new Room({
      webAudioMix: true,
      audioCaptureDefaults: microphoneCaptureOptions(),
      audioOutput: { deviceId: settings.value.voiceOutputDeviceId },
    });
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
    await this.setAudioLoopbackTesting(false);
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
      unmuteSound.play();
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
      undeafenSound.play();
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

  async setAudioLoopbackTesting(testing: boolean) {
    if (this.audioLoopbackTesting === testing) return this.audioLoopbackOperation;

    this.audioLoopbackTesting = testing;
    this.audioLoopbackOperation = this.audioLoopbackOperation
      .catch(() => undefined)
      .then(() =>
        this.audioLoopbackTesting ? this.startAudioLoopback() : this.stopAudioLoopback()
      );

    return this.audioLoopbackOperation;
  }

  private async startAudioLoopback() {
    const room = this.room;
    if (!room) {
      this.audioLoopbackTesting = false;
      return;
    }

    this.audioLoopbackDeafenedBefore = this.selfDeafened;
    if (!this.selfDeafened) await this.setDeafened(true);

    try {
      await this.removeNoiseCancellation();
      const track = await createLocalAudioTrack(microphoneCaptureOptions());
      this.audioLoopbackTrack = track;
      this.audioLoopbackStream = new MediaStream([track.mediaStreamTrack]);

      if (this.noiseCancellationEnabled) {
        const audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        this.audioLoopbackContext = audioContext;
        track.setAudioContext(audioContext);
        await track.setProcessor(new RnnoiseProcessor());
      }

      if (!this.audioLoopbackTesting || this.room !== room) {
        await this.stopAudioLoopback();
        return;
      }

      const element = document.createElement('audio');
      element.autoplay = true;
      element.srcObject = new MediaStream([track.mediaStreamTrack]);
      element.style.display = 'none';
      document.body.appendChild(element);
      this.audioLoopbackElement = element;
      await this.setElementOutputDevice(element, settings.value.voiceOutputDeviceId);
      await element.play();
    } catch (error) {
      console.error('could not start microphone test', error);
      this.audioLoopbackTesting = false;
      await this.stopAudioLoopback();
      throw error;
    }
  }

  private async stopAudioLoopback() {
    const track = this.audioLoopbackTrack;
    const audioContext = this.audioLoopbackContext;
    this.audioLoopbackTrack = null;
    this.audioLoopbackStream = null;
    this.audioLoopbackContext = null;
    if (this.audioLoopbackElement) {
      this.audioLoopbackElement.srcObject = null;
      this.audioLoopbackElement.remove();
    }
    this.audioLoopbackElement = null;

    if (track) {
      await track.stopProcessor().catch(() => undefined);
      track.stop();
    }
    await audioContext?.close().catch(() => undefined);

    if (!this.audioLoopbackDeafenedBefore && this.selfDeafened) await this.setDeafened(false);
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
      await room.localParticipant.setMicrophoneEnabled(enabled, microphoneCaptureOptions());
    } catch {
      if (this.room === room && enabled) {
        this.selfMuted = true;
      }
      return;
    }

    if (enabled && this.noiseCancellationEnabled) await this.ensureNoiseCancellation(room);
  }

  private async ensureNoiseCancellation(room: Room) {
    if (this.room !== room || !this.noiseCancellationEnabled) return;

    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as
      | LocalAudioTrack
      | undefined;
    if (!(track instanceof LocalAudioTrack)) return;
    if (this.noiseProcessorTrack === track) return;

    await this.removeNoiseCancellation();
    if (this.room !== room || !this.noiseCancellationEnabled) return;

    await track.setProcessor(new RnnoiseProcessor());
    this.noiseProcessorTrack = track;
  }

  async setNoiseCancellation(enabled: boolean) {
    const previous = this.noiseCancellationEnabled;
    settings.value.noiseCancellation = enabled;
    this.noiseCancellationEnabled = enabled;

    const room = this.room;
    if (!room) return;

    this.noiseCancellationOperation = this.noiseCancellationOperation
      .catch(() => undefined)
      .then(() =>
        enabled && !this.selfMuted && !this.selfDeafened
          ? this.ensureNoiseCancellation(room)
          : this.removeNoiseCancellation()
      );

    try {
      await this.noiseCancellationOperation;
    } catch (error) {
      console.error('could not change noise cancellation', error);
      settings.value.noiseCancellation = previous;
      this.noiseCancellationEnabled = previous;
    }
  }

  async setEchoCancellation(enabled: boolean) {
    settings.value.voiceEchoCancellation = enabled;
    await this.applyCaptureSettings();
  }

  async setAutoGainControl(enabled: boolean) {
    settings.value.voiceAutoGainControl = enabled;
    await this.applyCaptureSettings();
  }

  async setInputDevice(deviceId: string) {
    const previous = settings.value.voiceInputDeviceId;
    settings.value.voiceInputDeviceId = deviceId;

    try {
      if (this.room) {
        await this.room.switchActiveDevice('audioinput', deviceId, deviceId !== 'default');
      }
      if (this.audioLoopbackTrack) {
        await this.audioLoopbackTrack.restartTrack(microphoneCaptureOptions());
        if (this.audioLoopbackElement) {
          this.audioLoopbackElement.srcObject = new MediaStream([
            this.audioLoopbackTrack.mediaStreamTrack,
          ]);
          await this.audioLoopbackElement.play();
        }
      }
    } catch (error) {
      settings.value.voiceInputDeviceId = previous;
      console.error('could not change microphone', error);
      throw error;
    }
  }

  async setOutputDevice(deviceId: string) {
    const previous = settings.value.voiceOutputDeviceId;
    settings.value.voiceOutputDeviceId = deviceId;

    try {
      if (this.room) await this.room.switchActiveDevice('audiooutput', deviceId);
      if (this.audioLoopbackElement) {
        await this.setElementOutputDevice(this.audioLoopbackElement, deviceId);
      }
    } catch (error) {
      settings.value.voiceOutputDeviceId = previous;
      console.error('could not change audio output', error);
      throw error;
    }
  }

  private async applyCaptureSettings() {
    const room = this.room;
    if (!room || this.selfMuted || this.selfDeafened) return;

    this.captureSettingsOperation = this.captureSettingsOperation
      .catch(() => undefined)
      .then(async () => {
        const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as
          | LocalAudioTrack
          | undefined;
        if (this.room !== room || !(track instanceof LocalAudioTrack)) return;

        await this.removeNoiseCancellation();
        await track.restartTrack(microphoneCaptureOptions());
        if (this.noiseCancellationEnabled) await this.ensureNoiseCancellation(room);
      });

    try {
      await this.captureSettingsOperation;
    } catch (error) {
      console.error('could not apply microphone settings', error);
    }
  }

  private async removeNoiseCancellation() {
    const track = this.noiseProcessorTrack;
    this.noiseProcessorTrack = null;
    await track?.stopProcessor().catch(() => undefined);
  }

  private async setElementOutputDevice(element: HTMLMediaElement, deviceId: string) {
    if ('setSinkId' in element) {
      await element.setSinkId(deviceId);
    }
  }

  private bindRoomEvents(room: Room, channelId: string) {
    room
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        this.connectionState = state;
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return;

        void this.setAudioLoopbackTesting(false);
        void this.removeNoiseCancellation();
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
      unmuteSound.play();
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
    if (this.selfDeafened) return;
    if (this.remoteAudioElements.has(track)) return;

    const element = track.attach();
    element.autoplay = true;
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
    const tracks = track ? [track] : [...this.remoteAudioElements.keys()];

    for (const remoteTrack of tracks) {
      for (const element of remoteTrack.detach()) element.remove();
      this.remoteAudioElements.delete(remoteTrack);
    }
  }

  private updateRemoteAudioMuted() {
    if (this.selfDeafened) {
      this.detachRemoteAudio();
      return;
    }

    for (const participant of this.room?.remoteParticipants.values() ?? []) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) this.attachRemoteAudio(publication.track, participant.identity);
      }
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
