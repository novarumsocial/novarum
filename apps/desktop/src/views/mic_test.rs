// Port of apps/frontend/src/lib/components/mic-test.svelte. The web routes the processed mic back
// through `voice.setAudioLoopbackTesting`; here cpal captures the chosen microphone and plays it on
// the chosen speakers, feeding the level meter on the way.
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use cpal::{
    FromSample, SizedSample, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};

use crate::prelude::*;
use crate::{
    state::settings::SettingsStore,
    views::mic_level_meter::{level_from_samples, mic_level_meter},
};

/// `navigator.mediaDevices.enumerateDevices()` for audio, by name (cpal has no stable ids).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioDevices {
    pub input: Vec<String>,
    pub output: Vec<String>,
}

/// Lists the devices, without the `default` alias the selects already offer.
pub fn audio_devices() -> AudioDevices {
    let host = cpal::default_host();
    let names = |devices: Option<Vec<cpal::Device>>| -> Vec<String> {
        let mut names: Vec<String> = devices
            .unwrap_or_default()
            .iter()
            .filter_map(|device| device.name().ok())
            .filter(|name| name != "default")
            .collect();
        names.dedup();
        names
    };
    AudioDevices {
        input: names(host.input_devices().ok().map(Iterator::collect)),
        output: names(host.output_devices().ok().map(Iterator::collect)),
    }
}

fn find_device(name: &str, input: bool) -> Option<cpal::Device> {
    let host = cpal::default_host();
    let default = || if input { host.default_input_device() } else { host.default_output_device() };
    if name == "default" {
        return default();
    }
    let mut devices = if input { host.input_devices().ok()? } else { host.output_devices().ok()? };
    devices.find(|device| device.name().is_ok_and(|device_name| device_name == name)).or_else(default)
}

/// Plays a buffer recorded at one rate at another, holding the last sample when it runs dry.
pub struct Resampler {
    ratio: f32,
    phase: f32,
    last: f32,
}

impl Resampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
        Self { ratio: input_rate as f32 / output_rate as f32, phase: 0.0, last: 0.0 }
    }

    pub fn next(&mut self, buffer: &mut VecDeque<f32>) -> f32 {
        self.phase += self.ratio;
        while self.phase >= 1.0 {
            self.phase -= 1.0;
            if let Some(sample) = buffer.pop_front() {
                self.last = sample;
            }
        }
        self.last
    }
}

type Shared = Arc<Mutex<VecDeque<f32>>>;

fn input_stream<T>(
    device: &cpal::Device,
    config: &SupportedStreamConfig,
    buffer: Shared,
    level: Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels().max(1) as usize;
    // a fifth of a second is the most the loopback lags behind
    let limit = config.sample_rate().0 as usize / 5;
    device
        .build_input_stream::<T, _, _>(
            &config.config(),
            move |data, _| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| frame.iter().map(|sample| sample.to_sample::<f32>()).sum::<f32>() / channels as f32)
                    .collect();
                level.store(level_from_samples(&mono).to_bits(), Ordering::Relaxed);
                if let Ok(mut buffer) = buffer.lock() {
                    buffer.extend(mono);
                    let excess = buffer.len().saturating_sub(limit);
                    buffer.drain(..excess);
                }
            },
            |error| eprintln!("Mic test input failed: {error}"),
            None,
        )
        .map_err(|error| error.to_string())
}

fn output_stream<T>(
    device: &cpal::Device,
    config: &SupportedStreamConfig,
    buffer: Shared,
    input_rate: u32,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels().max(1) as usize;
    let mut resampler = Resampler::new(input_rate, config.sample_rate().0);
    device
        .build_output_stream::<T, _, _>(
            &config.config(),
            move |data: &mut [T], _| {
                let Ok(mut buffer) = buffer.lock() else { return };
                for frame in data.chunks_mut(channels) {
                    let sample = T::from_sample(resampler.next(&mut buffer));
                    frame.fill(sample);
                }
            },
            |error| eprintln!("Mic test output failed: {error}"),
            None,
        )
        .map_err(|error| error.to_string())
}

struct Loopback {
    _input: cpal::Stream,
    _output: cpal::Stream,
}

