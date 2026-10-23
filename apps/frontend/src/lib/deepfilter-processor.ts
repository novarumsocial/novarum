import { DeepFilterNet3Core } from 'deepfilternet3-noise-filter';
import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';

// shared so the ~24MB of wasm + model is only downloaded and compiled once
const core = new DeepFilterNet3Core({
  noiseReductionLevel: 80,
  assetConfig: { cdnUrl: 'https://dfn3.srizan.dev' },
});

export class DeepFilterProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  name = 'deepfilternet3';
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;

  async init({ track }: AudioProcessorOptions) {
    // the model only runs at 48kHz, so it can't share livekit's context
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.context = context;
    // resume() stays pending while autoplay is blocked, so retry on the next click instead of waiting
    void context.resume().catch(() => undefined);
    document.addEventListener('pointerdown', () => void context.resume(), { once: true });

    await core.initialize();
    const node = await core.createAudioWorkletNode(context);
    const destination = context.createMediaStreamDestination();
    this.source = context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(node).connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    this.source?.disconnect();
    this.processedTrack?.stop();
    await this.context?.close();
    this.source = undefined;
    this.processedTrack = undefined;
    this.context = undefined;
  }
}
