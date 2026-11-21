/**
 * Joining calls, playing audio and hearing people. Needs `@livekit/rtc-node`.
 * @module @novarum/sdk/voice
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteTrack,
} from '@livekit/rtc-node';
import type { Client } from '../client.js';
import type { REST } from '../rest.js';

/** Every PCM stream here is signed 16-bit little endian, 48kHz, stereo, like discord.js/voice. */
export const sampleRate = 48_000;
export const channels = 2;
const samplesPerFrame = sampleRate / 50;
const bytesPerFrame = samplesPerFrame * channels * 2;

export enum StreamType {
  /** anything ffmpeg can read: a file path, a URL or a stream of mp3, ogg, wav… */
  Arbitrary = 'arbitrary',
  /** already s16le 48kHz stereo PCM: played as is */
  Raw = 'raw',
}

export interface AudioResourceOptions<T> {
  inputType?: StreamType;
  metadata?: T;
}

/** Something an `AudioPlayer` can play. Make one with `createAudioResource`. */
export class AudioResource<T = unknown> {
  /** 1 is unchanged, 0 is silent, 2 is twice as loud */
  volume = 1;
  /** milliseconds played so far */
  playbackDuration = 0;

  constructor(
    readonly stream: Readable,
    readonly metadata: T,
    private process?: ChildProcess
  ) {}

  destroy() {
    this.stream.destroy();
    this.process?.kill();
  }
}

/** Turns a file path, URL or stream into PCM, through ffmpeg unless it's already `StreamType.Raw`. */
export function createAudioResource<T = undefined>(
  input: string | Readable,
  options: AudioResourceOptions<T> = {}
) {
  const metadata = options.metadata as T;
  if (options.inputType === StreamType.Raw) {
    return new AudioResource(typeof input === 'string' ? createReadStream(input) : input, metadata);
  }
  const fromFile = typeof input === 'string';
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-i',
      fromFile ? input : 'pipe:0',
      '-f',
      's16le',
      '-ar',
      `${sampleRate}`,
      '-ac',
      `${channels}`,
      'pipe:1',
    ],
    { stdio: [fromFile ? 'ignore' : 'pipe', 'pipe', 'inherit'] }
  );
  if (!fromFile) {
    // ffmpeg closing its stdin early (it was stopped) is not an error worth crashing over
    ffmpeg.stdin!.on('error', () => {});
    input.pipe(ffmpeg.stdin!);
  }
  return new AudioResource(ffmpeg.stdout!, metadata, ffmpeg);
}

export enum AudioPlayerStatus {
  Idle = 'idle',
  Playing = 'playing',
  Paused = 'paused',
}

export interface AudioPlayerEvents {
  stateChange: [oldStatus: AudioPlayerStatus, newStatus: AudioPlayerStatus];
  idle: [];
  playing: [];
  paused: [];
  error: [error: Error, resource: AudioResource];
}

/** Plays one resource at a time into every connection subscribed to it. */
export class AudioPlayer extends EventEmitter<AudioPlayerEvents> {
  status = AudioPlayerStatus.Idle;
  resource: AudioResource | null = null;
  readonly connections = new Set<VoiceConnection>();
  #resume: (() => void) | null = null;

  /** Stops whatever is playing and plays this instead. */
  play(resource: AudioResource) {
    this.resource?.destroy();
    this.resource = resource;
    this.#resume?.();
    this.#setStatus(AudioPlayerStatus.Playing);
    this.#pump(resource)
      .catch((error: Error) => {
        if (this.resource === resource) this.emit('error', error, resource);
      })
      .finally(() => {
        if (this.resource !== resource) return;
        this.resource = null;
        this.#setStatus(AudioPlayerStatus.Idle);
      });
  }

  pause() {
    if (this.status !== AudioPlayerStatus.Playing) return false;
    for (const connection of this.connections) connection.source.clearQueue();
    this.#setStatus(AudioPlayerStatus.Paused);
    return true;
  }

  unpause() {
    if (this.status !== AudioPlayerStatus.Paused) return false;
    this.#setStatus(AudioPlayerStatus.Playing);
    this.#resume?.();
    return true;
  }

  stop() {
    if (!this.resource) return false;
    const resource = this.resource;
    this.resource = null;
    resource.destroy();
    for (const connection of this.connections) connection.source.clearQueue();
    this.#resume?.();
    this.#setStatus(AudioPlayerStatus.Idle);
    return true;
  }

  #setStatus(status: AudioPlayerStatus) {
    if (status === this.status) return;
    const old = this.status;
    this.status = status;
    this.emit('stateChange', old, status);
    this.emit(status);
  }

  async #pump(resource: AudioResource) {
    let pending = Buffer.alloc(0);
    for await (const chunk of resource.stream) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      while (pending.length >= bytesPerFrame) {
        if (this.status === AudioPlayerStatus.Paused) {
          await new Promise<void>((resolve) => (this.#resume = resolve));
        }
        if (this.resource !== resource) return;
        await this.#send(pending.subarray(0, bytesPerFrame), resource.volume);
        pending = pending.subarray(bytesPerFrame);
        resource.playbackDuration += 20;
      }
    }
    for (const connection of this.connections) await connection.source.waitForPlayout();
  }

  async #send(pcm: Buffer, volume: number) {
    // nobody listening: keep the clock running so playback doesn't race ahead
    if (this.connections.size === 0) return new Promise((resolve) => setTimeout(resolve, 20));
    const samples = new Int16Array(samplesPerFrame * channels);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.max(-32768, Math.min(32767, pcm.readInt16LE(i * 2) * volume));
    }
    const frame = new AudioFrame(samples, sampleRate, channels, samplesPerFrame);
    await Promise.all([...this.connections].map((c) => c.source.captureFrame(frame)));
  }
}

