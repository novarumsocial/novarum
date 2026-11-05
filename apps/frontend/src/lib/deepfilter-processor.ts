import { DeepFilterNet3Core } from 'deepfilternet3-noise-filter';
import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { settings } from './settings.svelte';
import { autoAttenuation, rmsDb } from './noise-floor';

// shared so the ~24MB of wasm + model is only downloaded and compiled once
const core = new DeepFilterNet3Core({ assetConfig: { cdnUrl: 'https://dfn3.srizan.dev' } });

let appliedLevel: number | undefined;
export const deepFilterLevel = () => appliedLevel;
export const setDeepFilterLevel = (level: number) => {
  if (level === appliedLevel) return;
  appliedLevel = level;
  core.setSuppressionLevel(level);
};

export class DeepFilterProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  name = 'deepfilternet3';
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private meter?: ReturnType<typeof setInterval>;

  async init({ track }: AudioProcessorOptions) {
    await core.initialize();
    // the model only runs at 48kHz, so it can't share livekit's context
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.context = context;
    // resume() stays pending while autoplay is blocked, so retry on the next click instead of waiting
    void context.resume().catch(() => undefined);
    document.addEventListener('pointerdown', () => void context.resume(), { once: true });

    const node = await core.createAudioWorkletNode(context);
    appliedLevel = undefined;
    setDeepFilterLevel(settings.value.noiseSuppressionLevel);
    const destination = context.createMediaStreamDestination();
    this.source = context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(node).connect(destination);

    // ~8s of 100ms levels from the raw mic, used to pick the strength in auto mode
    const analyser = new AnalyserNode(context, { fftSize: 4096 });
    this.source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levels: number[] = [];
    this.meter = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      levels.push(rmsDb(samples));
      if (levels.length > 80) levels.shift();
      if (settings.value.noiseSuppressionAuto && levels.length >= 10)
        setDeepFilterLevel(autoAttenuation(levels));
    }, 100);
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    clearInterval(this.meter);
    this.source?.disconnect();
    this.processedTrack?.stop();
    await this.context?.close();
    this.source = undefined;
    this.processedTrack = undefined;
    this.context = undefined;
  }
}
