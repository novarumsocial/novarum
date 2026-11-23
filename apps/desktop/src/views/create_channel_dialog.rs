// Port of apps/frontend/src/lib/components/create-channel-dialog.svelte.
use gpui_kit::component::{
    WindowExt,
    dialog::{DialogDescription, DialogHeader, DialogTitle},
    input::{Input, InputEvent, InputState},
};

use crate::prelude::*;

use crate::{models::ChannelType, state::chat::Chat, views::shell::ShellState};

pub struct CreateChannelDialog {
    guild_id: String,
    category_label: String,
    name: Entity<InputState>,
    kind: ChannelType,
    loading: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// What the server will call it: lowercase letters, numbers and single dashes.
pub fn channel_slug(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-' || c.is_whitespace())
        .collect();
    let dashed = cleaned.split_whitespace().collect::<Vec<_>>().join("-");
    let mut slug = String::new();
    for c in dashed.chars() {
        if !(c == '-' && slug.ends_with('-')) {
            slug.push(c);
        }
    }
    slug.chars().take(32).collect()
}

pub fn open_create_channel(
    guild_id: String,
    category_label: Option<String>,
    window: &mut Window,
    cx: &mut App,
) {
    let label = category_label.unwrap_or_else(|| "Text Channels".into());
    let view = cx.new(|cx| CreateChannelDialog::new(guild_id, label, window, cx));
    let focus = view.read(cx).name.clone();
    let first = std::cell::Cell::new(true);
    window.open_dialog(cx, move |dialog, window, cx| {
        if first.replace(false) {
            focus.update(cx, |input, cx| input.focus(window, cx));
        }
        dialog.w(px(448.0)).p_6().child(view.clone())
    });
}

impl CreateChannelDialog {
    fn new(
        guild_id: String,
        category_label: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("new-channel")
                .validate(|value, _| value.chars().count() <= 32)
        });
        let subscriptions =
            vec![
                cx.subscribe_in(&name, window, |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.submit(window, cx);
                    }
                    cx.notify();
                }),
            ];
        Self {
            guild_id,
            category_label,
            name,
            kind: ChannelType::Text,
            loading: false,
            error: None,
            _subscriptions: subscriptions,
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let slug = channel_slug(&self.name.read(cx).value());
        if !(2..=32).contains(&slug.len()) {
            self.error =
                Some("Channel name must be 2-32 letters, numbers, spaces, or dashes.".into());
            cx.notify();
            return;
        }
        self.error = None;
        let create = Chat::global(cx).update(cx, |chat, cx| {
            chat.create_channel(self.guild_id.clone(), slug, self.kind, cx)
        });
        cx.spawn(async move |_, cx| {
            if let Some(channel) = create.await {
                cx.update(|cx| ShellState::select_channel(&channel.id, cx));
            }
        })
        .detach();
        window.close_dialog(cx);
    }

    fn type_option(
        &self,
        kind: ChannelType,
        label: &'static str,
        icon_name: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let t = theme::tokens(cx);
        let selected = self.kind == kind;
        div()
            .id(label)
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .text_sm()
            .border_1()
            .rounded(t.radius)
            .cursor_pointer()
            .map(|option| {
                if selected {
                    option.border_color(t.primary).bg(t.primary.opacity(0.1))
                } else {
                    option
                        .border_color(t.border)
                        .bg(t.background)
                        .hover(|option| option.bg(t.accent))
                }
            })
            .child(icon(icon_name).size_4().text_color(t.muted_foreground))
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.kind = kind;
                cx.notify();
            }))
    }
}

impl Render for CreateChannelDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let empty = self.name.read(cx).value().trim().is_empty();
        let prefix = if self.kind == ChannelType::Voice {
            "volume-2"
        } else {
            "hash"
        };

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                DialogHeader::new()
                    .child(DialogTitle::new().child("Create Channel"))
                    .child(
                        DialogDescription::new()
                            .child(format!("Add a channel to {}.", self.category_label)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Channel Name"),
                    )
                    .child(
                        Input::new(&self.name)
                            .text_xs()
                            .prefix(icon(prefix).size_4().text_color(t.muted_foreground)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Channel Type"),
                    )
                    .child(
                        div()
                            .grid()
                            .grid_cols(2)
                            .gap_2()
                            .child(self.type_option(ChannelType::Text, "Text", "hash", cx))
                            .child(self.type_option(ChannelType::Voice, "Voice", "volume-2", cx)),
                    ),
            )
            .when_some(self.error.clone(), |this, error| {
                this.child(ui::error_text(error, cx))
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_t_1()
                    .border_color(t.border)
                    .pt_3()
                    .child(
                        Button::new("cancel")
                            .ghost()
                            .label("Cancel")
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(
                        Button::new("create")
                            .primary()
                            .disabled(self.loading || empty)
                            .loading(self.loading)
                            .icon(icon("plus"))
                            .label(if self.loading {
                                "Creating…"
                            } else {
                                "Create Channel"
                            })
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::channel_slug;

    #[test]
    fn slugs_channel_names() {
        assert_eq!(channel_slug("  General Chat  "), "general-chat");
        assert_eq!(channel_slug("a -- b"), "a-b");
        assert_eq!(channel_slug("Héllo!"), "hllo");
        assert_eq!(channel_slug(&"x".repeat(40)).len(), 32);
    }
}
