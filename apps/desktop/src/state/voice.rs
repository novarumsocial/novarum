// Port of apps/frontend/src/lib/voice.svelte.ts: the call you're in, from the UI side. The LiveKit
// room itself lives on the IO runtime (`voice_room.rs`); this entity mirrors its snapshots into
// gpui state, plays the call sounds and keeps the realtime presence in sync.
use std::collections::{HashMap, HashSet};

use futures::{StreamExt, channel::mpsc};
use gpui_kit::*;
use serde::{Deserialize, Serialize};

use crate::{
    sounds,
    state::{
        realtime::Realtime,
        settings::{NoiseSuppressionModel, Settings, SettingsStore},
        video::{self, VideoFeeds},
        voice_room::{self, ParticipantAudio, ParticipantHandle, VoiceCommand, VoiceRoomEvent},
    },
    storage,
};

const SELF_AUDIO_KEY: &str = "novarum:self-audio";
const PARTICIPANT_AUDIO_KEY: &str = "novarum:participant-audio";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

impl From<livekit::ConnectionState> for ConnectionState {
    fn from(state: livekit::ConnectionState) -> Self {
        match state {
            livekit::ConnectionState::Connected => Self::Connected,
            livekit::ConnectionState::Reconnecting => Self::Reconnecting,
            livekit::ConnectionState::Disconnected => Self::Disconnected,
        }
    }
}

