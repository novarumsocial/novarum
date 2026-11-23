// Screen-share audio: what the computer plays, minus Novarum itself (which would echo the call
// back into the share), published as the share's audio track. The web gets this from Chromium's
// loopback on Windows/macOS and venmic on Linux; here each platform has its own capture:
// a PipeWire patch bay on Linux, process-excluding WASAPI loopback on Windows, and
// ScreenCaptureKit with `excludesCurrentProcessAudio` on macOS.
use std::borrow::Cow;

use livekit::{
    prelude::*,
    webrtc::{
        audio_source::{AudioSourceOptions, RtcAudioSource, native::NativeAudioSource},
        prelude::AudioFrame,
    },
};
use tokio::sync::mpsc;

const RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
/// 10ms, what WebRTC wants per frame
const FRAME_SAMPLES: usize = (RATE / 100 * CHANNELS) as usize;

/// Interleaved stereo at 48 kHz, from the capture thread.
type Samples = mpsc::UnboundedSender<Vec<i16>>;

fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

pub struct ScreenAudio {
    pub track: LocalAudioTrack,
    _capture: capture::Handle,
}

pub async fn start() -> Result<ScreenAudio, String> {
    let options = AudioSourceOptions {
        echo_cancellation: false,
        noise_suppression: false,
        auto_gain_control: false,
    };
    let source = NativeAudioSource::new(options, RATE, CHANNELS, 100);
    let track = LocalAudioTrack::create_audio_track(
        "screen-share-audio",
        RtcAudioSource::Native(source.clone()),
    );

    let (samples, mut received) = mpsc::unbounded_channel::<Vec<i16>>();
    tokio::spawn(async move {
        let mut pending = Vec::new();
        while let Some(chunk) = received.recv().await {
            pending.extend(chunk);
            while pending.len() >= FRAME_SAMPLES {
                let frame = AudioFrame {
                    data: Cow::Owned(pending.drain(..FRAME_SAMPLES).collect()),
                    sample_rate: RATE,
                    num_channels: CHANNELS,
                    samples_per_channel: FRAME_SAMPLES as u32 / CHANNELS,
                };
                let _ = source.capture_frame(&frame).await;
            }
        }
    });

    let capture = capture::spawn(samples).await?;
    Ok(ScreenAudio {
        track,
        _capture: capture,
    })
}

#[cfg(target_os = "linux")]
mod capture {
    // Linux has no system-audio loopback, so like venmic: a capture stream that links itself to
    // every playback stream except our own.
    use std::{
        cell::RefCell,
        collections::{HashMap, HashSet},
        rc::Rc,
    };

    use pipewire::{
        self as pw, link::Link, node::Node, properties::properties, spa, types::ObjectType,
    };
    use tokio::sync::oneshot;

    use super::{CHANNELS, RATE, Samples, to_i16};

    const NODE_NAME: &str = "novarum-screen-share";

    pub struct Handle(pw::channel::Sender<()>);

    impl Drop for Handle {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    pub async fn spawn(samples: Samples) -> Result<Handle, String> {
        let (quit, quit_rx) = pw::channel::channel();
        let (ready, started) = oneshot::channel();
        std::thread::spawn(move || {
            if let Err(error) = run(samples, quit_rx, ready) {
                eprintln!("Screen share audio stopped: {error}");
            }
        });
        started
            .await
            .map_err(|_| "PipeWire isn't available".to_string())?;
        Ok(Handle(quit))
    }

    struct Port {
        node: u32,
        output: bool,
        channel: String,
    }

    /// What the registry has told us so far, and the links we made from it.
    #[derive(Default)]
    struct Graph {
        own_node: Option<u32>,
        included: HashSet<u32>,
        ports: HashMap<u32, Port>,
        links: HashMap<(u32, u32), Link>,
        /// bound playback nodes, kept alive until their info says whether they're ours
        nodes: HashMap<u32, (Node, pw::node::NodeListener)>,
    }

