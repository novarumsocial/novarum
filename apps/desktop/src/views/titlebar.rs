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
                .flex()
                .items_center()
                .gap_2()
                .pl_2()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(t.muted_foreground)
                .child(
                    svg()
                        .path("logo.svg")
                        .size_4()
                        .text_color(t.muted_foreground),
                )
                .child("novarum"),
        )
}
