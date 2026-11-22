// Port of apps/frontend/src/lib/components/avatar.svelte.
use crate::prelude::*;

use crate::{state::settings::SettingsStore, theme, ui};

pub const DEFAULT_AVATAR_COLOR: &str = "#005f78";
pub const DEFAULT_SPEAKING_RING_COLOR: &str = "#00d492";

/// `size` is the box in pixels (`size-8` → 32.0). The fallback letter scales with it.
pub fn avatar(
    src: Option<&str>,
    name: &str,
    bg_color: Option<&str>,
    size: f32,
    cx: &mut App,
) -> Div {
    avatar_with_fallback(src, name, None, bg_color, size, cx)
}

pub fn avatar_with_fallback(
    src: Option<&str>,
    name: &str,
    fallback: Option<&str>,
    bg_color: Option<&str>,
    size: f32,
    cx: &mut App,
) -> Div {
    let t = theme::tokens(cx);
    let circle = SettingsStore::get(cx).circle_icons;
    let image = src.filter(|src| !src.is_empty()).and_then(|src| ui::image::remote(src, cx).ok());
    let background = bg_color.and_then(ui::hex).unwrap_or(t.primary.opacity(0.2));

    let base = div()
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .size(px(size))
        .font_weight(FontWeight::BOLD)
        .text_color(white())
        .text_size(px((size * 0.4).max(10.0)))
        .bg(background)
        .when(circle, |div| div.rounded_full())
        .when(!circle, |div| div.rounded(t.radius));

    match image {
        Some(Some(image)) => base.child(img(image).size_full().object_fit(ObjectFit::Contain)),
        // still loading: keep the colored box, like the browser before the image arrives
        Some(None) => base,
        None => {
            let letter = fallback.map(str::to_string).unwrap_or_else(|| {
                name.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or("?".into())
            });
            base.child(letter)
        }
    }
}