    impl Graph {
        fn relink(&mut self, core: &pw::core::CoreRc) {
            let Some(own) = self.own_node else {
                return;
            };
            let inputs: Vec<(u32, &str)> = self
                .ports
                .iter()
                .filter(|(_, port)| port.node == own && !port.output)
                .map(|(id, port)| (*id, port.channel.as_str()))
                .collect();
            for (out_id, out) in &self.ports {
                if !out.output || !self.included.contains(&out.node) {
                    continue;
                }
                for &(in_id, channel) in &inputs {
                    // mono playback goes to both sides
                    let matches = out.channel == channel || out.channel == "MONO";
                    if !matches || self.links.contains_key(&(*out_id, in_id)) {
                        continue;
                    }
                    let link = core.create_object::<Link>(
                        "link-factory",
                        &properties! {
                            "link.output.node" => out.node.to_string(),
                            "link.output.port" => out_id.to_string(),
                            "link.input.node" => own.to_string(),
                            "link.input.port" => in_id.to_string(),
                        },
                    );
                    if let Ok(link) = link {
                        self.links.insert((*out_id, in_id), link);
                    }
                }
            }
        }

        fn remove(&mut self, id: u32) {
            self.included.remove(&id);
            self.nodes.remove(&id);
            self.ports.remove(&id);
            self.links
                .retain(|(output, input), _| *output != id && *input != id);
        }
    }

    /// libwebrtc links in its own `pw_*` stubs for its screen capturer, and they shadow libpipewire's
    /// symbols for us too. They point nowhere until webrtc loads PipeWire itself, so fill them from the
    /// already-loaded library before touching any PipeWire API.
    fn fill_webrtc_stubs() {
        use std::ffi::{c_char, c_int, c_void};
        const RTLD_NOW_GLOBAL: c_int = 0x2 | 0x100;
        unsafe extern "C" {
            fn dlopen(file: *const c_char, mode: c_int) -> *mut c_void;
            #[link_name = "_ZN14modules_portal21IsPipewireInitializedEv"]
            fn webrtc_pipewire_initialized() -> bool;
            #[link_name = "_ZN14modules_portal18InitializePipewireEPv"]
            fn webrtc_initialize_pipewire(module: *mut c_void);
        }
        unsafe {
            if webrtc_pipewire_initialized() {
                return;
            }
            let module = dlopen(c"libpipewire-0.3.so.0".as_ptr(), RTLD_NOW_GLOBAL);
            if !module.is_null() {
                webrtc_initialize_pipewire(module);
            }
        }
    }

    fn run(
        samples: Samples,
        quit: pw::channel::Receiver<()>,
        ready: oneshot::Sender<()>,
    ) -> Result<(), pw::Error> {
        fill_webrtc_stubs();
        pw::init();
        let mainloop = pw::main_loop::MainLoopRc::new(None)?;
        let context = pw::context::ContextRc::new(&mainloop, None)?;
        let core = context.connect_rc(None)?;
        let registry = core.get_registry_rc()?;
        let _quit = quit.attach(mainloop.loop_(), {
            let mainloop = mainloop.clone();
            move |()| mainloop.quit()
        });

        let stream = pw::stream::StreamBox::new(
            &core,
            NODE_NAME,
            properties! {
                *pw::keys::MEDIA_TYPE => "Audio",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::MEDIA_ROLE => "Screen",
                *pw::keys::NODE_NAME => NODE_NAME,
            },
        )?;
        let _stream_listener = stream
            .add_local_listener_with_user_data(())
            .process(move |stream, _| {
                let Some(mut buffer) = stream.dequeue_buffer() else {
                    return;
                };
                let Some(data) = buffer.datas_mut().first_mut() else {
                    return;
                };
                let size = data.chunk().size() as usize;
                if let Some(bytes) = data.data() {
                    let chunk = bytes[..size.min(bytes.len())]
                        .chunks_exact(4)
                        .map(|sample| to_i16(f32::from_le_bytes(sample.try_into().unwrap())))
                        .collect();
                    let _ = samples.send(chunk);
                }
            })
            .register()?;

        let mut format = spa::param::audio::AudioInfoRaw::new();
        format.set_format(spa::param::audio::AudioFormat::F32LE);
        format.set_rate(RATE);
        format.set_channels(CHANNELS);
        let mut position = [0; spa::param::audio::MAX_CHANNELS];
        position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
        position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
        format.set_position(position);
        let format = spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()),
            &spa::pod::Value::Object(spa::pod::Object {
                type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
                id: spa::param::ParamType::EnumFormat.as_raw(),
                properties: format.into(),
            }),
        )
        .expect("audio format serializes")
        .0
        .into_inner();
        // no AUTOCONNECT: the stream only hears what we link into it
        stream.connect(
            spa::utils::Direction::Input,
            None,
            pw::stream::StreamFlags::MAP_BUFFERS,
            &mut [spa::pod::Pod::from_bytes(&format).expect("audio format pod")],
        )?;

