// Port of apps/frontend/src/lib/components/edit-channel-dialog.svelte. Saving is a TODO on the web
// too (channel-sidebar's `onSave`), so Save just closes it.
use gpui_kit::component::{
    WindowExt,
    dialog::{DialogDescription, DialogHeader, DialogTitle},
    input::{Input, InputEvent, InputState},
};

use crate::prelude::*;

use crate::models::{Channel, ChannelType};

pub struct EditChannelDialog {
    channel: Channel,
    name: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

pub fn open_edit_channel(channel: Channel, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| EditChannelDialog::new(channel, window, cx));
    let focus = view.read(cx).name.clone();
    let first = std::cell::Cell::new(true);
    window.open_dialog(cx, move |dialog, window, cx| {
        if first.replace(false) {
            focus.update(cx, |input, cx| input.focus(window, cx));
        }
        dialog.w(px(448.0)).p_6().child(view.clone())
    });
}

impl EditChannelDialog {
    fn new(channel: Channel, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let current = channel.label.clone().filter(|label| !label.is_empty()).unwrap_or(channel.name.clone());
        let name = cx.new(|cx| {
            InputState::new(window, cx).default_value(current).validate(|value, _| value.chars().count() <= 32)
        });
        let subscriptions = vec![cx.subscribe_in(&name, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.submit(window, cx);
            }
            cx.notify();
        })];
        Self { channel, name, _subscriptions: subscriptions }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.name.read(cx).value().trim().is_empty() {
            window.close_dialog(cx);
        }
    }
}

impl Render for EditChannelDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let empty = self.name.read(cx).value().trim().is_empty();
        let shown = self.channel.label.clone().filter(|label| !label.is_empty()).unwrap_or(self.channel.name.clone());
        let prefix = if self.channel.kind == ChannelType::Voice { "volume-2" } else { "hash" };

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                DialogHeader::new()
                    .child(DialogTitle::new().child("Edit Channel"))
                    .child(DialogDescription::new().child(format!("Rename #{shown}."))),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(div().text_xs().font_weight(FontWeight::MEDIUM).child("Channel Name"))
                    .child(Input::new(&self.name).prefix(icon(prefix).size_4().text_color(t.muted_foreground))),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_t_1()
                    .border_color(t.border)
                    .pt_3()
                    .child(
                        Button::new("cancel").ghost().label("Cancel").on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(
                        Button::new("save")
                            .primary()
                            .disabled(empty)
                            .icon(icon("pencil"))
                            .label("Save")
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            )
    }
}
