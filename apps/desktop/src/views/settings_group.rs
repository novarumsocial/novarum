// Port of apps/frontend/src/lib/components/settings-group.svelte.
use crate::prelude::*;

/// `divide-y divide-border/60 bg-card` under an optional title and description.
pub fn settings_group(
    title: Option<&str>,
    description: Option<&str>,
    rows: impl IntoIterator<Item = AnyElement>,
    cx: &App,
) -> Div {
    let t = theme::tokens(cx);
    let body = div().flex().flex_col().bg(t.card).children(rows.into_iter().enumerate().map(|(index, row)| {
        div().when(index > 0, |row| row.border_t_1().border_color(t.border.opacity(0.6))).child(row)
    }));
    div()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .when_some(title, |group, title| {
            group.child(
                div()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title.to_string()))
                    .when_some(description, |header, description| {
                        header.child(div().text_xs().text_color(t.muted_foreground).child(description.to_string()))
                    }),
            )
        })
        .child(body)
}