/// A participant's live state in the call you're in (`VoiceState`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VoiceState {
    pub speaking: bool,
    pub self_muted: bool,
    pub self_deafened: bool,
    pub camera: bool,
    pub screen_share: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SelfAudio {
    muted: bool,
    deafened: bool,
    muted_before_deafen: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredParticipantAudio {
    #[serde(default)]
    volume: f32,
    #[serde(default)]
    muted: bool,
    #[serde(default)]
    screen_volume: f32,
}

pub struct Voice {
    pub channel_id: Option<String>,
    pub connection_state: ConnectionState,
    pub self_muted: bool,
    pub muted_before_deafen: bool,
    pub self_deafened: bool,
    pub self_camera: bool,
    pub self_screen_share: bool,
    /// keyed by participant identity (user id)
    pub voice_states: HashMap<String, VoiceState>,
    /// remote screen shares only stream to those who chose to watch them
    pub watched_streams: HashSet<String>,
    pub noise_cancellation_enabled: bool,
    pub audio_loopback_testing: bool,
    /// participant identity -> { username, homeserver }, from the LiveKit metadata the server sets
    handles: HashMap<String, ParticipantHandle>,
    local_identity: Option<String>,
    /// identity -> { volume, muted, screenVolume }, persisted like the web's `participantAudio`
    participant_audio: HashMap<String, ParticipantAudio>,
    commands: mpsc::UnboundedSender<VoiceCommand>,
    _events: Option<Task<()>>,
}

struct GlobalVoice(Entity<Voice>);
impl Global for GlobalVoice {}

/// The mic chain the settings ask for: like the web, the browser-style noise suppression stays
/// off and the chosen model does it, at a fixed strength or one picked from the room's noise.
fn processing(settings: &Settings) -> voice_room::AudioProcessing {
    voice_room::AudioProcessing {
        echo_cancellation: settings.voice_echo_cancellation,
        auto_gain_control: settings.voice_auto_gain_control,
        noise: settings
            .noise_cancellation
            .then_some(match settings.noise_suppression_model {
                NoiseSuppressionModel::Rnnoise => voice_room::NoiseModel::Rnnoise,
                NoiseSuppressionModel::Deepfilternet => voice_room::NoiseModel::DeepFilter,
            }),
        noise_level: (!settings.noise_suppression_auto).then_some(settings.noise_suppression_level),
    }
}

pub fn init(cx: &mut App) {
    let stored: SelfAudio = storage::get(SELF_AUDIO_KEY).unwrap_or_default();
    let settings = SettingsStore::get(cx);
    let participant_audio =
        storage::get::<HashMap<String, StoredParticipantAudio>>(PARTICIPANT_AUDIO_KEY)
            .unwrap_or_default()
            .into_iter()
            .map(|(identity, audio)| {
                (
                    identity,
                    ParticipantAudio {
                        volume: audio.volume,
                        muted: audio.muted,
                        screen_volume: audio.screen_volume,
                    },
                )
            })
            .collect();
    video::init(cx);
    let (commands, events) = voice_room::spawn(VideoFeeds::sink(cx));
    let voice = cx.new(|_| Voice {
        channel_id: None,
        connection_state: ConnectionState::Disconnected,
        self_muted: stored.muted,
        muted_before_deafen: stored.muted_before_deafen,
        self_deafened: stored.deafened,
        self_camera: false,
        self_screen_share: false,
        voice_states: HashMap::new(),
        watched_streams: HashSet::new(),
        noise_cancellation_enabled: settings.noise_cancellation,
        audio_loopback_testing: false,
        handles: HashMap::new(),
        local_identity: None,
        participant_audio,
        commands,
        _events: None,
    });
    let weak = voice.downgrade();
    let _events = cx.spawn(async move |cx| {
        let mut events = events;
        while let Some(event) = events.next().await {
            if weak
                .update(cx, |voice, cx| voice.on_event(event, cx))
                .is_err()
            {
                break;
            }
        }
    });
    voice.update(cx, |voice, _| voice._events = Some(_events));
    cx.set_global(GlobalVoice(voice));
    // settings changes follow the live call, like the web's capture/output options
    cx.observe(&SettingsStore::global(cx), |_, cx| {
        Voice::global(cx).update(cx, |voice, cx| voice.forward_settings(cx));
    })
    .detach();
}

impl Voice {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalVoice>().0.clone()
    }

    pub fn connected(&self) -> bool {
        self.connection_state == ConnectionState::Connected
    }

    pub fn connecting(&self) -> bool {
        self.connection_state == ConnectionState::Connecting
    }

    pub fn participant_count(&self) -> usize {
        self.voice_states.len()
    }

    /// Federated users join with their id on the call's host, so match them by handle instead.
    pub fn participant_handle(&self, identity: &str) -> Option<&ParticipantHandle> {
        self.handles.get(identity)
    }

    pub fn local_identity(&self) -> Option<&str> {
        self.local_identity.as_deref()
    }

    pub fn participant_volume(&self, identity: &str) -> f32 {
        self.participant_audio
            .get(identity)
            .map(|audio| audio.volume)
            .unwrap_or(1.0)
    }

    pub fn participant_muted(&self, identity: &str) -> bool {
        self.participant_audio
            .get(identity)
            .is_some_and(|audio| audio.muted)
    }

    pub fn participant_screen_volume(&self, identity: &str) -> f32 {
        self.participant_audio
            .get(identity)
            .map(|audio| audio.screen_volume)
            .unwrap_or(1.0)
    }

    fn save_participant_audio(&self) {
        let stored: HashMap<String, StoredParticipantAudio> = self
            .participant_audio
            .iter()
            .map(|(identity, audio)| {
                (
                    identity.clone(),
                    StoredParticipantAudio {
                        volume: audio.volume,
                        muted: audio.muted,
                        screen_volume: audio.screen_volume,
                    },
                )
            })
            .collect();
        storage::set(PARTICIPANT_AUDIO_KEY, &stored);
    }

    fn set_participant_audio(
        &mut self,
        identity: &str,
        volume: f32,
        muted: bool,
        screen_volume: f32,
        cx: &mut Context<Self>,
    ) {
        let audio = ParticipantAudio {
            volume,
            muted,
            screen_volume,
        };
        self.participant_audio
            .insert(identity.to_string(), audio.clone());
        self.save_participant_audio();
        let _ = self
            .commands
            .unbounded_send(VoiceCommand::SetParticipantAudio {
                identity: identity.to_string(),
                audio,
            });
        cx.notify();
    }

    pub fn set_participant_volume(&mut self, identity: &str, volume: f32, cx: &mut Context<Self>) {
        self.set_participant_audio(
            identity,
            volume.clamp(0.0, 3.0),
            self.participant_muted(identity),
            self.participant_screen_volume(identity),
            cx,
        );
    }

    pub fn set_participant_muted(&mut self, identity: &str, muted: bool, cx: &mut Context<Self>) {
        self.set_participant_audio(
            identity,
            self.participant_volume(identity),
            muted,
            self.participant_screen_volume(identity),
            cx,
        );
    }

    pub fn set_participant_screen_volume(
        &mut self,
        identity: &str,
        volume: f32,
        cx: &mut Context<Self>,
    ) {
        self.set_participant_audio(
            identity,
            self.participant_volume(identity),
            self.participant_muted(identity),
            volume.clamp(0.0, 3.0),
            cx,
        );
    }

    pub fn watch_stream(&mut self, identity: &str, cx: &mut Context<Self>) {
        self.watched_streams.insert(identity.to_string());
        let _ = self.commands.unbounded_send(VoiceCommand::WatchStream {
            identity: identity.to_string(),
            watching: true,
        });
        cx.notify();
    }

    pub fn stop_watching_stream(&mut self, identity: &str, cx: &mut Context<Self>) {
        self.watched_streams.remove(identity);
        let _ = self.commands.unbounded_send(VoiceCommand::WatchStream {
            identity: identity.to_string(),
            watching: false,
        });
        cx.notify();
    }

    pub fn join(&mut self, channel_id: &str, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        if self.channel_id.as_deref() == Some(channel_id) && (self.connected() || self.connecting())
        {
            return Task::ready(Ok(()));
        }
        if self.channel_id.is_some() {
            self.leave(cx).detach();
            sounds::play("leave", 1.0);
        }

        sounds::play("join", 1.0);
        self.channel_id = Some(channel_id.to_string());
        self.connection_state = ConnectionState::Connecting;
        let settings = SettingsStore::get(cx);
        let _ = self.commands.unbounded_send(VoiceCommand::Join {
            channel_id: channel_id.to_string(),
            options: voice_room::JoinOptions {
                processing: processing(&settings),
                devices: voice_room::AudioDevices {
                    input: settings.voice_input_device_id.clone(),
                    output: settings.voice_output_device_id.clone(),
                },
                muted: self.self_muted,
                deafened: self.self_deafened,
                participant_audio: self.participant_audio.clone(),
            },
        });
        cx.notify();
        Task::ready(Ok(()))
    }

    pub fn leave(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.channel_id = None;
        self.connection_state = ConnectionState::Disconnected;
        self.self_camera = false;
        self.self_screen_share = false;
        self.voice_states.clear();
        self.watched_streams.clear();
        self.handles.clear();
        self.local_identity = None;
        let _ = self.commands.unbounded_send(VoiceCommand::Leave);
        Realtime::global(cx).update(cx, |realtime, _| realtime.leave_voice());
        sounds::play("leave", 1.0);
        cx.notify();
        Task::ready(())
    }

    fn on_event(&mut self, event: VoiceRoomEvent, cx: &mut Context<Self>) {
        match event {
            VoiceRoomEvent::Sync(snapshot) => {
                // the web calls realtime.joinVoice once the room comes up
                let first_connect = snapshot.connection_state == ConnectionState::Connected
                    && self.connection_state == ConnectionState::Connecting;
                self.connection_state = snapshot.connection_state;
                self.local_identity = snapshot.local_identity;
                // the room is the source of truth for whether a capture actually runs
                if let Some(local) = self
                    .local_identity
                    .as_ref()
                    .and_then(|identity| snapshot.states.get(identity))
                {
                    if local.camera != self.self_camera {
                        sounds::play(if local.camera { "camera" } else { "camera-off" }, 1.0);
                    }
                    if local.screen_share != self.self_screen_share {
                        sounds::play(
                            if local.screen_share {
                                "screen"
                            } else {
                                "screen-off"
                            },
                            1.0,
                        );
                    }
                    self.self_camera = local.camera;
                    self.self_screen_share = local.screen_share;
                }
                self.handles = snapshot.handles;
                self.voice_states = snapshot.states;
                if first_connect {
                    if let Some(channel_id) = self.channel_id.clone() {
                        Realtime::global(cx).update(cx, |realtime, _| {
                            realtime.join_voice(&channel_id);
                        });
                    }
                }
                cx.notify();
            }
            VoiceRoomEvent::ParticipantJoined => {
                if SettingsStore::get(cx).others_call_sounds {
                    sounds::play("join", 1.0);
                }
            }
            VoiceRoomEvent::ParticipantLeft(identity) => {
                self.watched_streams.remove(identity.as_str());
                if SettingsStore::get(cx).others_call_sounds {
                    sounds::play("leave", 1.0);
                }
            }
            VoiceRoomEvent::MicChanged { identity, muted } => {
                // the first publication has no prior state to differ from, so no sound yet
                if self.voice_states.contains_key(&identity)
                    && SettingsStore::get(cx).others_call_sounds
                {
                    sounds::play(if muted { "mute" } else { "mute-reverse" }, 1.0);
                }
            }
            VoiceRoomEvent::ScreenChanged { identity, on } => {
                if self.voice_states.contains_key(&identity)
                    && SettingsStore::get(cx).others_call_sounds
                {
                    sounds::play(if on { "screen" } else { "screen-off" }, 1.0);
                }
                if !on {
                    self.watched_streams.remove(identity.as_str());
                }
            }
            VoiceRoomEvent::CameraChanged { identity, on } => {
                if self.voice_states.contains_key(&identity)
                    && SettingsStore::get(cx).others_call_sounds
                {
                    sounds::play(if on { "camera" } else { "camera-off" }, 1.0);
                }
            }
            VoiceRoomEvent::CaptureFailed => sounds::play("camera-off", 1.0),
            VoiceRoomEvent::Left => self.on_room_left(cx),
        }
    }

    /// The room went away on its own (network died, kicked): clean up like the web's
    /// `RoomEvent.Disconnected` handler.
    fn on_room_left(&mut self, cx: &mut Context<Self>) {
        self.channel_id = None;
        self.connection_state = ConnectionState::Disconnected;
        self.self_camera = false;
        self.self_screen_share = false;
        self.voice_states.clear();
        self.watched_streams.clear();
        self.handles.clear();
        self.local_identity = None;
        Realtime::global(cx).update(cx, |realtime, _| realtime.leave_voice());
        cx.notify();
    }

    fn forward_settings(&mut self, cx: &mut Context<Self>) {
        let settings = SettingsStore::get(cx);
        self.noise_cancellation_enabled = settings.noise_cancellation;
        let _ = self.commands.unbounded_send(VoiceCommand::SetProcessing {
            processing: processing(&settings),
        });
        let _ = self.commands.unbounded_send(VoiceCommand::SetDevices {
            devices: voice_room::AudioDevices {
                input: settings.voice_input_device_id,
                output: settings.voice_output_device_id,
            },
        });
    }

    fn save_self_audio(&self) {
        let audio = SelfAudio {
            muted: self.self_muted,
            deafened: self.self_deafened,
            muted_before_deafen: self.muted_before_deafen,
        };
        storage::set(SELF_AUDIO_KEY, &audio);
    }

    pub fn set_muted(&mut self, muted: bool, cx: &mut Context<Self>) {
        self.self_muted = muted;
        self.save_self_audio();
        sounds::play(if muted { "mute" } else { "mute-reverse" }, 1.0);
        let _ = self
            .commands
            .unbounded_send(VoiceCommand::SetMuted { muted });
        cx.notify();
    }

    /// Deafening also mutes; undeafening puts the mute back how it was.
    pub fn set_deafened(&mut self, deafened: bool, cx: &mut Context<Self>) {
        self.self_deafened = deafened;
        if deafened {
            sounds::play("deafen", 1.0);
            self.muted_before_deafen = self.self_muted;
            self.self_muted = true;
        } else {
            sounds::play("deafen-reverse", 1.0);
            self.self_muted = self.muted_before_deafen;
        }
        self.save_self_audio();
        let _ = self
            .commands
            .unbounded_send(VoiceCommand::SetDeafened { deafened });
        let _ = self.commands.unbounded_send(VoiceCommand::SetMuted {
            muted: self.self_muted,
        });
        cx.notify();
    }

    /// The sound and the flag follow once the room reports the capture running (or failing).
    pub fn set_camera(&mut self, on: bool, cx: &mut Context<Self>) {
        let device = SettingsStore::get(cx).video_input_device_id;
        let _ = self
            .commands
            .unbounded_send(VoiceCommand::SetCamera { on, device });
    }

    pub fn set_screen_share(&mut self, on: bool, cx: &mut Context<Self>) {
        let system_audio = SettingsStore::get(cx).screen_share_system_audio;
        let _ = self
            .commands
            .unbounded_send(VoiceCommand::SetScreenShare { on, system_audio });
    }

    pub fn set_noise_cancellation(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.noise_cancellation_enabled = enabled;
        SettingsStore::update(cx, |settings| settings.noise_cancellation = enabled);
        cx.notify();
    }

    pub fn set_noise_suppression_model(
        &mut self,
        model: NoiseSuppressionModel,
        cx: &mut Context<Self>,
    ) {
        SettingsStore::update(cx, |settings| settings.noise_suppression_model = model);
        cx.notify();
    }
}
