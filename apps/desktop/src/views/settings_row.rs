// Port of apps/frontend/src/lib/components/settings-row.svelte.
use crate::prelude::*;

/// A titled row with its control on the right, or under the text when `stacked` (selects, sliders).
pub fn settings_row(
    title: impl Into<SharedString>,
    description: Option<SharedString>,
    stacked: bool,
    control: impl IntoElement,
    cx: &App,
) -> AnyElement {
    let t = theme::tokens(cx);
    let text = div()
        .min_w_0()
        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title.into()))
        .when_some(description, |text, description| {
            text.child(div().mt(px(2.0)).text_xs().line_height(px(19.5)).text_color(t.muted_foreground).child(description))
        });
    let row = div().flex().px_4().py(px(14.0));
    if stacked {
        row.flex_col().gap_3().child(text).child(div().w_full().child(control)).into_any_element()
    } else {
        row.items_center()
            .justify_between()
            .gap_4()
            .child(text.flex_1())
            .child(div().flex_shrink_0().child(control))
            .into_any_element()
    }
}
