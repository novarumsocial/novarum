import { ConnectionState, Participant, Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteTrack } from 'livekit-client';
import { anchor } from './anchor.svelte';
import { SvelteMap } from 'svelte/reactivity';
import { Sound } from 'svelte-sound';
import JoinEffect from './sounds/join.opus?url';
import Leave from './sounds/leave.opus?url';
import Mute from './sounds/mute.opus?url';
import Deafen from './sounds/deafen.opus?url';
import MuteReverse from './sounds/mute-reverse.opus?url';
import DeafenReverse from './sounds/deafen-reverse.opus?url';

const livekitConnectionTimeoutMs = 15_000;

const joinSound = new Sound(JoinEffect);
const leaveSound = new Sound(Leave);
const muteSound = new Sound(Mute);
const deafenSound = new Sound(Deafen);
const muteReverseSound = new Sound(MuteReverse);
const deafenReverseSound = new Sound(DeafenReverse);

export class Voice {
  room = $state<Room | null>(null);
  channelId = $state<string | null>(null);
  connectionState = $state<ConnectionState>(ConnectionState.Disconnected);
  private connectionAttempt = 0;

  selfMuted = $state<boolean>(false);
  selfDeafened = $state<boolean>(false);
  audioPlaybackBlocked = $state<boolean>(false);

  voiceStates = new SvelteMap<string, VoiceState>();
  private remoteAudioElements = new Map<RemoteTrack, HTMLMediaElement>();

  connected = $derived(this.connectionState === ConnectionState.Connected);
  connecting = $derived(this.connectionState === ConnectionState.Connecting);

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

    const room = new Room();
    this.room = room;
    this.bindRoomEvents(room, channelId);

    const connectPromise = room.connect(data.serverUrl, data.token);
    connectPromise.catch(() => null);

    try {
      await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Voice connection timed out')), livekitConnectionTimeoutMs);
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
    for (const participant of room.remoteParticipants.values()) {
      this.syncParticipant(participant, channelId);
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) this.attachRemoteAudio(publication.track);
      }
    }
  }

  async leave() {
    this.connectionAttempt++;

    const room = this.room;
    this.room = null;
    this.channelId = null;
    this.connectionState = ConnectionState.Disconnected;
    this.audioPlaybackBlocked = false;
    this.voiceStates.clear();
    this.detachRemoteAudio();

    if (!room) return;

    await room.disconnect().catch(() => null);
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
      this.selfMuted = true;
    } else {
      deafenReverseSound.play();
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

  private async syncLocalMicrophone(room: Room) {
    const enabled = !this.selfMuted && !this.selfDeafened;

    try {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    } catch {
      if (this.room === room && enabled) {
        this.selfMuted = true;
      }
    }
  }

  private bindRoomEvents(room: Room, channelId: string) {
    room
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        this.connectionState = state;
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return;

        this.room = null;
        this.channelId = null;
        this.connectionState = ConnectionState.Disconnected;
        this.audioPlaybackBlocked = false;
        this.voiceStates.clear();
        this.detachRemoteAudio();
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
        muteSound.play();
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
        this.syncParticipant(participant, channelId);
        muteReverseSound.play();
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        this.attachRemoteAudio(track);
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        this.detachRemoteAudio(track);
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

    this.voiceStates.set(participant.identity, {
      userId: participant.identity,
      channelId,
      selfMuted: micMuted,
      selfDeafened: isLocal ? this.selfDeafened : false,
      serverMuted: false,
      camera: !!cameraPub && !cameraPub.isMuted,
      screenShare: !!screenPub && !screenPub.isMuted,
      speaking: participant.isSpeaking,
    });
  }

  private attachRemoteAudio(track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio) return;
    if (this.remoteAudioElements.has(track)) return;

    const element = track.attach();
    element.autoplay = true;
    element.muted = this.selfDeafened;
    element.style.display = 'none';
    document.body.appendChild(element);
    this.remoteAudioElements.set(track, element);
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
  screenShare: boolean;
  speaking: boolean;
}
