import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';

let wasmBinary: Promise<ArrayBuffer> | undefined;
const loadedContexts = new WeakMap<AudioContext, Promise<void>>();

export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'rnnoise';
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private node?: RnnoiseWorkletNode;
  private mono?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private context?: AudioContext;
  private ownsContext = false;

  async init({ track, audioContext }: AudioProcessorOptions) {
    // livekit omits audioContext on processor restart, so keep our own
    const context = (this.context ??= audioContext ?? new AudioContext());
    this.ownsContext ||= !audioContext;
    let worklet = loadedContexts.get(context);
    if (!worklet) {
      worklet = context.audioWorklet.addModule(rnnoiseWorkletUrl);
      loadedContexts.set(context, worklet);
    }

    await Promise.all([context.resume(), worklet]);
    this.source = context.createMediaStreamSource(new MediaStream([track]));
    this.node = new RnnoiseWorkletNode(context, {
      maxChannels: 1,
      wasmBinary: await (wasmBinary ??= loadRnnoise({
        url: rnnoiseWasmUrl,
        simdUrl: rnnoiseSimdWasmUrl,
      })),
    });
    this.mono = new GainNode(audioContext, {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    this.destination = audioContext.createMediaStreamDestination();
    this.source.connect(this.node).connect(this.mono).connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.destroy();
    this.mono?.disconnect();
    this.destination?.disconnect();
    this.processedTrack?.stop();
    if (this.ownsContext) this.context?.close();
    this.source = undefined;
    this.node = undefined;
    this.mono = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
    this.context = undefined;
    this.ownsContext = false;
  }
}
