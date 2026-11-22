// Port of apps/frontend/src/lib/voice.svelte.ts. Placeholder API until the LiveKit port: the shell
// and sidebars call these, the voice milestone fills them in.
use std::collections::HashMap;

use gpui_kit::*;
use serde::{Deserialize, Serialize};

use crate::{
    sounds,
    state::{
        realtime::Realtime,
        settings::{NoiseSuppressionModel, SettingsStore},
    },
    storage,
};

const SELF_AUDIO_KEY: &str = "novarum:self-audio";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    #[allow(dead_code)] // set by the LiveKit port
    Reconnecting,
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
    pub noise_cancellation_enabled: bool,
    pub audio_loopback_testing: bool,
}

struct GlobalVoice(Entity<Voice>);
impl Global for GlobalVoice {}

pub fn init(cx: &mut App) {
    let stored: SelfAudio = storage::get(SELF_AUDIO_KEY).unwrap_or_default();
    let noise_cancellation_enabled = SettingsStore::get(cx).noise_cancellation;
    let voice = cx.new(|_| Voice {
        channel_id: None,
        connection_state: ConnectionState::Disconnected,
        self_muted: stored.muted,
        muted_before_deafen: stored.muted_before_deafen,
        self_deafened: stored.deafened,
        self_camera: false,
        self_screen_share: false,
        voice_states: HashMap::new(),
        noise_cancellation_enabled,
        audio_loopback_testing: false,
    });
    cx.set_global(GlobalVoice(voice));
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

    pub fn join(&mut self, channel_id: &str, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        self.channel_id = Some(channel_id.to_string());
        // no media yet: being in the call is just the realtime presence
        self.connection_state = ConnectionState::Connected;
        Realtime::global(cx).update(cx, |realtime, _| realtime.join_voice(channel_id));
        cx.notify();
        Task::ready(Ok(()))
    }

    pub fn leave(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.channel_id = None;
        self.connection_state = ConnectionState::Disconnected;
        self.voice_states.clear();
        Realtime::global(cx).update(cx, |realtime, _| realtime.leave_voice());
        cx.notify();
        Task::ready(())
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
        cx.notify();
    }

    pub fn set_camera(&mut self, on: bool, cx: &mut Context<Self>) {
        self.self_camera = on;
        sounds::play(if on { "camera" } else { "camera-off" }, 1.0);
        cx.notify();
    }

    pub fn set_screen_share(&mut self, on: bool, cx: &mut Context<Self>) {
        self.self_screen_share = on;
        sounds::play(if on { "screen" } else { "screen-off" }, 1.0);
        cx.notify();
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
