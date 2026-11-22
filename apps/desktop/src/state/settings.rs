// Port of apps/frontend/src/lib/settings.svelte.ts. Saved under the same "settings" key.
use gpui_kit::*;
use serde::{Deserialize, Serialize};

use crate::{storage, theme};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeFormat {
    Auto,
    #[serde(rename = "12hr")]
    H12,
    #[serde(rename = "24hr")]
    H24,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoiseSuppressionModel {
    Deepfilternet,
    Rnnoise,
}

impl NoiseSuppressionModel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Deepfilternet => "DeepFilterNet 3",
            Self::Rnnoise => "RNNoise",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub push_notifications: bool,
    pub message_preview: bool,
    pub mention_sound: bool,
    pub show_online_status: bool,
    pub compact_mode: bool,
    pub show_member_list: bool,
    pub circle_icons: bool,
    pub rounded_borders: bool,
    pub dark_mode: bool,
    pub noise_cancellation: bool,
    pub noise_suppression_model: NoiseSuppressionModel,
    pub noise_suppression_level: f32,
    pub noise_suppression_auto: bool,
    pub voice_echo_cancellation: bool,
    pub voice_auto_gain_control: bool,
    pub voice_input_device_id: String,
    pub voice_output_device_id: String,
    pub video_input_device_id: String,
    pub screen_share_system_audio: bool,
    pub others_call_sounds: bool,
    pub notification_volume: f32,
    pub time_format: TimeFormat,
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // the desktop app is allowed to notify out of the box
            push_notifications: true,
            message_preview: true,
            mention_sound: true,
            show_online_status: true,
            compact_mode: false,
            show_member_list: true,
            circle_icons: false,
            rounded_borders: false,
            dark_mode: true,
            noise_cancellation: true,
            noise_suppression_model: NoiseSuppressionModel::Deepfilternet,
            noise_suppression_level: 30.0,
            noise_suppression_auto: true,
            voice_echo_cancellation: true,
            voice_auto_gain_control: true,
            voice_input_device_id: "default".into(),
            voice_output_device_id: "default".into(),
            video_input_device_id: "default".into(),
            screen_share_system_audio: true,
            others_call_sounds: true,
            notification_volume: 0.5,
            time_format: TimeFormat::Auto,
            language: "en".into(),
        }
    }
}

pub struct SettingsStore {
    pub value: Settings,
    /// `settingsDialog.open`
    pub dialog_open: bool,
}

struct GlobalSettings(Entity<SettingsStore>);
impl Global for GlobalSettings {}

pub fn init(cx: &mut App) {
    let value: Settings = storage::get("settings").unwrap_or_default();
    // the web app's `circleIcons` drives `data-rounded`, which rounds every border
    theme::apply(value.dark_mode, value.circle_icons, cx);
    let store = cx.new(|_| SettingsStore {
        value,
        dialog_open: false,
    });
    cx.set_global(GlobalSettings(store));
}

impl SettingsStore {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalSettings>().0.clone()
    }

    pub fn get(cx: &App) -> Settings {
        Self::global(cx).read(cx).value.clone()
    }

    /// `settings.value.x = y`: edits, saves and re-themes.
    pub fn update(cx: &mut App, edit: impl FnOnce(&mut Settings)) {
        let store = Self::global(cx);
        let (dark, rounded) = store.update(cx, |store, cx| {
            edit(&mut store.value);
            storage::set("settings", &store.value);
            cx.notify();
            (store.value.dark_mode, store.value.circle_icons)
        });
        theme::apply(dark, rounded, cx);
    }

    pub fn set_dialog_open(open: bool, cx: &mut App) {
        Self::global(cx).update(cx, |store, cx| {
            store.dialog_open = open;
            cx.notify();
        });
    }
}
