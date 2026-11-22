// Small building blocks standing in for Tailwind classes and shadcn-svelte pieces that
// gpui-component doesn't already cover. Prefer gpui-component (button, input, dialog, popover,
// dropdown menu, switch, slider, tabs, tooltip...) and only add here what it lacks.
pub mod avatar;
pub mod image;

use crate::prelude::*;
use gpui_kit::{component::Icon, *};

use crate::theme;

/// A Lucide icon by its kebab-case name, like `<Server />` → `icon("server")`.
pub fn icon(name: &str) -> Icon {
    Icon::default().path(SharedString::from(format!("icons/{name}.svg")))
}

/// Tailwind's `size-4` and friends are multiples of 4px.
pub fn tw(units: f32) -> Pixels {
    px(units * 4.0)
}

/// shadcn `Card.Root`: `rounded-lg border bg-card`.
pub fn card(cx: &App) -> Div {
    let t = theme::tokens(cx);
    div().flex().flex_col().bg(t.card).border_1().border_color(t.border).rounded(t.radius)
}

/// `text-sm text-muted-foreground`
pub fn muted(text: impl Into<SharedString>, cx: &App) -> Div {
    div().text_sm().text_color(theme::tokens(cx).muted_foreground).child(text.into())
}

/// `text-sm text-destructive`
pub fn error_text(text: impl Into<SharedString>, cx: &App) -> Div {
    div().text_sm().text_color(theme::tokens(cx).destructive).child(text.into())
}

/// Form.Label: `text-sm font-medium`.
pub fn label(text: impl Into<SharedString>) -> Div {
    div().text_sm().font_weight(FontWeight::MEDIUM).child(text.into())
}

/// The spinning `<LoaderCircle class="animate-spin" />`.
pub fn spinner(id: impl Into<ElementId>) -> impl IntoElement {
    icon("loader-circle").size_4().with_animation(
        id,
        Animation::new(std::time::Duration::from_secs(1)).repeat(),
        |icon, delta| icon.transform(Transformation::rotate(percentage(delta))),
    )
}

/// `#rrggbb` to a color, for avatar and embed colors.
pub fn hex(color: &str) -> Option<Hsla> {
    let hex = color.trim_start_matches('#');
    u32::from_str_radix(hex, 16).ok().filter(|_| hex.len() == 6).map(|value| rgb(value).into())
}

/// `@ana:novarum.me`, collapsed to `@ana` when the server is ours.
pub fn display_handle(username: &str, server: &str) -> String {
    if server.eq_ignore_ascii_case(&crate::api::anchor().home_server) {
        format!("@{username}")
    } else {
        format!("@{username}:{server}")
    }
}
