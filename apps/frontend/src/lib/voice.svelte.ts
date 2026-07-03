import { ConnectionState, Participant, Room, RoomEvent, Track } from 'livekit-client';
import { anchor } from './anchor.svelte';
import { SvelteMap } from 'svelte/reactivity';

const livekitConnectionTimeoutMs = 15_000;

export class Voice {
  room = $state<Room | null>(null);
  channelId = $state<string | null>(null);
  connectionState = $state<ConnectionState>(ConnectionState.Disconnected);
  private connectionAttempt = 0;

  selfMuted = $state<boolean>(false);
  selfDeafened = $state<boolean>(false);

  voiceStates = new SvelteMap<string, VoiceState>();

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

    await this.leave();

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
    this.syncParticipant(room.localParticipant, channelId);
    for (const participant of room.remoteParticipants.values()) {
      this.syncParticipant(participant, channelId);
    }

    if (this.selfMuted) {
      await room.localParticipant.setMicrophoneEnabled(false);
    }
    if (this.selfDeafened) {
      await room.localParticipant.setMicrophoneEnabled(false);
    }
  }

  async leave() {
    this.connectionAttempt++;

    const room = this.room;
    this.room = null;
    this.channelId = null;
    this.connectionState = ConnectionState.Disconnected;
    this.voiceStates.clear();

    if (!room) return;

    await room.disconnect().catch(() => null);
  }

  async setMuted(muted: boolean) {
    this.selfMuted = muted;
    if (!this.room) return;

    await this.room.localParticipant.setMicrophoneEnabled(!muted);

    // keep the local participant in sync
    this.syncParticipant(this.room.localParticipant, this.channelId!);
  }

  async setDeafened(deafened: boolean) {
    this.selfDeafened = deafened;

    // deafening also mutes
    if (deafened) {
      this.selfMuted = true;
    }

    if (!this.room) return;

    if (deafened) {
      await this.room.localParticipant.setMicrophoneEnabled(false);
    }

    this.syncParticipant(this.room.localParticipant, this.channelId!);
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
        this.voiceStates.clear();
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.voiceStates.delete(participant.identity);
      })
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        this.syncParticipant(participant, channelId);
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
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