        let graph = Rc::new(RefCell::new(Graph::default()));
        let own_pid = std::process::id().to_string();
        let own_binary = std::env::current_exe()
            .ok()
            .and_then(|path| path.file_name()?.to_str().map(str::to_string))
            .unwrap_or_default();
        let _registry_listener = registry
            .add_listener_local()
            .global({
                let (graph, core, registry) = (graph.clone(), core.clone(), registry.clone());
                move |global| {
                    let Some(props) = global.props else {
                        return;
                    };
                    match global.type_ {
                        ObjectType::Node if props.get(*pw::keys::NODE_NAME) == Some(NODE_NAME) => {
                            graph.borrow_mut().own_node = Some(global.id);
                        }
                        ObjectType::Node
                            if props.get(*pw::keys::MEDIA_CLASS) == Some("Stream/Output/Audio") =>
                        {
                            // the process id only shows in the node's full info, not its global
                            let Ok(node) = registry.bind::<Node, _>(global) else {
                                return;
                            };
                            let id = global.id;
                            let listener = node
                                .add_listener_local()
                                .info({
                                    let (graph, core) = (graph.clone(), core.clone());
                                    let (own_pid, own_binary) =
                                        (own_pid.clone(), own_binary.clone());
                                    move |info| {
                                        let Some(props) = info.props() else {
                                            return;
                                        };
                                        let ours = props.get(*pw::keys::APP_PROCESS_ID)
                                            == Some(own_pid.as_str())
                                            || props.get(*pw::keys::APP_PROCESS_BINARY)
                                                == Some(own_binary.as_str());
                                        let mut graph = graph.borrow_mut();
                                        if !ours && graph.included.insert(id) {
                                            graph.relink(&core);
                                        }
                                    }
                                })
                                .register();
                            graph.borrow_mut().nodes.insert(id, (node, listener));
                            return;
                        }
                        ObjectType::Port => {
                            let (Some(node), Some(direction)) = (
                                props
                                    .get(*pw::keys::NODE_ID)
                                    .and_then(|node| node.parse().ok()),
                                props.get(*pw::keys::PORT_DIRECTION),
                            ) else {
                                return;
                            };
                            let channel = props
                                .get(*pw::keys::AUDIO_CHANNEL)
                                .unwrap_or("MONO")
                                .to_string();
                            graph.borrow_mut().ports.insert(
                                global.id,
                                Port {
                                    node,
                                    output: direction == "out",
                                    channel,
                                },
                            );
                        }
                        _ => return,
                    }
                    graph.borrow_mut().relink(&core);
                }
            })
            .global_remove({
                let graph = graph.clone();
                move |id| graph.borrow_mut().remove(id)
            })
            .register();

