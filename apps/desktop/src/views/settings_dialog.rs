// Port of apps/frontend/src/lib/components/settings-dialog.svelte.
use std::{io::Cursor, rc::Rc, sync::Arc, time::Duration};

use gpui_kit::component::{
    ActiveTheme, IndexPath, WindowExt,
    input::{Input, InputEvent, InputState, Textarea, TextareaState},
    popover::Popover,
    radio::Radio,
    searchable_list::SearchableListItem,
    select::{Select, SelectEvent, SelectState},
    slider::{Slider, SliderEvent, SliderState},
    switch::Switch,
};
use serde::Deserialize;
use serde_json::json;

use crate::prelude::*;
use crate::{
    api, notifications,
    state::{
        chat::{Chat, UploadFile},
        notification_settings::NotificationSettings,
        router,
        session::{MfaMethod, Session, SessionUser},
        settings::{NoiseSuppressionModel, Settings, SettingsStore, TimeFormat},
    },
    ui::avatar::{DEFAULT_SPEAKING_RING_COLOR, avatar},
    updater::{self, LaunchPrefs, Status, Updater},
    views::{
        avatar_crop_dialog::{CropOptions, open_avatar_crop, pick_image},
        color_picker::ColorPicker,
        mic_test::{AudioDevices, MicTest, audio_devices},
        settings_devices::SettingsDevices,
        settings_group::settings_group,
        settings_row::settings_row,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Page {
    Account,
    Security,
    Devices,
    Appearance,
    Notifications,
    Voice,
    Language,
    Desktop,
}

/// `pages`: the desktop app always has the "This computer" group.
const PAGES: [(Page, &str, &str, &str); 8] = [
    (Page::Account, "You", "Account", "user"),
    (Page::Security, "You", "Privacy & security", "shield-check"),
    (Page::Devices, "You", "Devices", "smartphone"),
    (Page::Appearance, "App", "Appearance", "palette"),
    (Page::Notifications, "App", "Notifications", "bell"),
    (Page::Voice, "App", "Voice & audio", "volume-2"),
    (Page::Language, "App", "Language & time", "languages"),
    (Page::Desktop, "This computer", "Desktop app", "monitor"),
];

const LANGUAGES: [(&str, &str); 5] =
    [("en", "English"), ("es", "Español"), ("fr", "Français"), ("de", "Deutsch"), ("la", "Latin")];

const TIME_FORMATS: [(TimeFormat, &str, &str); 3] = [
    (TimeFormat::Auto, "Automatic", "Follow your system settings"),
    (TimeFormat::H12, "12-hour", "Example: 3:30 PM"),
    (TimeFormat::H24, "24-hour", "Example: 15:30"),
];

const MISSING_MFA_PASSWORD: &str = "Enter your current password to change two-step verification.";
const ABOUT_MAX: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaTarget {
    Avatar,
    Banner,
}

impl MediaTarget {
    fn name(self) -> &'static str {
        match self {
            Self::Avatar => "avatar",
            Self::Banner => "banner",
        }
    }

    fn crop_options(self) -> CropOptions {
        match self {
            Self::Avatar => CropOptions::default(),
            Self::Banner => CropOptions {
                title: "Crop Profile Banner".into(),
                description: "Adjust the image to fit your profile banner.".into(),
                action_label: "Use Banner".into(),
                output_width: 960,
                output_height: 320,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColorTarget {
    Avatar,
    SpeakingRing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TotpState {
    Idle,
    Setup,
    Enabled,
    Error,
}

/// `{ value, label }` for the selects.
#[derive(Debug, Clone, PartialEq)]
struct Choice {
    value: SharedString,
    label: SharedString,
}

impl SearchableListItem for Choice {
    type Value = SharedString;

    fn title(&self) -> SharedString {
        self.label.clone()
    }

    fn value(&self) -> &SharedString {
        &self.value
    }
}

type ChoiceSelect = Entity<SelectState<Vec<Choice>>>;

/// The default entry first, then each device (unnamed ones get a numbered label).
fn device_choices(default: &str, fallback: &str, devices: &[String]) -> Vec<Choice> {
    std::iter::once(Choice { value: "default".into(), label: default.to_string().into() })
        .chain(devices.iter().enumerate().map(|(index, name)| Choice {
            value: name.clone().into(),
            label: if name.is_empty() { format!("{fallback} {}", index + 1).into() } else { name.clone().into() },
        }))
        .collect()
}

/// `color-mix(in srgb, color 35%, background)`
pub fn mix(color: Hsla, background: Hsla, amount: f32) -> Hsla {
    let (a, b) = (color.to_rgb(), background.to_rgb());
    let channel = |x: f32, y: f32| x * amount + y * (1.0 - amount);
    Rgba { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: 1.0 }.into()
}

/// The `/^\d{6}$/` check before enabling TOTP.
pub fn valid_totp_code(code: &str) -> bool {
    code.len() == 6 && code.chars().all(|c| c.is_ascii_digit())
}

/// `QRCode.toDataURL(uri, { width: 224, margin: 1, errorCorrectionLevel: 'M' })` as a PNG.
pub fn totp_qr_png(uri: &str) -> Option<Vec<u8>> {
    let code = qrcode::QrCode::with_error_correction_level(uri, qrcode::EcLevel::M).ok()?;
    let modules = code.width();
    let dark: Vec<bool> = code.to_colors().into_iter().map(|color| color == qrcode::Color::Dark).collect();
    let scale = (224 / (modules + 2)).max(1) as u32;
    let side = (modules as u32 + 2) * scale;
    let image = image::RgbImage::from_fn(side, side, |x, y| {
        let (column, row) = ((x / scale) as usize, (y / scale) as usize);
        let inside = (1..=modules).contains(&column) && (1..=modules).contains(&row);
        if inside && dark[(row - 1) * modules + column - 1] { image::Rgb([0x11, 0x18, 0x27]) } else { image::Rgb([255, 255, 255]) }
    });
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
    Some(bytes.into_inner())
}

/// The update row's text for each updater status.
pub fn update_message(status: Status, version: Option<&str>, percent: Option<f32>, auto_update: bool) -> String {
    let version = version.unwrap_or_default();
    match status {
        Status::Idle if auto_update => "Novarum checks for updates every 30 minutes.".into(),
        Status::Idle => "Automatic checks are off.".into(),
        Status::Checking => "Checking for updates…".into(),
        Status::Current => "You're on the latest version.".into(),
        Status::Available => format!("Version {version} is available."),
        Status::Downloading => format!("Downloading version {version}… {}%", percent.unwrap_or(0.0).round()),
        Status::Downloaded => format!("Version {version} is ready. Restart Novarum to finish updating."),
        Status::Unsupported => "Updates are only available in installed builds.".into(),
        Status::Error => "Could not update. Try again later.".into(),
    }
}

/// `/dev/video*` names, standing in for the browser's `videoinput` devices.
fn cameras() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/sys/class/video4linux") else { return vec![] };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("name")).ok())
        .map(|name| name.trim().to_string())
        .collect();
    names.sort();
    names.dedup();
    names
}

#[derive(Deserialize)]
struct UserPayload {
    user: SessionUser,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorsPayload {
    avatar_color: String,
    speaking_ring_color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MfaPayload {
    mfa_options: Vec<MfaMethod>,
}

#[derive(Deserialize)]
struct TotpSetup {
    uri: String,
    secret: String,
}

fn spin_icon(name: &str, spinning: bool) -> AnyElement {
    if spinning {
        icon(name)
            .size(px(14.0))
            .with_animation(
                SharedString::from(format!("spin-{name}")),
                Animation::new(Duration::from_secs(1)).repeat(),
                |icon, delta| icon.transform(Transformation::rotate(percentage(delta))),
            )
            .into_any_element()
    } else {
        icon(name).size(px(14.0)).into_any_element()
    }
}

pub struct SettingsDialog {
    page: Page,
    about: Entity<TextareaState>,
    mfa_password: Entity<InputState>,
    totp_code: Entity<InputState>,
    avatar_picker: Entity<ColorPicker>,
    ring_picker: Entity<ColorPicker>,
    color_open: Option<ColorTarget>,
    saved_avatar_color: String,
    saved_speaking_ring: String,
    color_loading: bool,
    color_error: Option<String>,
    media_loading: Option<MediaTarget>,
    media_error: Option<String>,
    about_loading: bool,
    about_error: Option<String>,
    about_saved: bool,
    logout_loading: bool,
    confirm_logout: bool,
    mfa_options: Vec<MfaMethod>,
    mfa_loaded: bool,
    mfa_loading: bool,
    mfa_error: Option<String>,
    email_mfa_loading: bool,
    totp_state: TotpState,
    totp_secret: String,
    totp_qr: Option<Arc<Image>>,
    totp_loading: bool,
    totp_error: Option<String>,
    totp_mfa_loading: bool,
    secret_copied: bool,
    totp_delete_loading: bool,
    confirm_totp_delete: bool,
    push_error: Option<String>,
    push_warning: Option<String>,
    devices: AudioDevices,
    cameras: Vec<String>,
    audio_device_error: Option<String>,
    input_select: ChoiceSelect,
    output_select: ChoiceSelect,
    camera_select: ChoiceSelect,
    model_select: ChoiceSelect,
    language_select: ChoiceSelect,
    volume: Entity<SliderState>,
    noise_level: Entity<SliderState>,
    mic_test: Entity<MicTest>,
    settings_devices: Entity<SettingsDevices>,
    launch_prefs: LaunchPrefs,
    anchor_version: Option<String>,
    _timers: [Option<Task<()>>; 3],
    _subscriptions: Vec<Subscription>,
}

impl SettingsDialog {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let user = Session::user(cx);
        let settings = SettingsStore::get(cx);
        let avatar_color = user.as_ref().and_then(|user| user.avatar_color.clone()).unwrap_or("#6366F1".into());
        let speaking_ring =
            user.as_ref().and_then(|user| user.speaking_ring_color.clone()).unwrap_or(DEFAULT_SPEAKING_RING_COLOR.into());

        let about = cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(4)
                .placeholder("What should people know about you?")
                .default_value(user.as_ref().and_then(|user| user.about.clone()).unwrap_or_default())
        });
        let mfa_password = cx.new(|cx| InputState::new(window, cx).masked(true));
        let totp_code = cx.new(|cx| InputState::new(window, cx).placeholder("000000"));
        let avatar_picker = cx.new(|cx| ColorPicker::new(&avatar_color, window, cx));
        let ring_picker = cx.new(|cx| ColorPicker::new(&speaking_ring, window, cx));

        let choice_select = |items: Vec<Choice>, selected: &str, window: &mut Window, cx: &mut Context<Self>| {
            let index = items.iter().position(|item| item.value == selected).map(|row| IndexPath::default().row(row));
            cx.new(|cx| SelectState::new(items, index, window, cx))
        };
        let input_select = choice_select(device_choices("Default microphone", "Microphone", &[]), &settings.voice_input_device_id, window, cx);
        let output_select = choice_select(device_choices("Default output", "Output device", &[]), &settings.voice_output_device_id, window, cx);
        let camera_select = choice_select(device_choices("Default camera", "Camera", &[]), &settings.video_input_device_id, window, cx);
        let models = [NoiseSuppressionModel::Deepfilternet, NoiseSuppressionModel::Rnnoise]
            .map(|model| Choice { value: model_value(model).into(), label: model.label().into() })
            .to_vec();
        let model_select = choice_select(models, model_value(settings.noise_suppression_model), window, cx);
        let languages =
            LANGUAGES.map(|(value, label)| Choice { value: value.into(), label: label.into() }).to_vec();
        let language_select = choice_select(languages, &settings.language, window, cx);

        let volume = cx.new(|_| SliderState::new().min(0.0).max(1.0).step(0.01).default_value(settings.notification_volume));
        let noise_level =
            cx.new(|_| SliderState::new().min(0.0).max(60.0).step(1.0).default_value(settings.noise_suppression_level));
        let mic_test = cx.new(|_| MicTest::new());
        let this = cx.entity().downgrade();
        let settings_devices = cx.new(|cx| {
            SettingsDevices::new(
                Rc::new(move |_, cx| {
                    let _ = this.update(cx, |dialog, cx| dialog.open_page(Page::Notifications, cx));
                }),
                cx,
            )
        });

        let mut subscriptions = vec![
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Session::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Updater::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&mic_test, |_, _, cx| cx.notify()),
            cx.subscribe(&about, |this, about, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.about_saved = false;
                    let value = about.read(cx).value();
                    if value.chars().count() > ABOUT_MAX {
                        let truncated: String = value.chars().take(ABOUT_MAX).collect();
                        cx.defer(move |cx| {
                            let Some(window) = cx.active_window() else { return };
                            let _ = window.update(cx, |_, window, cx| {
                                about.update(cx, |about, cx| about.set_value(truncated, window, cx));
                            });
                        });
                    }
                    cx.notify();
                }
            }),
            cx.subscribe_in(&totp_code, window, |this, _, event: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.enable_totp(window, cx);
                }
            }),
            cx.subscribe(&volume, |_, _, event: &SliderEvent, cx| {
                if let SliderEvent::Release(value) = event {
                    SettingsStore::update(cx, |settings| settings.notification_volume = value.start());
                    notifications::notification_sound(cx);
                }
            }),
            cx.subscribe(&noise_level, |_, _, event: &SliderEvent, cx| {
                let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
                SettingsStore::update(cx, |settings| settings.noise_suppression_level = value.start());
            }),
        ];
        for (select, edit) in [
            (&input_select, (|settings, value| settings.voice_input_device_id = value) as fn(&mut Settings, String)),
            (&output_select, |settings, value| settings.voice_output_device_id = value),
            (&camera_select, |settings, value| settings.video_input_device_id = value),
            (&language_select, |settings, value| settings.language = value),
            (&model_select, |settings, value| {
                settings.noise_suppression_model = if value == "rnnoise" {
                    NoiseSuppressionModel::Rnnoise
                } else {
                    NoiseSuppressionModel::Deepfilternet
                }
            }),
        ] {
            subscriptions.push(cx.subscribe(select, move |this, _, event: &SelectEvent<Vec<Choice>>, cx| {
                let SelectEvent::Confirm(Some(value)) = event else { return };
                let value = value.to_string();
                this.audio_device_error = None;
                SettingsStore::update(cx, |settings| edit(settings, value));
            }));
        }

        // `refreshAudioDevices`, off the main thread since probing devices can be slow
        cx.spawn_in(window, async move |this, cx| {
            let (devices, cameras) = cx.background_spawn(async { (audio_devices(), cameras()) }).await;
            let _ = this.update_in(cx, |this, window, cx| this.set_devices(devices, cameras, window, cx));
        })
        .detach();
        // `getAnchorInfo(anchor.homeServer)` for the version line
        cx.spawn(async move |this, cx| {
            let info = api::get_anchor_info(api::anchor().home_server).await;
            let _ = this.update(cx, |this, cx| {
                this.anchor_version = info.ok().and_then(|info| info.version);
                cx.notify();
            });
        })
        .detach();

        Self {
            page: Page::Account,
            about,
            mfa_password,
            totp_code,
            avatar_picker,
            ring_picker,
            color_open: None,
            saved_avatar_color: avatar_color,
            saved_speaking_ring: speaking_ring,
            color_loading: false,
            color_error: None,
            media_loading: None,
            media_error: None,
            about_loading: false,
            about_error: None,
            about_saved: false,
            logout_loading: false,
            confirm_logout: false,
            mfa_options: vec![],
            mfa_loaded: false,
            mfa_loading: false,
            mfa_error: None,
            email_mfa_loading: false,
            totp_state: TotpState::Idle,
            totp_secret: String::new(),
            totp_qr: None,
            totp_loading: false,
            totp_error: None,
            totp_mfa_loading: false,
            secret_copied: false,
            totp_delete_loading: false,
            confirm_totp_delete: false,
            push_error: None,
            push_warning: None,
            devices: AudioDevices::default(),
            cameras: vec![],
            audio_device_error: None,
            input_select,
            output_select,
            camera_select,
            model_select,
            language_select,
            volume,
            noise_level,
            mic_test,
            settings_devices,
            launch_prefs: updater::launch_prefs(),
            anchor_version: None,
            _timers: Default::default(),
            _subscriptions: subscriptions,
        }
    }

    fn set_devices(&mut self, devices: AudioDevices, cameras: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let settings = SettingsStore::get(cx);
        let lists = [
            (&self.input_select, device_choices("Default microphone", "Microphone", &devices.input), settings.voice_input_device_id),
            (&self.output_select, device_choices("Default output", "Output device", &devices.output), settings.voice_output_device_id),
            (&self.camera_select, device_choices("Default camera", "Camera", &cameras), settings.video_input_device_id),
        ];
        for (select, items, selected) in lists {
            select.update(cx, |select, cx| {
                select.set_items(items, window, cx);
                select.set_selected_value(&SharedString::from(selected), window, cx);
            });
        }
        self.devices = devices;
        self.cameras = cameras;
        cx.notify();
    }

    fn open_page(&mut self, page: Page, cx: &mut Context<Self>) {
        self.page = page;
        if page == Page::Security && !self.mfa_loaded && !self.mfa_loading && self.mfa_error.is_none() {
            self.load_mfa_status(cx);
        }
        cx.notify();
    }

    /// Clears a "You sure?" after five seconds, like the web's `setTimeout`.
    fn confirm_timeout(&mut self, slot: usize, clear: fn(&mut Self), cx: &mut Context<Self>) {
        self._timers[slot] = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(5)).await;
            let _ = this.update(cx, |this, cx| {
                clear(this);
                cx.notify();
            });
        }));
    }

    // ---- account ----

    fn select_media(&mut self, target: MediaTarget, window: &mut Window, cx: &mut Context<Self>) {
        let picked = pick_image(cx);
        cx.spawn_in(window, async move |this, cx| {
            let picked = picked.await;
            let _ = this.update_in(cx, |this, window, cx| match picked {
                Err(error) => {
                    this.media_error = Some(error);
                    cx.notify();
                }
                Ok(None) => {}
                Ok(Some(file)) => {
                    this.media_error = None;
                    if file.content_type == "image/gif" {
                        this.upload_media(file, target, cx);
                        return;
                    }
                    let weak = cx.entity().downgrade();
                    let on_crop = Rc::new(move |bytes: Vec<u8>, _: &mut Window, cx: &mut App| {
                        let file = UploadFile { name: format!("{}.png", target.name()), content_type: "image/png".into(), bytes };
                        let _ = weak.update(cx, |this, cx| this.upload_media(file, target, cx));
                    });
                    open_avatar_crop(file.bytes, target.crop_options(), on_crop, window, cx);
                }
            });
        })
        .detach();
    }

    fn upload_media(&mut self, file: UploadFile, target: MediaTarget, cx: &mut Context<Self>) {
        self.media_loading = Some(target);
        self.media_error = None;
        cx.notify();
        let name = target.name();
        let file = UploadFile { name: format!("{name}.{}", if file.content_type == "image/gif" { "gif" } else { "png" }), ..file };
        cx.spawn(async move |this, cx| {
            let result = api::post_file::<UserPayload>(format!("/user/{name}"), name, file).await;
            let ok = result.is_ok();
            if let Ok(payload) = result {
                let profile = payload.user.as_public();
                let _ = cx.update(|cx| Chat::global(cx).update(cx, |chat, cx| chat.update_user_profile(&profile, cx)));
                let refresh = cx.update(Session::refresh);
                refresh.await;
            }
            let _ = this.update(cx, |this, cx| {
                if !ok {
                    this.media_error = Some(format!("Could not upload your {name}."));
                }
                this.media_loading = None;
                cx.notify();
            });
        })
        .detach();
    }

    fn save_about(&mut self, cx: &mut Context<Self>) {
        self.about_loading = true;
        self.about_error = None;
        self.about_saved = false;
        cx.notify();
        let about = self.about.read(cx).value().trim().to_string();
        cx.spawn(async move |this, cx| {
            let body = json!({ "about": (!about.is_empty()).then_some(about) });
            let result = api::post::<UserPayload>("/user/about", body).await;
            let ok = result.is_ok();
            if let Ok(payload) = result {
                let profile = payload.user.as_public();
                let _ = cx.update(|cx| Chat::global(cx).update(cx, |chat, cx| chat.update_user_profile(&profile, cx)));
                cx.update(Session::refresh).await;
            }
            let _ = this.update(cx, |this, cx| {
                this.about_loading = false;
                this.about_saved = ok;
                this.about_error = (!ok).then(|| "Could not update your about section.".into());
                cx.notify();
            });
        })
        .detach();
    }

    fn set_color_open(&mut self, target: Option<ColorTarget>, window: &mut Window, cx: &mut Context<Self>) {
        // closing a picker without saving puts the saved color back
        if target.is_none() {
            let (avatar, ring) = (self.saved_avatar_color.clone(), self.saved_speaking_ring.clone());
            self.avatar_picker.update(cx, |picker, cx| picker.set_value(&avatar, window, cx));
            self.ring_picker.update(cx, |picker, cx| picker.set_value(&ring, window, cx));
        }
        self.color_open = target;
        cx.notify();
    }

    fn save_colors(&mut self, cx: &mut Context<Self>) {
        self.color_loading = true;
        self.color_error = None;
        cx.notify();
        let body = json!({
            "avatarColor": self.avatar_picker.read(cx).value().to_uppercase(),
            "speakingRingColor": self.ring_picker.read(cx).value().to_uppercase(),
        });
        cx.spawn(async move |this, cx| {
            let result = api::post::<ColorsPayload>("/user/avatar/color", body).await;
            if let Ok(colors) = &result
                && let Some(user) = cx.update(|cx| Session::user(cx))
            {
                let mut profile = user.as_public();
                profile.avatar_color = Some(colors.avatar_color.clone());
                profile.speaking_ring_color = Some(colors.speaking_ring_color.clone());
                let _ = cx.update(|cx| Chat::global(cx).update(cx, |chat, cx| chat.update_user_profile(&profile, cx)));
                cx.update(Session::refresh).await;
            }
            let _ = this.update(cx, |this, cx| {
                this.color_loading = false;
                match result {
                    Ok(colors) => {
                        this.saved_avatar_color = colors.avatar_color;
                        this.saved_speaking_ring = colors.speaking_ring_color;
                        this.color_open = None;
                    }
                    Err(_) => this.color_error = Some("Could not update your avatar color.".into()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn request_logout(&mut self, cx: &mut Context<Self>) {
        if !self.confirm_logout {
            self.confirm_logout = true;
            self.confirm_timeout(0, |this| this.confirm_logout = false, cx);
            cx.notify();
            return;
        }
        self._timers[0] = None;
        self.confirm_logout = false;
        self.logout_loading = true;
        cx.notify();
        let logout = Session::logout(cx);
        cx.spawn(async move |_, cx| {
            logout.await;
            cx.update(|cx| {
                let home_server = api::anchor().home_server;
                Session::global(cx).update(cx, |session, cx| session.forget(&home_server, cx));
                SettingsStore::set_dialog_open(false, cx);
                router::goto("/login", cx);
            });
        })
        .detach();
    }

    // ---- two-step verification ----

    fn load_mfa_status(&mut self, cx: &mut Context<Self>) {
        self.mfa_loading = true;
        self.mfa_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::get::<MfaPayload>("/auth/mfa").await;
            let _ = this.update(cx, |this, cx| {
                this.mfa_loading = false;
                match result {
                    Err(error) => this.mfa_error = Some(api::error_message(&error.body, "Could not load MFA settings.")),
                    Ok(payload) => {
                        this.mfa_options = payload.mfa_options;
                        this.mfa_loaded = true;
                        if this.mfa_options.contains(&MfaMethod::Totp) {
                            this.totp_state = TotpState::Enabled;
                        } else {
                            this.load_totp_setup(cx);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_totp_setup(&mut self, cx: &mut Context<Self>) {
        self.totp_loading = true;
        self.totp_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::get::<TotpSetup>("/auth/mfa/totp/qr").await;
            let qr = match &result {
                Ok(setup) => {
                    let uri = setup.uri.clone();
                    cx.background_spawn(async move { totp_qr_png(&uri) }).await
                }
                Err(_) => None,
            };
            let _ = this.update(cx, |this, cx| {
                this.totp_loading = false;
                match result {
                    Err(error) => {
                        let message = api::error_message(&error.body, "Could not load MFA settings.");
                        if error.status == 400 && message.contains("already enabled") {
                            this.totp_state = TotpState::Enabled;
                        } else {
                            this.totp_error = Some(message);
                            this.totp_state = TotpState::Error;
                        }
                    }
                    Ok(setup) => match qr {
                        Some(png) => {
                            this.totp_secret = setup.secret;
                            this.totp_qr = Some(Arc::new(Image::from_bytes(ImageFormat::Png, png)));
                            this.totp_state = TotpState::Setup;
                        }
                        None => {
                            this.totp_error = Some("The server returned an invalid MFA setup.".into());
                            this.totp_state = TotpState::Error;
                        }
                    },
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn mfa_password(&self, cx: &App) -> Option<String> {
        Some(self.mfa_password.read(cx).value().to_string()).filter(|password| !password.is_empty())
    }

    /// `toggleEmailMfa` and `toggleTotpMfa`.
    fn toggle_mfa(&mut self, method: MfaMethod, enable: bool, cx: &mut Context<Self>) {
        let Some(password) = self.mfa_password(cx) else {
            self.mfa_error = Some(MISSING_MFA_PASSWORD.into());
            return cx.notify();
        };
        let (path, fallback) = match method {
            MfaMethod::Email => ("/auth/mfa/email/toggle", "Could not update email MFA."),
            MfaMethod::Totp => ("/auth/mfa/totp/toggle", "Could not update authenticator MFA."),
        };
        match method {
            MfaMethod::Email => self.email_mfa_loading = true,
            MfaMethod::Totp => self.totp_mfa_loading = true,
        }
        self.mfa_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::post::<api::Ignored>(path, json!({ "enable": enable, "password": password })).await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Err(error) => this.mfa_error = Some(api::error_message(&error.body, fallback)),
                    Ok(_) => {
                        this.mfa_options.retain(|option| *option != method);
                        if enable {
                            this.mfa_options.push(method);
                        }
                    }
                }
                this.email_mfa_loading = false;
                this.totp_mfa_loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn enable_totp(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let code = self.totp_code.read(cx).value().trim().to_string();
        if !valid_totp_code(&code) {
            self.totp_error = Some("Enter the 6-digit code from your authenticator app.".into());
            return cx.notify();
        }
        let Some(password) = self.mfa_password(cx) else {
            self.totp_error = Some(MISSING_MFA_PASSWORD.into());
            return cx.notify();
        };
        self.totp_loading = true;
        self.totp_error = None;
        cx.notify();
        let body = json!({ "secret": self.totp_secret, "code": code, "password": password });
        cx.spawn_in(_window, async move |this, cx| {
            let result = api::post::<api::Ignored>("/auth/mfa/totp/enable", body).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.totp_loading = false;
                match result {
                    Err(error) => this.totp_error = Some(api::error_message(&error.body, "Could not enable MFA.")),
                    Ok(_) => {
                        this.totp_state = TotpState::Enabled;
                        this.mfa_options.retain(|option| *option != MfaMethod::Totp);
                        this.mfa_options.push(MfaMethod::Totp);
                        this.totp_secret.clear();
                        this.totp_qr = None;
                        this.totp_code.update(cx, |code, cx| code.set_value("", window, cx));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn copy_totp_secret(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(self.totp_secret.clone()));
        self.secret_copied = true;
        self._timers[2] = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let _ = this.update(cx, |this, cx| {
                this.secret_copied = false;
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn request_delete_totp(&mut self, cx: &mut Context<Self>) {
        if !self.confirm_totp_delete {
            self.confirm_totp_delete = true;
            self.confirm_timeout(1, |this| this.confirm_totp_delete = false, cx);
            return cx.notify();
        }
        self._timers[1] = None;
        self.confirm_totp_delete = false;
        let Some(password) = self.mfa_password(cx) else {
            self.mfa_error = Some(MISSING_MFA_PASSWORD.into());
            return cx.notify();
        };
        self.totp_delete_loading = true;
        self.mfa_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::delete_with::<api::Ignored>("/auth/mfa/totp", json!({ "password": password })).await;
            let _ = this.update(cx, |this, cx| {
                this.totp_delete_loading = false;
                match result {
                    Err(error) => {
                        this.mfa_error = Some(api::error_message(&error.body, "Could not remove authenticator MFA."))
                    }
                    Ok(_) => {
                        this.mfa_options.retain(|option| *option != MfaMethod::Totp);
                        this.totp_state = TotpState::Idle;
                        this.load_totp_setup(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // ---- notifications ----

    /// The desktop always may show notifications and has no push service of its own, so turning
    /// them on only tells the server and shows a first notification.
    fn set_push_notifications(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.push_error = None;
        self.push_warning = None;
        SettingsStore::update(cx, |settings| settings.push_notifications = enabled);
        NotificationSettings::save_preferences(Some(enabled), None, cx).detach();
        if enabled {
            notifications::send_notification(
                notifications::NotificationOptions {
                    title: "Novarum notifications enabled".into(),
                    body: None,
                    tag: None,
                    on_click: None,
                },
                cx,
            );
        }
    }

    // ---- rendering ----

    fn head(title: &str, description: &str, cx: &App) -> Div {
        let t = theme::tokens(cx);
        div()
            .mb_2()
            .child(div().text_2xl().font_weight(FontWeight::SEMIBOLD).child(title.to_string()))
            .child(div().mt_1().text_sm().text_color(t.muted_foreground).child(description.to_string()))
    }

    fn switch(
        id: &'static str,
        checked: bool,
        disabled: bool,
        on_change: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Switch {
        Switch::new(id).checked(checked).disabled(disabled).on_click(move |checked, window, cx| on_change(*checked, window, cx))
    }

    fn setting_switch(id: &'static str, checked: bool, edit: fn(&mut Settings, bool)) -> Switch {
        Self::switch(id, checked, false, move |checked, _, cx| SettingsStore::update(cx, |settings| edit(settings, checked)))
    }

    fn render_nav(&self, user: Option<&SessionUser>, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let you = ui::hex(&self.saved_avatar_color).unwrap_or(t.primary);
        let name = user.map(|user| user.name().to_string()).unwrap_or("You".into());
        let handle = user.map(|user| user.handle.clone()).unwrap_or("@you".into());
        let anchor = self.anchor_version.clone().unwrap_or("unknown".into());

        let mut groups = div().id("settings-nav").flex().flex_1().flex_col().gap_3().overflow_y_scroll();
        let mut labels: Vec<&str> = PAGES.iter().map(|page| page.1).collect();
        labels.dedup();
        for label in labels {
            let triggers = PAGES.iter().filter(|page| page.1 == label).map(|&(page, _, title, icon_name)| {
                let active = page == self.page;
                div()
                    .id(title)
                    .relative()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .w_full()
                    .min_h_9()
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(t.radius)
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .text_color(if active { t.foreground } else { t.muted_foreground })
                    .hover(|trigger| trigger.text_color(t.foreground))
                    .when(active, |trigger| {
                        trigger.bg(t.sidebar_accent).child(div().absolute().left_0().top_0().bottom_0().w(px(2.0)).bg(you))
                    })
                    .child(icon(icon_name).size_4())
                    .child(title)
                    .on_click(cx.listener(move |this, _, _, cx| this.open_page(page, cx)))
            });
            groups = groups.child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .flex_col()
                    .gap(px(2.0))
                    .child(div().px_2().pb_1().text_xs().text_color(t.muted_foreground).child(label))
                    .children(triggers),
            );
        }

        div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .w(px(240.0))
            .h_full()
            .gap_3()
            .p_3()
            .bg(t.sidebar)
            .border_r_1()
            .border_color(t.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_2()
                    .py_2()
                    .child(avatar(
                        user.and_then(|user| user.avatar_url.as_deref()),
                        &name,
                        Some(&self.saved_avatar_color),
                        40.0,
                        cx,
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .child(div().truncate().text_sm().font_weight(FontWeight::MEDIUM).child(name))
                            .child(div().truncate().text_xs().text_color(t.muted_foreground).child(handle)),
                    ),
            )
            .child(groups)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .px_2()
                    .text_size(px(11.0))
                    .text_color(t.muted_foreground)
                    .child(format!("Desktop v{} · Anchor {anchor}", env!("CARGO_PKG_VERSION")))
                    .when_some(option_env!("NOVARUM_GIT_COMMIT"), |versions, commit| {
                        let commit = &commit[..commit.len().min(7)];
                        let url = format!("https://github.com/novarumsocial/novarum/commit/{commit}");
                        versions.child(
                            div()
                                .id("commit")
                                .w_full()
                                .font_family(cx.theme().mono_font_family.clone())
                                .underline()
                                .cursor_pointer()
                                .child(commit.to_string())
                                .on_click(move |_, _, cx| crate::desktop::open_url(&url, cx)),
                        )
                    }),
            )
            .child(
                Button::new("logout")
                    .danger()
                    .w_full()
                    .icon(icon("log-out"))
                    .label(if self.confirm_logout { "You sure?" } else { "Log out" })
                    .disabled(self.logout_loading)
                    .on_click(cx.listener(|this, _, _, cx| this.request_logout(cx))),
            )
    }

    fn color_row(&self, target: ColorTarget, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let (picker, id, title, description) = match target {
            ColorTarget::Avatar => {
                (&self.avatar_picker, "avatar-color", "Avatar color", "Shown behind your picture and on your banner.")
            }
            ColorTarget::SpeakingRing => {
                (&self.ring_picker, "speaking-ring", "Speaking ring", "The outline around you while you talk.")
            }
        };
        let color = picker.read(cx).value();
        let weak = cx.entity().downgrade();
        let picker = picker.clone();
        let trigger = Button::new(id).outline().small().child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().size_4().border_1().border_color(black().opacity(0.15)).bg(ui::hex(&color).unwrap_or(t.primary)))
                .child(div().font_family(cx.theme().mono_font_family.clone()).text_xs().child(color.to_uppercase())),
        );
        let popover = Popover::new(SharedString::from(format!("{id}-popover")))
            .anchor(Anchor::TopRight)
            .trigger(trigger)
            .open(self.color_open == Some(target))
            .on_open_change({
                let weak = weak.clone();
                move |open, window, cx| {
                    let _ = weak.update(cx, |this, cx| this.set_color_open(open.then_some(target), window, cx));
                }
            })
            .p_0()
            .content(move |_, _, cx| {
                let t = theme::tokens(cx);
                let Some(this) = weak.upgrade() else { return div().into_any_element() };
                let (loading, error) = {
                    let dialog = this.read(cx);
                    (dialog.color_loading, dialog.color_error.clone())
                };
                let (cancel, save) = (this.clone(), this.clone());
                div()
                    .overflow_hidden()
                    .child(picker.clone())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .border_t_1()
                            .border_color(t.border)
                            .px_3()
                            .py(px(10.0))
                            .child(div().text_xs().text_color(t.destructive).child(error.unwrap_or_default()))
                            .child(
                                div()
                                    .flex()
                                    .gap_2()
                                    .child(Button::new("color-cancel").ghost().small().label("Cancel").disabled(loading).on_click(
                                        move |_, window, cx| cancel.update(cx, |this, cx| this.set_color_open(None, window, cx)),
                                    ))
                                    .child(
                                        Button::new("color-save")
                                            .primary()
                                            .small()
                                            .label(if loading { "Saving…" } else { "Save colors" })
                                            .disabled(loading)
                                            .on_click(move |_, _, cx| save.update(cx, |this, cx| this.save_colors(cx))),
                                    ),
                            ),
                    )
                    .into_any_element()
            });
        settings_row(title, Some(description.into()), false, popover, cx)
    }

    fn render_account(&self, user: Option<&SessionUser>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let selected = self.avatar_picker.read(cx).value();
        let color = ui::hex(&selected).unwrap_or(t.primary);
        let name = user.map(|user| user.name().to_string());
        let handle = user.map(|user| user.handle.clone()).unwrap_or("@you".into());
        let busy = self.media_loading.is_some();
        let banner_image = user.and_then(|user| user.banner_url.clone()).and_then(|url| ui::image::remote_img(&url, cx));
        let about_length = self.about.read(cx).value().chars().count();

        let banner = div()
            .id("banner")
            .group("banner")
            .relative()
            .h_32()
            .overflow_hidden()
            .bg(linear_gradient(125.0, linear_color_stop(color, 0.0), linear_color_stop(mix(color, t.background, 0.35), 1.0)))
            .children(banner_image.map(|image| image.object_fit(ObjectFit::Cover)))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(white())
                    .when(!busy, |overlay| overlay.cursor_pointer().group_hover("banner", |overlay| overlay.bg(black().opacity(0.45))))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .when(self.media_loading != Some(MediaTarget::Banner), |label| {
                                label.opacity(0.0).group_hover("banner", |label| label.opacity(1.0))
                            })
                            .child(icon("camera").size_4())
                            .child(if self.media_loading == Some(MediaTarget::Banner) { "Uploading…" } else { "Change banner" }),
                    ),
            )
            .when(!busy, |banner| {
                banner.on_click(cx.listener(|this, _, window, cx| this.select_media(MediaTarget::Banner, window, cx)))
            });

        let picture = div()
            .id("avatar")
            .group("avatar")
            .relative()
            .mt(px(-40.0))
            .size_20()
            .flex_shrink_0()
            .overflow_hidden()
            .border_4()
            .border_color(t.card)
            .bg(color)
            .when(circle, |picture| picture.rounded_full())
            .child(avatar(
                user.and_then(|user| user.avatar_url.as_deref()),
                name.as_deref().unwrap_or("?"),
                Some(&selected),
                72.0,
                cx,
            ))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(white())
                    .when(!busy, |overlay| overlay.cursor_pointer().group_hover("avatar", |overlay| overlay.bg(black().opacity(0.55))))
                    .child(div().opacity(0.0).group_hover("avatar", |camera| camera.opacity(1.0)).child(icon("camera").size_5())),
            )
            .when(!busy, |picture| {
                picture.on_click(cx.listener(|this, _, window, cx| this.select_media(MediaTarget::Avatar, window, cx)))
            });

        let profile = div()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(t.card)
            .child(banner)
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_4()
                    .px_4()
                    .pb_4()
                    .child(picture)
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .pt_3()
                            .child(div().truncate().text_base().font_weight(FontWeight::SEMIBOLD).child(name.clone().unwrap_or("Your profile".into())))
                            .child(div().truncate().text_xs().text_color(t.muted_foreground).child(handle)),
                    ),
            )
            .when_some(self.media_error.clone(), |profile, error| {
                profile.child(div().px_4().pb_3().text_xs().text_color(t.destructive).child(error))
            });

        let about = div()
            .child(div().text_sm().child(Textarea::new(&self.about).appearance(false).px_4().py(px(14.0))))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .px_4()
                    .pb_3()
                    .child(match &self.about_error {
                        Some(error) => div().text_xs().text_color(t.destructive).child(error.clone()),
                        None => div().text_xs().text_color(t.muted_foreground).child(format!("{about_length}/{ABOUT_MAX}")),
                    })
                    .child(
                        Button::new("save-about")
                            .primary()
                            .small()
                            .disabled(self.about_loading)
                            .label(if self.about_loading {
                                "Saving…"
                            } else if self.about_saved {
                                "Saved"
                            } else {
                                "Save about"
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.save_about(cx))),
                    ),
            );

        let detail = |value: Option<String>| {
            div().max_w_48().truncate().text_sm().text_color(t.muted_foreground).child(value.unwrap_or_default())
        };
        vec![
            Self::head("Account", "How you appear to everyone on Novarum.", cx).into_any_element(),
            profile.into_any_element(),
            settings_group(Some("About me"), None, [about.into_any_element()], cx).into_any_element(),
            settings_group(
                Some("Colors"),
                Some("Used for your avatar and when you speak in voice."),
                [self.color_row(ColorTarget::Avatar, cx), self.color_row(ColorTarget::SpeakingRing, cx)],
                cx,
            )
            .into_any_element(),
            settings_group(
                Some("Sign-in details"),
                None,
                [
                    settings_row("Display name", None, false, detail(user.and_then(|user| user.display_name.clone())), cx),
                    settings_row(
                        "Email address",
                        Some("Only visible to you.".into()),
                        false,
                        detail(user.and_then(|user| user.email.clone())),
                        cx,
                    ),
                ],
                cx,
            )
            .into_any_element(),
        ]
    }

    fn mfa_badge(enabled: bool, icon_name: &str, cx: &App) -> Div {
        let t = theme::tokens(cx);
        let emerald = if SettingsStore::get(cx).dark_mode { rgb(0x34d399) } else { rgb(0x059669) };
        div()
            .flex()
            .size_8()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .when(enabled, |badge| badge.bg(Hsla::from(rgb(0x10b981)).opacity(0.15)).text_color(emerald))
            .when(!enabled, |badge| badge.bg(t.muted).text_color(t.muted_foreground))
            .child(icon(icon_name).size_4())
    }

    fn mfa_text(title: &str, description: &str, cx: &App) -> Div {
        div()
            .min_w_0()
            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title.to_string()))
            .child(div().mt(px(2.0)).text_xs().text_color(theme::tokens(cx).muted_foreground).child(description.to_string()))
    }

    fn render_totp(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let totp_enabled = self.mfa_options.contains(&MfaMethod::Totp);
        match self.totp_state {
            TotpState::Idle if self.totp_loading => div()
                .flex()
                .min_h_20()
                .items_center()
                .justify_center()
                .gap_2()
                .px_4()
                .py_4()
                .child(ui::spinner("totp-preparing"))
                .child(div().text_xs().text_color(t.muted_foreground).child("Preparing authenticator setup..."))
                .into_any_element(),
            TotpState::Enabled => {
                let busy = self.totp_mfa_loading || self.totp_delete_loading;
                let delete = Button::new("delete-totp")
                    .outline()
                    .xsmall()
                    .disabled(busy)
                    .when(self.confirm_totp_delete, |button| {
                        button.border_color(t.destructive).text_color(t.destructive).label("?").icon(icon("trash-2"))
                    })
                    .when(!self.confirm_totp_delete, |button| button.icon(icon("trash-2")))
                    .loading(self.totp_delete_loading)
                    .on_click(cx.listener(|this, _, _, cx| this.request_delete_totp(cx)));
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .px_4()
                    .py_3()
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .items_start()
                            .gap_3()
                            .child(Self::mfa_badge(totp_enabled, "shield-check", cx))
                            .child(Self::mfa_text("Authenticator app", "One-time codes from your authenticator app.", cx)),
                    )
                    .child(
                        div().flex().flex_shrink_0().items_center().gap_4().child(delete).child(
                            Switch::new("totp-mfa").checked(totp_enabled).disabled(busy).on_click(cx.listener(
                                |this, checked: &bool, _, cx| this.toggle_mfa(MfaMethod::Totp, *checked, cx),
                            )),
                        ),
                    )
                    .into_any_element()
            }
            TotpState::Setup => {
                let mono = cx.theme().mono_font_family.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap_4()
                    .px_4()
                    .py_4()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(icon("smartphone").size_4())
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Set up an authenticator app")),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_4()
                            .child(div().flex_shrink_0().bg(white()).p_2().children(self.totp_qr.clone().map(|qr| img(qr).size_40())))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .flex_1()
                                    .min_w_0()
                                    .gap_2()
                                    .child(
                                        div()
                                            .child(div().text_xs().font_weight(FontWeight::MEDIUM).child("Can't scan it?"))
                                            .child(
                                                div()
                                                    .text_size(px(11.0))
                                                    .text_color(t.muted_foreground)
                                                    .child("Enter this setup key manually. Keep it private."),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .id("totp-secret")
                                            .group("secret")
                                            .flex()
                                            .border_1()
                                            .border_color(t.border)
                                            .bg(t.muted.opacity(0.4))
                                            .child(
                                                // the web blurs the key until you point at it
                                                div()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .px(px(10.0))
                                                    .py_2()
                                                    .font_family(mono)
                                                    .text_size(px(11.0))
                                                    .text_color(t.foreground.opacity(0.15))
                                                    .group_hover("secret", |code| code.text_color(t.foreground))
                                                    .child(self.totp_secret.clone()),
                                            )
                                            .child(
                                                Button::new("copy-secret")
                                                    .ghost()
                                                    .h_auto()
                                                    .border_l_1()
                                                    .border_color(t.border)
                                                    .icon(icon(if self.secret_copied { "check" } else { "copy" }))
                                                    .on_click(cx.listener(|this, _, _, cx| this.copy_totp_secret(cx))),
                                            ),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.0))
                                    .child(ui::label("Verification code"))
                                    .child(
                                        div()
                                            .flex()
                                            .gap_2()
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .font_family(cx.theme().mono_font_family.clone())
                                                    .child(Input::new(&self.totp_code).h_9()),
                                            )
                                            .child(
                                                Button::new("enable-totp")
                                                    .primary()
                                                    .h_9()
                                                    .loading(self.totp_loading)
                                                    .disabled(self.totp_loading)
                                                    .label("Enable MFA")
                                                    .on_click(cx.listener(|this, _, window, cx| this.enable_totp(window, cx))),
                                            ),
                                    ),
                            )
                            .child(
                                div().min_h_4().text_xs().text_color(t.destructive).child(self.totp_error.clone().unwrap_or_default()),
                            ),
                    )
                    .into_any_element()
            }
            _ => div()
                .flex()
                .items_center()
                .justify_between()
                .gap_4()
                .px_4()
                .py_3()
                .child(
                    div()
                        .min_w_0()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Authenticator app"))
                        .child(div().mt(px(2.0)).text_xs().text_color(t.destructive).child(
                            self.totp_error.clone().unwrap_or("Could not prepare authenticator setup.".into()),
                        )),
                )
                .child(
                    Button::new("retry-totp")
                        .outline()
                        .xsmall()
                        .label("Try again")
                        .on_click(cx.listener(|this, _, _, cx| this.load_totp_setup(cx))),
                )
                .into_any_element(),
        }
    }

    fn render_security(&self, settings: &Settings, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let t = theme::tokens(cx);
        let mut sections = vec![
            Self::head("Privacy & security", "Protect your account and choose what others can see.", cx).into_any_element(),
            settings_group(
                Some("Privacy"),
                None,
                [settings_row(
                    "Show online status",
                    Some("Let people see when you're online.".into()),
                    false,
                    Self::setting_switch("online-status", settings.show_online_status, |s, v| s.show_online_status = v),
                    cx,
                )],
                cx,
            )
            .into_any_element(),
        ];
        if self.mfa_loading && !self.mfa_loaded {
            sections.push(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(ui::spinner("mfa-loading"))
                    .child(div().text_xs().text_color(t.muted_foreground).child("Checking MFA status..."))
                    .into_any_element(),
            );
        } else if !self.mfa_loaded {
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_2()
                    .child(
                        div()
                            .min_w_0()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("MFA settings are unavailable"))
                            .child(div().mt_1().text_xs().text_color(t.destructive).child(
                                self.mfa_error.clone().unwrap_or("Could not load MFA settings.".into()),
                            )),
                    )
                    .child(
                        Button::new("retry-mfa")
                            .outline()
                            .xsmall()
                            .label("Try again")
                            .on_click(cx.listener(|this, _, _, cx| this.load_mfa_status(cx))),
                    )
                    .into_any_element(),
            );
        } else {
            let email_enabled = self.mfa_options.contains(&MfaMethod::Email);
            let mut rows = vec![
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .px_4()
                    .py_3()
                    .child(ui::label("Current password"))
                    .child(Input::new(&self.mfa_password).h_9())
                    .child(div().text_xs().text_color(t.muted_foreground).child("Needed to change two-step verification."))
                    .into_any_element(),
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .px_4()
                    .py_3()
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .items_start()
                            .gap_3()
                            .child(Self::mfa_badge(email_enabled, "mail", cx))
                            .child(Self::mfa_text("Email codes", "A one-time code sent to your account email.", cx)),
                    )
                    .child(Switch::new("email-mfa").checked(email_enabled).disabled(self.email_mfa_loading).on_click(
                        cx.listener(|this, checked: &bool, _, cx| this.toggle_mfa(MfaMethod::Email, *checked, cx)),
                    ))
                    .into_any_element(),
                self.render_totp(cx),
            ];
            if let Some(error) = &self.mfa_error {
                rows.push(div().px_4().py_2().text_xs().text_color(t.destructive).child(error.clone()).into_any_element());
            }
            sections.push(
                settings_group(Some("Two-step verification"), Some("Ask for a second code when you sign in."), rows, cx)
                    .into_any_element(),
            );
        }
        sections
    }

    fn render_appearance(&self, settings: &Settings, cx: &mut Context<Self>) -> Vec<AnyElement> {
        vec![
            Self::head("Appearance", "Make Novarum look the way you like.", cx).into_any_element(),
            settings_group(
                Some("Theme"),
                None,
                [
                    settings_row(
                        "Dark mode",
                        Some("Use the dark color scheme.".into()),
                        false,
                        Self::setting_switch("dark-mode", settings.dark_mode, |s, v| s.dark_mode = v),
                        cx,
                    ),
                    settings_row(
                        "Round icons",
                        Some("Show avatars and server icons as circles instead of squares.".into()),
                        false,
                        Self::setting_switch("circle-icons", settings.circle_icons, |s, v| s.circle_icons = v),
                        cx,
                    ),
                ],
                cx,
            )
            .into_any_element(),
            settings_group(
                Some("Layout"),
                None,
                [
                    settings_row(
                        "Show member list",
                        Some("Display the member sidebar in channels.".into()),
                        false,
                        Self::setting_switch("member-list", settings.show_member_list, |s, v| s.show_member_list = v),
                        cx,
                    ),
                    settings_row(
                        "Compact mode",
                        Some("Reduce spacing between messages. Coming soon.".into()),
                        false,
                        Self::setting_switch("compact-mode", settings.compact_mode, |s, v| s.compact_mode = v).disabled(true),
                        cx,
                    ),
                ],
                cx,
            )
            .into_any_element(),
        ]
    }

    fn render_notifications(&self, settings: &Settings, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let t = theme::tokens(cx);
        let mut alerts = vec![
            settings_row(
                "Push notifications",
                Some("Get notified about mentions and replies.".into()),
                false,
                Switch::new("push")
                    .checked(settings.push_notifications)
                    .on_click(cx.listener(|this, checked: &bool, _, cx| this.set_push_notifications(*checked, cx))),
                cx,
            ),
            settings_row(
                "Message preview",
                Some("Show the message text in notifications.".into()),
                false,
                Self::switch("preview", settings.message_preview, false, |enabled, _, cx| {
                    // the server decides what a push contains, so it needs to know about this one too
                    SettingsStore::update(cx, |settings| settings.message_preview = enabled);
                    NotificationSettings::save_preferences(None, Some(enabled), cx).detach();
                }),
                cx,
            ),
        ];
        if let Some(warning) = &self.push_warning {
            alerts.push(div().px_4().py_2().text_xs().text_color(rgb(0xf59e0b)).child(warning.clone()).into_any_element());
        }
        if let Some(error) = &self.push_error {
            alerts.push(div().px_4().py_2().text_xs().text_color(t.destructive).child(error.clone()).into_any_element());
        }
        vec![
            Self::head("Notifications", "Choose how Novarum gets your attention.", cx).into_any_element(),
            settings_group(Some("Alerts"), None, alerts, cx).into_any_element(),
            settings_group(
                Some("Sound"),
                None,
                [
                    settings_row(
                        "Mention sound",
                        Some("Play a sound when someone mentions you.".into()),
                        false,
                        Self::setting_switch("mention-sound", settings.mention_sound, |s, v| s.mention_sound = v),
                        cx,
                    ),
                    settings_row("Volume", None, true, Slider::new(&self.volume), cx),
                ],
                cx,
            )
            .into_any_element(),
        ]
    }

    fn render_voice(&self, settings: &Settings, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let t = theme::tokens(cx);
        let testing = self.mic_test.read(cx).testing();
        let mut devices = vec![
            settings_row("Microphone", None, true, Select::new(&self.input_select).w_full().placeholder("Unknown microphone"), cx),
            settings_row("Speakers", None, true, Select::new(&self.output_select).w_full().placeholder("Unknown output"), cx),
            settings_row("Camera", None, true, Select::new(&self.camera_select).w_full().placeholder("Unknown camera"), cx),
        ];
        if let Some(error) = &self.audio_device_error {
            devices.push(div().px_4().py_2().text_xs().text_color(t.destructive).child(error.clone()).into_any_element());
        }

        let mut processing = vec![
            settings_row(
                "Echo cancellation",
                Some("Turn off if it interferes with noise suppression.".into()),
                false,
                Self::setting_switch("echo", settings.voice_echo_cancellation, |s, v| s.voice_echo_cancellation = v),
                cx,
            ),
            settings_row(
                "Automatic gain control",
                Some("Keep your microphone volume steady.".into()),
                false,
                Self::setting_switch("agc", settings.voice_auto_gain_control, |s, v| s.voice_auto_gain_control = v),
                cx,
            ),
            settings_row(
                "Noise suppression",
                Some("Reduce background noise.".into()),
                false,
                Self::setting_switch("noise", settings.noise_cancellation, |s, v| s.noise_cancellation = v).disabled(testing),
                cx,
            ),
            settings_row(
                "Noise suppression model",
                Some("DeepFilterNet removes more noise; RNNoise is lighter on your CPU.".into()),
                false,
                Select::new(&self.model_select).w_40().disabled(testing),
                cx,
            ),
        ];
        if settings.noise_suppression_model == NoiseSuppressionModel::Deepfilternet {
            processing.push(settings_row(
                "Automatic strength",
                Some("Adjusts to how noisy your room is.".into()),
                false,
                Self::setting_switch("noise-auto", settings.noise_suppression_auto, |s, v| s.noise_suppression_auto = v),
                cx,
            ));
            if !settings.noise_suppression_auto {
                processing.push(settings_row(
                    "Noise suppression strength",
                    Some("Higher removes more noise but can make your voice sound muffled.".into()),
                    true,
                    Slider::new(&self.noise_level),
                    cx,
                ));
            }
        }
        processing.push(settings_row(
            "Mic test",
            Some("Hear yourself with your current settings.".into()),
            true,
            self.mic_test.clone(),
            cx,
        ));

        vec![
            Self::head("Voice & audio", "Pick your devices and how your voice is processed.", cx).into_any_element(),
            settings_group(Some("Devices"), None, devices, cx).into_any_element(),
            settings_group(Some("Voice processing"), None, processing, cx).into_any_element(),
            settings_group(
                Some("Screen sharing"),
                None,
                [settings_row(
                    "Share system audio",
                    Some("Include your computer's sound when you share your screen.".into()),
                    false,
                    Self::setting_switch("system-audio", settings.screen_share_system_audio, |s, v| {
                        s.screen_share_system_audio = v
                    }),
                    cx,
                )],
                cx,
            )
            .into_any_element(),
            settings_group(
                Some("Sound effects"),
                None,
                [settings_row(
                    "Others' sound effects",
                    Some("Play a sound when others join, leave, mute, or turn on their camera or screen.".into()),
                    false,
                    Self::setting_switch("others-call-sounds", settings.others_call_sounds, |s, v| s.others_call_sounds = v),
                    cx,
                )],
                cx,
            )
            .into_any_element(),
        ]
    }

    fn render_language(&self, settings: &Settings, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let t = theme::tokens(cx);
        let formats = TIME_FORMATS.map(|(format, label, example)| {
            div()
                .id(label)
                .flex()
                .items_center()
                .justify_between()
                .gap_4()
                .px_4()
                .py_3()
                .cursor_pointer()
                .child(
                    div()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(label))
                        .child(div().mt(px(2.0)).text_xs().text_color(t.muted_foreground).child(example)),
                )
                .child(
                    Radio::new(SharedString::from(format!("time-{label}")))
                        .checked(settings.time_format == format)
                        .on_click(move |_, _, cx| SettingsStore::update(cx, |settings| settings.time_format = format)),
                )
                .on_click(move |_, _, cx| SettingsStore::update(cx, |settings| settings.time_format = format))
                .into_any_element()
        });
        vec![
            Self::head("Language & time", "Set your language and how times are shown.", cx).into_any_element(),
            settings_group(
                Some("Language"),
                None,
                [settings_row(
                    "Display language",
                    None,
                    true,
                    Select::new(&self.language_select).w_full().placeholder("Select language"),
                    cx,
                )],
                cx,
            )
            .into_any_element(),
            settings_group(Some("Time format"), None, formats, cx).into_any_element(),
        ]
    }

    fn set_launch_pref(&mut self, edit: impl FnOnce(&mut LaunchPrefs), cx: &mut Context<Self>) {
        edit(&mut self.launch_prefs);
        updater::set_launch_prefs(self.launch_prefs);
        cx.notify();
    }

    fn render_desktop(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let prefs = self.launch_prefs;
        let update = Updater::status(cx);
        let message = update_message(update.status, update.version.as_deref(), update.percent, prefs.auto_update);
        let busy = matches!(update.status, Status::Checking | Status::Downloading);
        let action = match update.status {
            Status::Downloaded => Button::new("install-update")
                .primary()
                .small()
                .icon(icon("rotate-cw"))
                .label("Restart to update")
                .on_click(|_, _, cx| Updater::install(cx)),
            Status::Available => Button::new("download-update")
                .primary()
                .small()
                .icon(icon("download"))
                .label("Download update")
                .on_click(|_, _, cx| Updater::download(cx).detach()),
            _ => Button::new("check-updates")
                .outline()
                .small()
                .disabled(busy)
                .child(div().flex().items_center().gap_2().child(spin_icon("refresh-cw", busy)).child("Check for updates"))
                .on_click(|_, _, cx| {
                    Updater::check(cx).detach();
                }),
        };
        vec![
            Self::head("Desktop app", "How Novarum behaves on this computer.", cx).into_any_element(),
            settings_group(
                Some("Startup"),
                None,
                [
                    settings_row(
                        "Launch at startup",
                        Some("Open Novarum when you log in to your computer.".into()),
                        false,
                        Switch::new("auto-launch").checked(prefs.auto_launch).on_click(cx.listener(
                            |this, checked: &bool, _, cx| this.set_launch_pref(|prefs| prefs.auto_launch = *checked, cx),
                        )),
                        cx,
                    ),
                    settings_row(
                        "Start in the background",
                        Some("Keep the window hidden in the tray when Novarum launches at startup.".into()),
                        false,
                        Switch::new("start-hidden").checked(prefs.start_hidden).disabled(!prefs.auto_launch).on_click(
                            cx.listener(|this, checked: &bool, _, cx| {
                                this.set_launch_pref(|prefs| prefs.start_hidden = *checked, cx)
                            }),
                        ),
                        cx,
                    ),
                ],
                cx,
            )
            .into_any_element(),
            settings_group(
                Some("Updates"),
                None,
                [
                    settings_row(
                        "Update automatically",
                        Some("Download new versions in the background and install them when Novarum restarts.".into()),
                        false,
                        Switch::new("auto-update").checked(prefs.auto_update).on_click(cx.listener(
                            |this, checked: &bool, _, cx| this.set_launch_pref(|prefs| prefs.auto_update = *checked, cx),
                        )),
                        cx,
                    ),
                    settings_row(format!("Novarum Desktop v{}", env!("CARGO_PKG_VERSION")), Some(message.into()), false, action, cx),
                ],
                cx,
            )
            .into_any_element(),
        ]
    }
}

fn model_value(model: NoiseSuppressionModel) -> &'static str {
    match model {
        NoiseSuppressionModel::Deepfilternet => "deepfilternet",
        NoiseSuppressionModel::Rnnoise => "rnnoise",
    }
}

impl Render for SettingsDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let user = Session::user(cx);
        let settings = SettingsStore::get(cx);
        let height = (f32::from(window.viewport_size().height) * 0.88).min(680.0);
        let sections = match self.page {
            Page::Account => self.render_account(user.as_ref(), cx),
            Page::Security => self.render_security(&settings, cx),
            Page::Devices => vec![
                Self::head("Devices", "Phones that get your notifications.", cx).into_any_element(),
                self.settings_devices.clone().into_any_element(),
            ],
            Page::Appearance => self.render_appearance(&settings, cx),
            Page::Notifications => self.render_notifications(&settings, cx),
            Page::Voice => self.render_voice(&settings, cx),
            Page::Language => self.render_language(&settings, cx),
            Page::Desktop => self.render_desktop(cx),
        };
        div()
            .flex()
            .w_full()
            .h(px(height))
            .min_w_0()
            .bg(theme::tokens(cx).background)
            .child(self.render_nav(user.as_ref(), cx))
            .child(
                div()
                    .id("settings-page")
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_8()
                    .child(div().mx_auto().max_w(px(576.0)).flex().flex_col().gap_6().children(sections)),
            )
    }
}

struct Shown(bool);
impl Global for Shown {}

/// Opens the dialog whenever `settingsDialog.open` turns true, and closes it when it turns false.
/// The shell calls this once and keeps the subscription.
pub fn watch<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Subscription {
    cx.observe_in(&SettingsStore::global(cx), window, |_, store, window, cx| {
        let open = store.read(cx).dialog_open;
        let shown = cx.try_global::<Shown>().is_some_and(|shown| shown.0);
        if open && !shown {
            cx.set_global(Shown(true));
            let view = cx.new(|cx| SettingsDialog::new(window, cx));
            window.open_dialog(cx, move |dialog, _, _| {
                dialog.w(px(896.0)).p_0().child(view.clone()).on_close(|_, _, cx| {
                    cx.set_global(Shown(false));
                    SettingsStore::set_dialog_open(false, cx);
                })
            });
        } else if !open && shown {
            cx.set_global(Shown(false));
            window.close_dialog(cx);
        }
    })
}

#[cfg(test)]
mod tests {
    use gpui_kit::{Hsla, rgb};

    use super::{device_choices, mix, totp_qr_png, update_message, valid_totp_code};
    use crate::updater::Status;

    #[test]
    fn checks_totp_codes() {
        assert!(valid_totp_code("012345"));
        assert!(!valid_totp_code("12345"));
        assert!(!valid_totp_code("12345a"));
        assert!(!valid_totp_code("1234567"));
    }

    #[test]
    fn renders_a_scannable_size_qr_code() {
        let png = totp_qr_png("otpauth://totp/Novarum:ana?secret=JBSWY3DPEHPK3PXP&issuer=Novarum").unwrap();
        let image = image::load_from_memory(&png).unwrap();
        assert!(image.width() >= 200 && image.width() <= 224);
        assert_eq!(image.width(), image.height());
    }

    #[test]
    fn mixes_colors_in_srgb() {
        let mixed = mix(rgb(0xffffff).into(), rgb(0x000000).into(), 0.35).to_rgb();
        assert!((mixed.r - 0.35).abs() < 0.01);
        let same: Hsla = rgb(0x005f78).into();
        assert!((mix(same, same, 0.35).to_rgb().g - same.to_rgb().g).abs() < 0.01);
    }

    #[test]
    fn lists_devices_after_the_default() {
        let choices = device_choices("Default microphone", "Microphone", &["USB".into(), String::new()]);
        assert_eq!(choices[0].value, "default");
        assert_eq!(choices[1].label, "USB");
        assert_eq!(choices[2].label, "Microphone 2");
    }

    #[test]
    fn describes_each_update_status() {
        assert_eq!(update_message(Status::Idle, None, None, false), "Automatic checks are off.");
        assert_eq!(update_message(Status::Downloading, Some("1.2.0"), Some(41.6), true), "Downloading version 1.2.0… 42%");
        assert_eq!(update_message(Status::Available, Some("1.2.0"), None, true), "Version 1.2.0 is available.");
    }
}
