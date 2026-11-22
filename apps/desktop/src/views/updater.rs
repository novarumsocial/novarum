// Port of apps/frontend/src/routes/updater/+page.svelte: the launch splash. A faint novarum logo
// lights up as the update comes in: the ground lines from the middle out, then the sun rises
// into place and its rays come out.
use std::time::{Duration, Instant};

use crate::prelude::*;

use crate::{
    theme,
    updater::{Status, Updater},
};

const SUN: &str = "M8 12a4 4 0 0 1 8 0";
const GROUND: [&str; 2] = ["M2 16h20", "M6 20h12"];
const RAYS: [&str; 5] = [
    "M4 12h1",
    "M6.343 6.343l.707.707",
    "M12 4v1",
    "M17.657 6.343l-.707.707",
    "M20 12h-1",
];

fn svg_doc(paths: &[&str], extra: &str) -> String {
    let body: String = paths.iter().map(|d| format!(r#"<path d="{d}" {extra}/>"#)).collect();
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round">{body}</svg>"#
    )
}

/// The ground lines drawn from the middle out to `progress`.
fn ground_doc(progress: f32) -> String {
    let lines: String = [(2.0, 22.0, 16.0), (6.0, 18.0, 20.0)]
        .iter()
        .map(|(x1, x2, y)| {
            let mid = (x1 + x2) / 2.0;
            let half = (x2 - x1) / 2.0 * progress;
            format!(r#"<path d="M{} {y}H{}"/>"#, mid - half, mid + half)
        })
        .collect();
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round">{lines}</svg>"#
    )
}

pub struct UpdaterView {
    /// The tweened progress (700ms cubicOut), and where the tween started.
    from: f32,
    to: f32,
    started: Instant,
    lit_at: Option<Instant>,
    _updater: Subscription,
}

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

impl UpdaterView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let updater = Updater::global(cx);
        let _updater = cx.observe(&updater, |this: &mut Self, _, cx| {
            let target = Self::target(cx);
            if target != this.to {
                this.from = this.progress();
                this.to = target;
                this.started = Instant::now();
            }
            cx.notify();
        });
        Self { from: 0.0, to: Self::target(cx), started: Instant::now(), lit_at: None, _updater }
    }

    fn target(cx: &App) -> f32 {
        let status = Updater::status(cx);
        match status.status {
            Status::Idle | Status::Checking | Status::Available => 0.0,
            Status::Downloading => status.percent.unwrap_or(0.0) / 100.0,
            _ => 1.0,
        }
    }

    fn progress(&self) -> f32 {
        let t = (self.started.elapsed().as_secs_f32() / 0.7).min(1.0);
        self.from + (self.to - self.from) * ease_out_cubic(t)
    }
}

impl Render for UpdaterView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let update = Updater::status(cx);
        let progress = self.progress();
        let animating = progress != self.to;
        let lit = progress >= 1.0;
        if lit && self.lit_at.is_none() {
            self.lit_at = Some(Instant::now());
        }
        let checking = matches!(update.status, Status::Idle | Status::Checking);
        let since_lit = self.lit_at.map(|at| at.elapsed().as_secs_f32() * 1000.0);
        let version = update.version.clone().unwrap_or_default();
        let (title, detail) = match update.status {
            Status::Idle | Status::Checking => ("Checking for updates".to_string(), String::new()),
            Status::Available => ("Update found".into(), format!("Version {version}")),
            Status::Downloading => (
                format!("Downloading version {version}"),
                format!("{}%", update.percent.unwrap_or(0.0).round()),
            ),
            Status::Downloaded => (format!("Installing version {version}"), "Novarum will reopen by itself".into()),
            _ => ("Starting Novarum".into(), String::new()),
        };

        // breathe: the ghost logo pulses between 15% and 30% while checking
        let ghost_opacity = if checking {
            let phase = (self.started.elapsed().as_secs_f32() / 1.4) % 2.0;
            let wave = if phase < 1.0 { phase } else { 2.0 - phase };
            0.15 + 0.15 * (0.5 - 0.5 * (wave * std::f32::consts::PI).cos())
        } else {
            0.15
        };
        // the sun fades in over 300ms, and each ray 200 + i * 70 ms later
        let fade = |delay: f32| since_lit.map_or(0.0, |ms| ((ms - delay) / 300.0).clamp(0.0, 1.0));
        let still_lighting = since_lit.is_some_and(|ms| ms < 200.0 + 4.0 * 70.0 + 500.0);
        if animating || checking || still_lighting {
            window.request_animation_frame();
        }

        let sun_fade = fade(0.0);
        let sun_rise = 1.5 * (1.0 - since_lit.map_or(0.0, |ms| ease_out_cubic((ms / 500.0).min(1.0))));
        let mut logo = div()
            .relative()
            .size(px(112.0))
            .child(svg_layer(svg_doc(&[&[SUN][..], &RAYS[..], &GROUND[..]].concat(), ""), ghost_opacity, 0.0, 1.0, t.foreground))
            .when(progress > 0.01, |logo| logo.child(svg_layer(ground_doc(progress), 1.0, 0.0, 1.0, t.foreground)))
            .child(svg_layer(svg_doc(&[SUN], ""), sun_fade, sun_rise, 1.0, t.foreground));
        for (i, ray) in RAYS.iter().enumerate() {
            let opacity = fade(200.0 + i as f32 * 70.0);
            logo = logo.child(svg_layer(svg_doc(&[ray], ""), opacity, 0.0, 0.7 + 0.3 * opacity, t.foreground));
        }

        div()
            .id("updater")
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(28.0))
            .pb_4()
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .text_color(t.foreground)
            .font_family("IBM Plex Sans")
            .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move())
            .child(logo)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_1()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title))
                    .child(
                        div()
                            .min_h(px(16.0))
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child(detail),
                    ),
            )
    }
}

/// One stroke layer of the logo. gpui's `svg()` loads from assets, so the generated documents
/// are rendered as images instead.
fn svg_layer(doc: String, opacity: f32, translate_y: f32, scale: f32, color: Hsla) -> impl IntoElement {
    let doc = doc.replace("stroke=\"white\"", &format!("stroke=\"{}\"", css_color(color)));
    let image = std::sync::Arc::new(Image::from_bytes(ImageFormat::Svg, doc.into_bytes()));
    let size = 112.0 * scale;
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .opacity(opacity)
        .top(px(translate_y * 112.0 / 24.0))
        .child(img(image).size(px(size)))
}

fn css_color(color: Hsla) -> String {
    let rgba = color.to_rgb();
    format!(
        "#{:02x}{:02x}{:02x}",
        (rgba.r * 255.0) as u8,
        (rgba.g * 255.0) as u8,
        (rgba.b * 255.0) as u8
    )
}

/// Waits up to 15s for the launch check. Returns whether the app is restarting into an update.
pub async fn update_on_launch(cx: &mut AsyncApp) -> bool {
    let check = cx.update(|cx| Updater::check(cx));
    let timeout = cx.background_executor().timer(Duration::from_secs(15));
    let available = futures::future::select(check, Box::pin(timeout)).await;
    let futures::future::Either::Left((true, _)) = available else { return false };
    let download = cx.update(|cx| Updater::download(cx));
    if download.await.is_err() {
        return false;
    }
    cx.update(|cx| Updater::install(cx));
    true
}