impl Loopback {
    fn start(input: &str, output: &str, level: Arc<AtomicU32>) -> Result<Self, String> {
        let microphone = find_device(input, true).ok_or("No microphone was found.")?;
        let speakers = find_device(output, false).ok_or("No output device was found.")?;
        let input_config = microphone.default_input_config().map_err(|error| error.to_string())?;
        let output_config = speakers.default_output_config().map_err(|error| error.to_string())?;
        let buffer: Shared = Arc::default();
        let unsupported = |format| format!("Unsupported sample format {format:?}");

        let input = match input_config.sample_format() {
            cpal::SampleFormat::F32 => input_stream::<f32>(&microphone, &input_config, buffer.clone(), level),
            cpal::SampleFormat::I16 => input_stream::<i16>(&microphone, &input_config, buffer.clone(), level),
            cpal::SampleFormat::U16 => input_stream::<u16>(&microphone, &input_config, buffer.clone(), level),
            cpal::SampleFormat::I32 => input_stream::<i32>(&microphone, &input_config, buffer.clone(), level),
            format => Err(unsupported(format)),
        }?;
        let rate = input_config.sample_rate().0;
        let output = match output_config.sample_format() {
            cpal::SampleFormat::F32 => output_stream::<f32>(&speakers, &output_config, buffer, rate),
            cpal::SampleFormat::I16 => output_stream::<i16>(&speakers, &output_config, buffer, rate),
            cpal::SampleFormat::U16 => output_stream::<u16>(&speakers, &output_config, buffer, rate),
            cpal::SampleFormat::I32 => output_stream::<i32>(&speakers, &output_config, buffer, rate),
            format => Err(unsupported(format)),
        }?;
        input.play().map_err(|error| error.to_string())?;
        output.play().map_err(|error| error.to_string())?;
        Ok(Self { _input: input, _output: output })
    }
}

pub struct MicTest {
    loopback: Option<Loopback>,
    pending: bool,
    error: Option<String>,
    level: Arc<AtomicU32>,
    _poll: Option<Task<()>>,
}

impl MicTest {
    pub fn new() -> Self {
        Self { loopback: None, pending: false, error: None, level: Arc::default(), _poll: None }
    }

    /// `voice.audioLoopbackTesting`
    pub fn testing(&self) -> bool {
        self.loopback.is_some()
    }

    fn toggle(&mut self, cx: &mut Context<Self>) {
        self.error = None;
        if self.loopback.take().is_some() {
            self._poll = None;
            self.level.store(0, Ordering::Relaxed);
            cx.notify();
            return;
        }
        self.pending = true;
        cx.notify();
        let settings = SettingsStore::get(cx);
        match Loopback::start(&settings.voice_input_device_id, &settings.voice_output_device_id, self.level.clone()) {
            Ok(loopback) => {
                self.loopback = Some(loopback);
                // the meter redraws like the web's requestAnimationFrame loop
                self._poll = Some(cx.spawn(async move |this, cx| {
                    loop {
                        cx.background_executor().timer(Duration::from_millis(33)).await;
                        if this.update(cx, |_, cx| cx.notify()).is_err() {
                            break;
                        }
                    }
                }));
            }
            Err(error) => self.error = Some(error),
        }
        self.pending = false;
        cx.notify();
    }
}

impl Render for MicTest {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let testing = self.testing();
        let level = if testing { f32::from_bits(self.level.load(Ordering::Relaxed)) } else { 0.0 };
        let label = match (self.pending, testing) {
            (true, true) => "Starting...",
            (true, false) => "Stopping...",
            (false, true) => "Stop test",
            (false, false) => "Start test",
        };
        div()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        Button::new("mic-test")
                            .flex_1()
                            .small()
                            .when(testing, |button| button.secondary())
                            .when(!testing, |button| button.outline())
                            .disabled(self.pending)
                            .icon(icon("headphones"))
                            .label(label)
                            .on_click(cx.listener(|this, _, _, cx| this.toggle(cx))),
                    )
                    .child(mic_level_meter(level, cx)),
            )
            .when_some(self.error.clone(), |test, error| {
                test.child(
                    div()
                        .mt_2()
                        .border_1()
                        .border_color(t.destructive.opacity(0.2))
                        .bg(t.destructive.opacity(0.1))
                        .px_2()
                        .py(px(6.0))
                        .text_size(px(11.0))
                        .text_color(t.destructive)
                        .child(error),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::Resampler;

    #[test]
    fn same_rate_passes_samples_through() {
        let mut buffer: VecDeque<f32> = [0.1, 0.2, 0.3].into();
        let mut resampler = Resampler::new(48_000, 48_000);
        let out: Vec<f32> = (0..4).map(|_| resampler.next(&mut buffer)).collect();
        assert_eq!(out, [0.1, 0.2, 0.3, 0.3]);
    }

    #[test]
    fn upsampling_repeats_and_downsampling_skips() {
        let mut buffer: VecDeque<f32> = [1.0, 2.0].into();
        let mut up = Resampler::new(24_000, 48_000);
        let out: Vec<f32> = (0..4).map(|_| up.next(&mut buffer)).collect();
        assert_eq!(out, [0.0, 1.0, 1.0, 2.0]);

        let mut buffer: VecDeque<f32> = [1.0, 2.0, 3.0, 4.0].into();
        let mut down = Resampler::new(96_000, 48_000);
        let out: Vec<f32> = (0..2).map(|_| down.next(&mut buffer)).collect();
        assert_eq!(out, [2.0, 4.0]);
    }
}
