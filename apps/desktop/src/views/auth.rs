// The layout the sign-in, register, reset-password and invite pages share: a dark starfield,
// the logo in the corner and a translucent card in the middle.
use crate::prelude::*;
use gpui_kit::{component::input::Input, *};

use crate::{
    theme::{self, Tokens},
    ui::{self, icon},
    views::constellation::ConstellationBackground,
};

/// `<Form.Field>`: label, an input with a leading icon (`pl-8`), and the field's error.
pub fn field(label: Div, icon_name: &str, input: Input, error: &Option<String>, cx: &App) -> Div {
    let t = theme::tokens(cx);
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(label)
        .child(input.prefix(icon(icon_name).size_4().text_color(t.muted_foreground)))
        .child(field_errors(error, cx))
}

pub fn field_errors(error: &Option<String>, cx: &App) -> impl IntoElement {
    let t = theme::tokens(cx);
    div().when_some(error.clone(), |div, error| {
        div.text_xs().text_color(t.destructive).child(error)
    })
}

/// Card.Root with its header (title + description), content and footer, on the `dark` backdrop.
pub fn auth_backdrop(
    title: &str,
    description: &str,
    content: Div,
    footer: Div,
    cx: &mut App,
) -> AnyElement {
    // the auth pages are always dark (`<div class="dark ...">`)
    let t = Tokens::dark();
    let background = ConstellationBackground::global(cx);
    div()
        .relative()
        .size_full()
        .overflow_hidden()
        .bg(t.background)
        .text_color(t.foreground)
        .child(div().absolute().inset_0().child(background))
        // the two radial gradients: a soft blue glow, then the vignette
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .size(px(240.0))
                        .rounded_full()
                        .bg(rgba(0x82afeb10))
                        .shadow(vec![BoxShadow {
                            color: rgba(0x82afeb10).into(),
                            offset: point(px(0.0), px(0.0)),
                            blur_radius: px(320.0),
                            spread_radius: px(160.0),
                            inset: false,
                        }]),
                ),
        )
        .child(
            div()
                .absolute()
                .top_6()
                .left_6()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size_9()
                        .bg(t.primary)
                        .rounded(theme::tokens(cx).radius)
                        .child(svg().path("logo.svg").size_5().text_color(white())),
                )
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("novarum"),
                ),
        )
        .child(
            div()
                .id("auth-scroll")
                .relative()
                .size_full()
                .overflow_y_scroll()
                .flex()
                .items_center()
                .justify_center()
                .p_4()
                .child(
                    ui::card(cx)
                        .w_full()
                        .max_w(px(448.0))
                        .py_6()
                        .gap_6()
                        .border_color(white().opacity(0.1))
                        .bg(t.card.opacity(0.85))
                        .shadow(vec![BoxShadow {
                            color: black().opacity(0.5),
                            offset: point(px(0.0), px(25.0)),
                            blur_radius: px(50.0),
                            spread_radius: px(-12.0),
                            inset: false,
                        }])
                        .child(
                            div()
                                .px_6()
                                .mt(px(6.0))
                                .flex()
                                .flex_col()
                                .gap_1()
                                .child(
                                    div()
                                        .text_xl()
                                        .text_center()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(title.to_string()),
                                )
                                .child(
                                    div()
                                        .text_sm()
                                        .text_center()
                                        .text_color(t.muted_foreground)
                                        .child(description.to_string()),
                                ),
                        )
                        .child(div().px_6().child(content))
                        .child(
                            footer
                                .px_6()
                                .justify_center()
                                .items_center()
                                .text_xs()
                                .text_color(t.muted_foreground),
                        ),
                ),
        )
        .into_any_element()
}
