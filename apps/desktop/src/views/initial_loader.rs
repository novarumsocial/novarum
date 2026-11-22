// Port of apps/frontend/src/lib/components/initial-loader.svelte: the sun rises behind the horizon
// while the guilds load, then settles when `finished`.
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

/// The logo with the sun `offset` viewBox units below its resting place, clipped at the horizon.
fn logo(offset: f32, color: Hsla) -> Arc<Image> {
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="{c}"><defs><clipPath id="c"><rect width="24" height="15"/></clipPath></defs><g clip-path="url(#c)"><g transform="translate(0 {offset:.2})">{SUN}</g></g>{HORIZON}</svg>"#,
        c = hex(color)
    );
    Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()))
}

pub struct InitialLoader {
    started: Instant,
    finished_at: Option<Instant>,
}

impl InitialLoader {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            finished_at: None,
        }
    }

    pub fn finish(&mut self, cx: &mut Context<Self>) {
        self.finished_at.get_or_insert_with(Instant::now);
        cx.notify();
    }
}

fn ease_out(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(2)
}

/// cubic-bezier(0.22, 1, 0.36, 1), close enough.
fn ease_out_quint(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(5)
}

impl Render for InitialLoader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        // loading: 9 → 4 over 0.8s; finished: 4 → 0 over 0.55s
        let offset = match self.finished_at {
            None => {
                let p = (self.started.elapsed().as_secs_f32() / 0.8).min(1.0);
                9.0 - 5.0 * ease_out(p)
            }
            Some(at) => {
                let p = (at.elapsed().as_secs_f32() / 0.55).min(1.0);
                4.0 - 4.0 * ease_out_quint(p)
            }
        };
        let settled = self
            .finished_at
            .is_some_and(|at| at.elapsed().as_secs_f32() >= 0.55);
        if !settled {
            window.request_animation_frame();
        }

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
                    .child(img(logo(offset, t.primary)).size(px(144.0)))
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
