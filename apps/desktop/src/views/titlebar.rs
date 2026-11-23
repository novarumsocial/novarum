// The `.desktop-titlebar` of +layout.svelte: logo + "novarum", draggable, with window controls
// (Electron drew those through titleBarOverlay).
use crate::prelude::*;
use gpui_kit::{component::TitleBar, *};

use crate::theme;

pub fn titlebar(cx: &App) -> impl IntoElement {
    let t = theme::tokens(cx);
    TitleBar::new()
        .bg(t.background)
        .border_color(t.border)
        .child(
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .gap(px(7.0))
                .text_size(px(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .child(
                    svg()
                        .path("logo.svg")
                        .size(px(15.0))
                        .text_color(t.foreground.opacity(0.85)),
                )
                .child("NOVARUM"),
        )
}