        let _ = ready.send(());
        mainloop.run();
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod capture {
    // Windows 10 2004+ can loop back everything that plays except one process tree, ours.
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use tokio::sync::oneshot;
    use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

    use super::{CHANNELS, RATE, Samples, to_i16};

    pub struct Handle(Arc<AtomicBool>);

    impl Drop for Handle {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    pub async fn spawn(samples: Samples) -> Result<Handle, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready, started) = oneshot::channel();
        let flag = stop.clone();
        std::thread::spawn(move || {
            let run = || -> Result<(), String> {
                initialize_mta().ok().map_err(|error| error.to_string())?;
                let format = WaveFormat::new(
                    32,
                    32,
                    SampleType::Float,
                    RATE as usize,
                    CHANNELS as usize,
                    None,
                );
                let mut client =
                    AudioClient::new_application_loopback_client(std::process::id(), false)
                        .map_err(|error| error.to_string())?;
                let mode = StreamMode::EventsShared {
                    autoconvert: true,
                    buffer_duration_hns: 200_000,
                };
                client
                    .initialize_client(&format, Direction::Capture, mode, None)
                    .map_err(|error| error.to_string())?;
                let event = client
                    .set_get_eventhandle()
                    .map_err(|error| error.to_string())?;
                let capture = client
                    .get_audiocaptureclient()
                    .map_err(|error| error.to_string())?;
                client.start_stream().map_err(|error| error.to_string())?;
                let _ = ready.send(Ok(()));
                let mut bytes = std::collections::VecDeque::new();
                while !flag.load(Ordering::Relaxed) {
                    // no events while nothing plays, so the timeout just checks for stopping
                    if event.wait_for_event(100).is_err() {
                        continue;
                    }
                    capture
                        .read_from_device_to_deque(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    let chunk: Vec<i16> = bytes
                        .drain(..bytes.len() / 4 * 4)
                        .collect::<Vec<u8>>()
                        .chunks_exact(4)
                        .map(|sample| to_i16(f32::from_le_bytes(sample.try_into().unwrap())))
                        .collect();
                    if samples.send(chunk).is_err() {
                        break;
                    }
                }
                let _ = client.stop_stream();
                Ok(())
            };
            if let Err(error) = run() {
                eprintln!("Screen share audio stopped: {error}");
            }
        });
        // a failure before the stream starts drops `ready` without sending
        match started.await {
            Ok(Ok(())) => Ok(Handle(stop)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("System audio capture isn't available".into()),
        }
    }
}

#[cfg(target_os = "macos")]
mod capture {
    // ScreenCaptureKit (macOS 13+) captures what plays, leaving out our own process.
    use screencapturekit::{cm::AudioBuffer, prelude::*};

    use super::{CHANNELS, RATE, Samples, to_i16};

    pub struct Handle(SCStream);

    impl Drop for Handle {
        fn drop(&mut self) {
            let _ = self.0.stop_capture();
        }
    }

    struct Output(Samples);

    impl SCStreamOutputTrait for Output {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
            if !matches!(kind, SCStreamOutputType::Audio) {
                return;
            }
            let Ok(list) = sample.audio_buffer_list() else {
                return;
            };
            let floats = |buffer: &AudioBuffer| -> Vec<f32> {
                buffer
                    .data()
                    .chunks_exact(4)
                    .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
                    .collect()
            };
            // usually one buffer per channel; interleave them
            let chunk: Vec<i16> = match (list.get(0), list.get(1)) {
                (Some(left), Some(right)) => floats(left)
                    .into_iter()
                    .zip(floats(right))
                    .flat_map(|(l, r)| [to_i16(l), to_i16(r)])
                    .collect(),
                (Some(only), None) if only.number_channels == 2 => {
                    floats(only).into_iter().map(to_i16).collect()
                }
                (Some(mono), None) => floats(mono)
                    .into_iter()
                    .flat_map(|sample| [to_i16(sample); 2])
                    .collect(),
                _ => return,
            };
            let _ = self.0.send(chunk);
        }
    }

    pub async fn spawn(samples: Samples) -> Result<Handle, String> {
        tokio::task::spawn_blocking(move || {
            let content = SCShareableContent::get().map_err(|error| error.to_string())?;
            let display = content
                .displays()
                .into_iter()
                .next()
                .ok_or("No display to capture audio from")?;
            let filter = SCContentFilter::create()
                .with_display(&display)
                .with_excluding_windows(&[])
                .build()
                .map_err(|error| error.to_string())?;
            // audio only matters here; the smallest frames keep the unused video cheap
            let config = SCStreamConfiguration::new()
                .with_width(2)
                .with_height(2)
                .with_captures_audio(true)
                .with_excludes_current_process_audio(true)
                .with_sample_rate(RATE as i32)
                .with_channel_count(CHANNELS as i32);
            let mut stream = SCStream::new(&filter, &config).map_err(|error| error.to_string())?;
            stream
                .add_output_handler(Output(samples), SCStreamOutputType::Audio)
                .map_err(|error| error.to_string())?;
            stream.start_capture().map_err(|error| error.to_string())?;
            Ok(Handle(stream))
        })
        .await
        .map_err(|error| error.to_string())?
    }
}
