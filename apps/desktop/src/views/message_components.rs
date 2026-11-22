// Port of apps/frontend/src/lib/components/message-components.svelte: a bot message's button rows.
use gpui_kit::component::button::ButtonCustomVariant;

use crate::prelude::*;

use crate::{desktop, models::ActionRow, state::bots::Interactions, views::emoji_text::sub_id};

/// What a button tells its owner: the press failed with this message, or cleared.
pub type OnPressed = std::rc::Rc<dyn Fn(Option<String>, &mut App)>;

pub fn message_components(
    id: impl Into<ElementId>,
    rows: &[ActionRow],
    channel_id: &str,
    message_id: &str,
    error: Option<&str>,
    on_pressed: OnPressed,
    cx: &mut App,
) -> Div {
    let id: ElementId = id.into();
    let t = theme::tokens(cx);
    let pressing = Interactions::global(cx).read(cx).pressing.clone();
    let mut column = div().mt_1p5().flex().flex_col().gap_1p5();
    for (row_index, row) in rows.iter().enumerate() {
        let mut buttons = div().flex().flex_wrap().gap_1p5();
        for (index, button) in row.components.iter().enumerate() {
            let base = Button::new(sub_id(&id, format!("{row_index}-{index}"))).small().text_xs();
            if button.style == "link" {
                let url = button.url.clone();
                buttons = buttons.child(
                    base.outline()
                        .disabled(button.disabled)
                        .child(div().flex().items_center().gap_1().child(button.label.clone()).child(icon("external-link").size_3()))
                        .on_click(move |_, _, cx| {
                            if let Some(url) = &url {
                                desktop::open_url(url, cx);
                            }
                        }),
                );
                continue;
            }
            let custom_id = button.custom_id.clone().unwrap_or_default();
            let busy = pressing.as_deref() == Some(format!("{message_id}:{custom_id}").as_str());
            let any_busy = pressing.as_ref().is_some_and(|pressing| pressing.starts_with(&format!("{message_id}:")));
            let base = match button.style.as_str() {
                "secondary" => base.secondary(),
                // bg-emerald-600 text-white
                "success" => base.custom(
                    ButtonCustomVariant::new(cx)
                        .color(rgb(0x059669).into())
                        .foreground(white())
                        .hover(Hsla::from(rgb(0x059669)).opacity(0.85))
                        .active(Hsla::from(rgb(0x059669)).opacity(0.85)),
                ),
                "danger" => base.custom(
                    ButtonCustomVariant::new(cx)
                        .color(t.destructive)
                        .foreground(white())
                        .hover(t.destructive.opacity(0.85))
                        .active(t.destructive.opacity(0.85)),
                ),
                _ => base.primary(),
            };
            let (channel_id, message_id) = (channel_id.to_string(), message_id.to_string());
            let on_pressed = on_pressed.clone();
            buttons = buttons.child(
                base.disabled(button.disabled || any_busy)
                    .loading(busy)
                    .label(button.label.clone())
                    .on_click(move |_, _, cx| {
                        let press = Interactions::global(cx).update(cx, |interactions, cx| {
                            interactions.press_button(channel_id.clone(), message_id.clone(), custom_id.clone(), cx)
                        });
                        let on_pressed = on_pressed.clone();
                        cx.spawn(async move |cx| {
                            let error = press.await.err();
                            cx.update(|cx| on_pressed(error, cx));
                        })
                        .detach();
                    }),
            );
        }
        column = column.child(buttons);
    }
    column.when_some(error, |column, error| {
        column.child(div().text_xs().text_color(t.destructive).child(error.to_string()))
    })
}
