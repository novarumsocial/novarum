// Port of apps/frontend/src/lib/components/initial-loader.svelte: the sun rises behind the horizon
// while the guilds load.
use std::{sync::Arc, time::Instant};

use crate::prelude::*;

use crate::theme;

const SUN: &str = r#"<path d="M7 12a1 1 0 0 0 2 0 3 3 0 0 1 6 0 1 1 0 0 0 2 0 5 5 0 0 0-10 0Z"/><path d="M11 5a1 1 0 0 0 2 0V4a1 1 0 0 0-2 0Z"/><path d="M18 12a1 1 0 0 0 1 1h1a1 1 0 0 0 0-2h-1a1 1 0 0 0-1 1Z"/><path d="M3 12a1 1 0 0 0 1 1h1a1 1 0 0 0 0-2H4a1 1 0 0 0-1 1Z"/><path d="M5.636 5.636a1 1 0 0 0 0 1.414l.707.707a1 1 0 0 0 1.414-1.414l-.707-.707a1 1 0 0 0-1.414 0Z"/><path d="m16.95 5.636-.707.707a1 1 0 1 0 1.414 1.414l.707-.707a1 1 0 1 0-1.414-1.414Z"/>"#;
const HORIZON: &str = r#"<path d="M2 15a1 1 0 0 0 0 2h20a1 1 0 0 0 0-2Z"/><path d="M6 19a1 1 0 0 0 0 2h12a1 1 0 0 0 0-2Z"/>"#;

fn hex(color: Hsla) -> String {
    let c = color.to_rgb();
    format!(
        "#{:02x}{:02x}{:02x}",
        (c.r * 255.0) as u8,
        (c.g * 255.0) as u8,
        (c.b * 255.0) as u8
    )
}

fn svg(body: &str, color: Hsla) -> Arc<Image> {
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="{}">{body}</svg>"#,
        hex(color)
    );
    Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()))
}

/// Rasterized once per color; the sun moves by layout rather than by redrawing the SVG.
struct Logo {
    color: Hsla,
    sun: Arc<Image>,
    horizon: Arc<Image>,
}

impl Logo {
    fn new(color: Hsla) -> Self {
        Self {
            color,
            sun: svg(SUN, color),
            horizon: svg(HORIZON, color),
        }
    }
}

const LOGO_SIZE: f32 = 144.0;
/// one viewBox unit of the 24-unit logo, in pixels
const UNIT: f32 = LOGO_SIZE / 24.0;

pub struct InitialLoader {
    started: Instant,
    logo: Option<Logo>,
}

impl InitialLoader {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            logo: None,
        }
    }
}

fn ease_out(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(2)
}

impl Render for InitialLoader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        // the sun rises 9 → 4 viewBox units over 0.8s while the boot runs
        let progress = (self.started.elapsed().as_secs_f32() / 0.8).min(1.0);
        let offset = 9.0 - 5.0 * ease_out(progress);
        if progress < 1.0 {
            window.request_animation_frame();
        }
        if self
            .logo
            .as_ref()
            .is_none_or(|logo| logo.color != t.primary)
        {
            self.logo = Some(Logo::new(t.primary));
        }
        let logo = self.logo.as_ref().unwrap();

        div()
            .relative()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .bg(t.background)
            .px_6()
            .text_color(t.foreground)
            .child(
                // radial-gradient(circle, primary 10%, transparent 30rem)
                div()
                    .absolute()
                    .size(px(160.0))
                    .rounded_full()
                    .bg(t.primary.opacity(0.06))
                    .shadow(vec![BoxShadow {
                        color: t.primary.opacity(0.06),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(320.0),
                        spread_radius: px(160.0),
                        inset: false,
                    }]),
            )
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .items_center()
                    .w_full()
                    .max_w(px(224.0))
                    .child(
                        div()
                            .relative()
                            .size(px(LOGO_SIZE))
                            .child(
                                // clipped at the horizon (y = 15), so the sun rises from behind it
                                div()
                                    .absolute()
                                    .top_0()
                                    .left_0()
                                    .w(px(LOGO_SIZE))
                                    .h(px(15.0 * UNIT))
                                    .overflow_hidden()
                                    .child(
                                        img(logo.sun.clone())
                                            .absolute()
                                            .left_0()
                                            .top(px(offset * UNIT))
                                            .size(px(LOGO_SIZE)),
                                    ),
                            )
                            .child(
                                img(logo.horizon.clone())
                                    .absolute()
                                    .top_0()
                                    .left_0()
                                    .size(px(LOGO_SIZE)),
                            ),
                    )
                    .child(
                        div()
                            .mt_8()
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("novarum"),
                    ),
            )
    }
}