export const createAudioPlayer = () => new AudioPlayer();

export interface VoiceReceiverEvents {
  speakingStart: [userId: string];
  speakingEnd: [userId: string];
}

/** Hears the other people in the call. */
export class VoiceReceiver extends EventEmitter<VoiceReceiverEvents> {
  readonly speaking = new Set<string>();
  readonly #tracks = new Map<string, RemoteTrack>();
  readonly #waiting = new EventEmitter<Record<string, [RemoteTrack]>>();

  constructor(room: Room) {
    super();
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      this.#tracks.set(participant.identity, track);
      this.#waiting.emit(participant.identity, track);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (this.#tracks.get(participant.identity) === track)
        this.#tracks.delete(participant.identity);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const now = new Set(speakers.map((speaker) => speaker.identity));
      now.delete(room.localParticipant?.identity ?? '');
      for (const userId of this.speaking) if (!now.has(userId)) this.emit('speakingEnd', userId);
      for (const userId of now) if (!this.speaking.has(userId)) this.emit('speakingStart', userId);
      this.speaking.clear();
      for (const userId of now) this.speaking.add(userId);
    });
  }

  /** The PCM a user sends, from the moment they start sending it until their audio goes away. */
  subscribe(userId: string) {
    const tracks = this.#tracks;
    const waiting = this.#waiting;
    return Readable.from(
      (async function* () {
        const track =
          tracks.get(userId) ??
          (await new Promise<RemoteTrack>((resolve) => waiting.once(userId, resolve)));
        for await (const frame of new AudioStream(track, { sampleRate, numChannels: channels })) {
          yield Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        }
      })()
    );
  }
}

export enum VoiceConnectionStatus {
  Connecting = 'connecting',
  Ready = 'ready',
  Disconnected = 'disconnected',
  Destroyed = 'destroyed',
}

export interface VoiceConnectionEvents {
  stateChange: [oldStatus: VoiceConnectionStatus, newStatus: VoiceConnectionStatus];
  ready: [];
  disconnected: [];
  destroyed: [];
  error: [error: Error];
}

// one connection per bot and channel; keyed by REST so several bots can share a process
const registry = new WeakMap<REST, Map<string, VoiceConnection>>();
const connectionsOf = (rest: REST) => {
  if (!registry.has(rest)) registry.set(rest, new Map());
  return registry.get(rest)!;
};

/** The bot in one call. Make one with `joinVoiceChannel`. */
export class VoiceConnection extends EventEmitter<VoiceConnectionEvents> {
  status = VoiceConnectionStatus.Connecting;
  readonly room = new Room();
  readonly receiver = new VoiceReceiver(this.room);
  /** where the subscribed player's audio goes */
  readonly source = new AudioSource(sampleRate, channels, 100);
  #player: AudioPlayer | null = null;

  constructor(
    readonly channelId: string,
    private rest: REST
  ) {
    super();
    this.room.on(RoomEvent.Disconnected, () => this.#setStatus(VoiceConnectionStatus.Disconnected));
    this.room.on(RoomEvent.Reconnected, () => this.#setStatus(VoiceConnectionStatus.Ready));
  }

  /** @internal */
  async connect() {
    const { serverUrl, token } = await this.rest.get<{ serverUrl: string; token: string }>(
      `/channel/${encodeURIComponent(this.channelId)}/call/token`
    );
    await this.room.connect(serverUrl, token, { autoSubscribe: true, dynacast: false });
    const track = LocalAudioTrack.createAudioTrack('audio', this.source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(track, options);
    this.#setStatus(VoiceConnectionStatus.Ready);
  }

  /** Plays the player's audio in this call, replacing the player it had before. */
  subscribe(player: AudioPlayer) {
    this.#player?.connections.delete(this);
    this.#player = player;
    player.connections.add(this);
    return {
      unsubscribe: () => {
        if (this.#player !== player) return;
        player.connections.delete(this);
        this.#player = null;
      },
    };
  }

  /** Leaves the call. */
  async destroy() {
    if (this.status === VoiceConnectionStatus.Destroyed) return;
    this.#player?.connections.delete(this);
    this.#player = null;
    const connections = connectionsOf(this.rest);
    if (connections.get(this.channelId) === this) connections.delete(this.channelId);
    this.#setStatus(VoiceConnectionStatus.Destroyed);
    await this.room.disconnect();
    await this.source.close();
  }

  #setStatus(status: VoiceConnectionStatus) {
    if (status === this.status || this.status === VoiceConnectionStatus.Destroyed) return;
    const old = this.status;
    this.status = status;
    this.emit('stateChange', old, status);
    this.emit(status);
  }
}

/**
 * Joins the call of a voice channel or DM and resolves once the bot is in it.
 *
 * ```ts
 * const connection = await joinVoiceChannel(client, channelId);
 * const player = createAudioPlayer();
 * connection.subscribe(player);
 * player.play(createAudioResource('song.mp3'));
 * ```
 */
export async function joinVoiceChannel(client: Client | REST, channelId: string) {
  const rest = 'rest' in client ? client.rest : client;
  const connections = connectionsOf(rest);
  const existing = connections.get(channelId);
  if (existing) return existing;
  const connection = new VoiceConnection(channelId, rest);
  connections.set(channelId, connection);
  try {
    await connection.connect();
  } catch (error) {
    await connection.destroy();
    throw error;
  }
  return connection;
}

/** The connection the bot has to a channel's call, if it's in it. */
export const getVoiceConnection = (client: Client | REST, channelId: string) =>
  connectionsOf('rest' in client ? client.rest : client).get(channelId);
