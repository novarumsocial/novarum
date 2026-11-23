// The call's audio, done by Novarum rather than LiveKit's platform audio: the web runs the mic
// through the browser's echo cancellation and then an RNNoise or DeepFilterNet3 worklet
// (voice.svelte.ts's `noiseProcessor`), and plays each participant at their own volume. Here cpal
// captures the mic, WebRTC's audio processing module cancels echo against what's being played,
// the chosen model denoises, and the result feeds LiveKit; remote tracks are mixed back out to
// the speakers with per-track gain.
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
    time::Duration,
};

use cpal::{
    FromSample, SizedSample, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use futures::StreamExt;
use livekit::webrtc::{
    audio_source::{AudioSourceOptions, native::NativeAudioSource},
    audio_stream::native::NativeAudioStream,
    native::apm::AudioProcessingModule,
    prelude::{AudioFrame, RtcAudioTrack},
};

use crate::util::noise_floor::{auto_attenuation, rms_db};

const RATE: u32 = 48_000;
/// 10 ms at 48 kHz, what WebRTC, RNNoise and DeepFilterNet all work in
const FRAME: usize = 480;
/// how far a remote track may run ahead of the speakers before its oldest audio is dropped
const MAX_REMOTE_BUFFER: usize = RATE as usize / 5 * 2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseModel {
    Rnnoise,
    DeepFilter,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Processing {
    pub echo_cancellation: bool,
    pub auto_gain_control: bool,
    /// `None` leaves the mic undenoised
    pub noise: Option<NoiseModel>,
    /// DeepFilterNet's attenuation limit in dB; `None` picks it from the room's noise floor
    pub noise_level: Option<f32>,
}

/// One remote track being played: its audio, stereo interleaved at 48 kHz, and its volume.
struct Remote {
    buffer: Mutex<VecDeque<f32>>,
    gain: AtomicU32,
}

#[derive(Default)]
struct Shared {
    muted: AtomicBool,
    deafened: AtomicBool,
    remotes: Mutex<HashMap<String, Arc<Remote>>>,
    /// raw mic at 48 kHz, for the processing thread
    capture: Mutex<VecDeque<f32>>,
    /// what the speakers played, mono at 48 kHz, as the echo canceller's reference
    reverse: Mutex<VecDeque<f32>>,
    processing: Mutex<Option<Processing>>,
}

pub struct AudioEngine {
    shared: Arc<Shared>,
    source: NativeAudioSource,
    streams: Option<Streams>,
    wake: mpsc::Sender<()>,
    stop: Arc<AtomicBool>,
    remote_tasks: HashMap<String, tokio::task::JoinHandle<()>>,
}

impl AudioEngine {
    pub fn new(input: &str, output: &str, processing: Processing) -> Self {
        let shared = Arc::new(Shared::default());
        *shared.processing.lock().unwrap() = Some(processing);
        // the APM below does the processing; the source just carries the frames
        let source = NativeAudioSource::new(
            AudioSourceOptions {
                echo_cancellation: false,
                noise_suppression: false,
                auto_gain_control: false,
            },
            RATE,
            1,
            100,
        );
        let (wake, woken) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (shared, source, stop) = (shared.clone(), source.clone(), stop.clone());
            std::thread::Builder::new()
                .name("novarum-mic".into())
                .spawn(move || process_mic(&shared, &source, &stop, woken))
                .expect("mic thread");
        }
        let mut engine = Self {
            shared,
            source,
            streams: None,
            wake,
            stop,
            remote_tasks: HashMap::new(),
        };
        engine.set_devices(input, output);
        engine
    }

    pub fn source(&self) -> NativeAudioSource {
        self.source.clone()
    }

    /// Reopens the mic and speakers, e.g. when the chosen devices change.
    pub fn set_devices(&mut self, input: &str, output: &str) {
        self.streams = None;
        match Streams::open(input, output, &self.shared, self.wake.clone()) {
            Ok(streams) => self.streams = Some(streams),
            Err(error) => eprintln!("Could not open the call's audio devices: {error}"),
        }
    }

    pub fn set_processing(&self, processing: Processing) {
        *self.shared.processing.lock().unwrap() = Some(processing);
    }

    pub fn set_muted(&self, muted: bool) {
        self.shared.muted.store(muted, Ordering::Relaxed);
    }

    pub fn set_deafened(&self, deafened: bool) {
        self.shared.deafened.store(deafened, Ordering::Relaxed);
    }

    /// Starts playing a subscribed remote track, keyed by its sid.
    pub fn add_remote(&mut self, key: &str, track: RtcAudioTrack, gain: f32) {
        let remote = Arc::new(Remote {
            buffer: Mutex::new(VecDeque::new()),
            gain: AtomicU32::new(gain.to_bits()),
        });
        self.shared
            .remotes
            .lock()
            .unwrap()
            .insert(key.to_string(), remote.clone());
        let task = tokio::spawn(async move {
            let mut stream = NativeAudioStream::new(track, RATE as i32, 2);
            while let Some(frame) = stream.next().await {
                let mut buffer = remote.buffer.lock().unwrap();
                buffer.extend(frame.data.iter().map(|sample| *sample as f32 / 32768.0));
                let excess = buffer.len().saturating_sub(MAX_REMOTE_BUFFER);
                buffer.drain(..excess);
            }
        });
        if let Some(old) = self.remote_tasks.insert(key.to_string(), task) {
            old.abort();
        }
    }

    pub fn remove_remote(&mut self, key: &str) {
        self.shared.remotes.lock().unwrap().remove(key);
        if let Some(task) = self.remote_tasks.remove(key) {
            task.abort();
        }
    }

    /// 1.0 plays a track as is, 0.0 silences it, up to 3.0 boosts it.
    pub fn set_gain(&self, key: &str, gain: f32) {
        if let Some(remote) = self.shared.remotes.lock().unwrap().get(key) {
            remote.gain.store(gain.to_bits(), Ordering::Relaxed);
        }
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.wake.send(());
        for task in self.remote_tasks.values() {
            task.abort();
        }
    }
}

/// The mic chain, 10 ms at a time: echo cancellation and gain control, then the noise model.
fn process_mic(
    shared: &Shared,
    source: &NativeAudioSource,
    stop: &AtomicBool,
    woken: mpsc::Receiver<()>,
) {
    let mut applied: Option<Processing> = None;
    let mut apm: Option<AudioProcessingModule> = None;
    let mut denoiser: Option<Denoiser> = None;
    let mut levels: VecDeque<f32> = VecDeque::new();
    let mut frame = [0f32; FRAME];
    let mut reverse = [0i16; FRAME];
    let mut pcm = [0i16; FRAME];
    while !stop.load(Ordering::Relaxed) {
        let _ = woken.recv_timeout(Duration::from_millis(50));
        let wanted = shared.processing.lock().unwrap().clone();
        if wanted != applied {
            if let Some(wanted) = &wanted {
                let rebuild_apm = applied.as_ref().is_none_or(|applied| {
                    (applied.echo_cancellation, applied.auto_gain_control)
                        != (wanted.echo_cancellation, wanted.auto_gain_control)
                });
                if rebuild_apm {
                    apm = Some(AudioProcessingModule::new(
                        wanted.echo_cancellation,
                        wanted.auto_gain_control,
                        true,
                        false,
                    ));
                }
                if applied.as_ref().and_then(|applied| applied.noise) != wanted.noise {
                    denoiser = wanted.noise.map(Denoiser::new);
                }
            }
            applied = wanted;
        }
        let Some(processing) = &applied else {
            continue;
        };

        loop {
            {
                let mut capture = shared.capture.lock().unwrap();
                if capture.len() < FRAME {
                    break;
                }
                for (slot, sample) in frame.iter_mut().zip(capture.drain(..FRAME)) {
                    *slot = sample;
                }
            }
            if let Some(apm) = &mut apm {
                // the speakers' output since the last frame, so the canceller knows what to remove
                let mut played = shared.reverse.lock().unwrap();
                while played.len() >= FRAME {
                    for (slot, sample) in reverse.iter_mut().zip(played.drain(..FRAME)) {
                        *slot = to_i16(sample);
                    }
                    let _ = apm.process_reverse_stream(&mut reverse, RATE as i32, 1);
                }
                drop(played);
                for (slot, sample) in pcm.iter_mut().zip(frame) {
                    *slot = to_i16(sample);
                }
                let _ = apm.process_stream(&mut pcm, RATE as i32, 1);
                for (slot, sample) in frame.iter_mut().zip(pcm) {
                    *slot = sample as f32 / 32768.0;
                }
            }

            // the web's auto strength: ~8 s of the room's level picks how hard to suppress
            levels.push_back(rms_db(&frame));
            if levels.len() > 800 {
                levels.pop_front();
            }
            if let Some(denoiser) = &mut denoiser {
                let level = processing.noise_level.unwrap_or_else(|| {
                    let recent: Vec<f32> = levels.iter().step_by(10).copied().collect();
                    if recent.len() >= 10 {
                        auto_attenuation(&recent)
                    } else {
                        30.0
                    }
                });
                denoiser.process(&mut frame, level);
            }

            if shared.muted.load(Ordering::Relaxed) {
                frame.fill(0.0);
            }
            let data: Vec<i16> = frame.iter().map(|sample| to_i16(*sample)).collect();
            let audio = AudioFrame {
                data: data.into(),
                sample_rate: RATE,
                num_channels: 1,
                samples_per_channel: FRAME as u32,
            };
            let _ = futures::executor::block_on(source.capture_frame(&audio));
        }
    }
}

fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

enum Denoiser {
    Rnnoise(Box<nnnoiseless::DenoiseState<'static>>),
    DeepFilter(Box<deep_filter_rt::tract::DfTract>),
}

impl Denoiser {
    fn new(model: NoiseModel) -> Self {
        match model {
            NoiseModel::Rnnoise => Self::Rnnoise(nnnoiseless::DenoiseState::new()),
            NoiseModel::DeepFilter => Self::DeepFilter(Box::default()),
        }
    }

    fn process(&mut self, frame: &mut [f32; FRAME], level: f32) {
        match self {
            Self::Rnnoise(state) => {
                // RNNoise works in 16-bit sample units
                let input: Vec<f32> = frame.iter().map(|sample| sample * 32768.0).collect();
                let mut output = [0f32; FRAME];
                state.process_frame(&mut output, &input);
                for (slot, sample) in frame.iter_mut().zip(output) {
                    *slot = sample / 32768.0;
                }
            }
            Self::DeepFilter(df) => {
                df.set_atten_lim(level);
                let noisy = ndarray::ArrayView2::from_shape((1, FRAME), &frame[..]).unwrap();
                let mut enhanced = ndarray::Array2::<f32>::zeros((1, FRAME));
                if df.process(noisy, enhanced.view_mut()).is_ok() {
                    for (slot, sample) in frame.iter_mut().zip(enhanced.iter()) {
                        *slot = *sample;
                    }
                }
            }
        }
    }
}

fn find_device(name: &str, input: bool) -> Option<cpal::Device> {
    let host = cpal::default_host();
    let default = || {
        if input {
            host.default_input_device()
        } else {
            host.default_output_device()
        }
    };
    let devices = if input {
        host.input_devices().ok()
    } else {
        host.output_devices().ok()
    };
    devices
        .and_then(|mut devices| {
            devices.find(|device| device.name().is_ok_and(|device_name| device_name == name))
        })
        .or_else(default)
}

/// 48 kHz if the device offers it, so nothing needs resampling; otherwise its default.
fn pick_config(device: &cpal::Device, input: bool) -> Result<SupportedStreamConfig, String> {
    let configs: Vec<_> = if input {
        device
            .supported_input_configs()
            .map_err(|error| error.to_string())?
            .collect()
    } else {
        device
            .supported_output_configs()
            .map_err(|error| error.to_string())?
            .collect()
    };
    let native = configs.into_iter().find(|config| {
        config.min_sample_rate().0 <= RATE
            && config.max_sample_rate().0 >= RATE
            && matches!(
                config.sample_format(),
                cpal::SampleFormat::F32 | cpal::SampleFormat::I16
            )
    });
    match native {
        Some(config) => Ok(config.with_sample_rate(cpal::SampleRate(RATE))),
        None if input => device.default_input_config().map_err(|e| e.to_string()),
        None => device.default_output_config().map_err(|e| e.to_string()),
    }
}

/// Linear interpolation from one rate to another, a frame of `N` channels at a time.
struct Resample<const N: usize> {
    step: f64,
    phase: f64,
    previous: [f32; N],
}

impl<const N: usize> Resample<N> {
    fn new(from: u32, to: u32) -> Self {
        Self {
            step: from as f64 / to as f64,
            phase: 0.0,
            previous: [0.0; N],
        }
    }

    /// Feeds one input frame, calling `out` with each output frame it completes.
    fn push(&mut self, frame: [f32; N], mut out: impl FnMut([f32; N])) {
        while self.phase < 1.0 {
            let t = self.phase as f32;
            out(std::array::from_fn(|channel| {
                self.previous[channel] + (frame[channel] - self.previous[channel]) * t
            }));
            self.phase += self.step;
        }
        self.phase -= 1.0;
        self.previous = frame;
    }
}

struct Streams {
    _input: cpal::Stream,
    _output: cpal::Stream,
}

impl Streams {
    fn open(
        input: &str,
        output: &str,
        shared: &Arc<Shared>,
        wake: mpsc::Sender<()>,
    ) -> Result<Self, String> {
        let microphone = find_device(input, true).ok_or("No microphone was found")?;
        let speakers = find_device(output, false).ok_or("No speakers were found")?;
        let input_config = pick_config(&microphone, true)?;
        let output_config = pick_config(&speakers, false)?;
        let input = match input_config.sample_format() {
            cpal::SampleFormat::F32 => {
                capture::<f32>(&microphone, &input_config, shared.clone(), wake)
            }
            cpal::SampleFormat::I16 => {
                capture::<i16>(&microphone, &input_config, shared.clone(), wake)
            }
            format => Err(format!("Unsupported mic format {format:?}")),
        }?;
        let output = match output_config.sample_format() {
            cpal::SampleFormat::F32 => playback::<f32>(&speakers, &output_config, shared.clone()),
            cpal::SampleFormat::I16 => playback::<i16>(&speakers, &output_config, shared.clone()),
            format => Err(format!("Unsupported speaker format {format:?}")),
        }?;
        input.play().map_err(|error| error.to_string())?;
        output.play().map_err(|error| error.to_string())?;
        Ok(Self {
            _input: input,
            _output: output,
        })
    }
}

fn capture<T>(
    device: &cpal::Device,
    config: &SupportedStreamConfig,
    shared: Arc<Shared>,
    wake: mpsc::Sender<()>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels().max(1) as usize;
    let mut resample = Resample::<1>::new(config.sample_rate().0, RATE);
    device
        .build_input_stream::<T, _, _>(
            &config.config(),
            move |data, _| {
                let mut capture = shared.capture.lock().unwrap();
                for frame in data.chunks(channels) {
                    let mono =
                        frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32;
                    resample.push([mono], |[sample]| capture.push_back(sample));
                }
                // never let the mic fall more than a fifth of a second behind
                let excess = capture.len().saturating_sub(RATE as usize / 5);
                capture.drain(..excess);
                drop(capture);
                let _ = wake.send(());
            },
            |error| eprintln!("Call mic failed: {error}"),
            None,
        )
        .map_err(|error| error.to_string())
}

fn playback<T>(
    device: &cpal::Device,
    config: &SupportedStreamConfig,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels().max(1) as usize;
    let device_rate = config.sample_rate().0;
    let mut resample = Resample::<2>::new(RATE, device_rate);
    let mut pending: VecDeque<[f32; 2]> = VecDeque::new();
    device
        .build_output_stream::<T, _, _>(
            &config.config(),
            move |data: &mut [T], _| {
                let frames = data.len() / channels;
                let deafened = shared.deafened.load(Ordering::Relaxed);
                let remotes: Vec<Arc<Remote>> =
                    shared.remotes.lock().unwrap().values().cloned().collect();
                let mut played = Vec::new();
                // mix 48 kHz frames until there's enough for the device, resampled
                while pending.len() < frames {
                    let mut mixed = [0f32; 2];
                    if !deafened {
                        for remote in &remotes {
                            let gain = f32::from_bits(remote.gain.load(Ordering::Relaxed));
                            let mut buffer = remote.buffer.lock().unwrap();
                            if buffer.len() >= 2 {
                                mixed[0] += buffer.pop_front().unwrap() * gain;
                                mixed[1] += buffer.pop_front().unwrap() * gain;
                            }
                        }
                    }
                    let mixed = mixed.map(|sample| sample.clamp(-1.0, 1.0));
                    played.push((mixed[0] + mixed[1]) / 2.0);
                    resample.push(mixed, |frame| pending.push_back(frame));
                }
                for (frame, [l, r]) in data.chunks_mut(channels).zip(pending.drain(..frames)) {
                    match frame {
                        [mono] => *mono = T::from_sample((l + r) / 2.0),
                        [a, b, rest @ ..] => {
                            *a = T::from_sample(l);
                            *b = T::from_sample(r);
                            rest.fill(T::from_sample((l + r) / 2.0));
                        }
                        [] => {}
                    }
                }
                let mut reverse = shared.reverse.lock().unwrap();
                reverse.extend(played);
                let excess = reverse.len().saturating_sub(RATE as usize / 5);
                reverse.drain(..excess);
            },
            |error| eprintln!("Call speakers failed: {error}"),
            None,
        )
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::Resample;

    #[test]
    fn resampling_keeps_the_rate_ratio() {
        let mut up = Resample::<1>::new(24_000, 48_000);
        let mut out = Vec::new();
        for _ in 0..4 {
            up.push([1.0], |[s]| out.push(s));
        }
        assert_eq!(out.len(), 8);

        let mut down = Resample::<2>::new(96_000, 48_000);
        let mut out = Vec::new();
        for frame in [[1.0, -1.0]; 4] {
            down.push(frame, |f| out.push(f));
        }
        assert_eq!(out.len(), 2);
    }
}
