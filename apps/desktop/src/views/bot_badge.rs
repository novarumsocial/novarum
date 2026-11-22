// Port of apps/frontend/src/lib/components/bot-badge.svelte.
use gpui_kit::component::tooltip::Tooltip;

use crate::prelude::*;

/// The little "Bot" tag after a bot's name.
pub fn bot_badge(id: impl Into<ElementId>, cx: &App) -> Stateful<Div> {
    let t = theme::tokens(cx);
    div()
        .id(id)
        .flex()
        .flex_shrink_0()
        .items_center()
        .h_4()
        .px_1()
        .bg(t.primary)
        .text_size(px(10.0))
        .line_height(relative(1.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(t.primary_foreground)
        .child("Bot")
        .tooltip(|window, cx| Tooltip::new("This account is a bot").build(window, cx))
}
