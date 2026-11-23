// Port of apps/frontend/src/lib/components/create-server-dialog.svelte.
use gpui_kit::component::{
    WindowExt,
    dialog::{DialogDescription, DialogHeader, DialogTitle},
    input::{Input, InputEvent, InputState},
};

use crate::prelude::*;

use crate::state::{chat::Chat, settings::SettingsStore};

pub struct CreateServerDialog {
    name: Entity<InputState>,
    loading: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// Up to two initials, one per word.
pub fn initials(name: &str) -> String {
    name.split_whitespace()
        .take(2)
        .filter_map(|word| word.chars().next())
        .flat_map(char::to_uppercase)
        .collect()
}

pub fn validate_server_name(name: &str) -> Option<&'static str> {
    let length = name.trim().chars().count();
    (!(2..=32).contains(&length)).then_some("Server name must be 2–32 characters.")
}

/// Opens the dialog over the window.
pub fn open_create_server(window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| CreateServerDialog::new(window, cx));
    let focus = view.read(cx).name.clone();
    let first = std::cell::Cell::new(true);
    window.open_dialog(cx, move |dialog, window, cx| {
        if first.replace(false) {
            focus.update(cx, |input, cx| input.focus(window, cx));
        }
        dialog.w(px(448.0)).p_6().child(view.clone())
    });
}

impl CreateServerDialog {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("My Server")
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
            name,
            loading: false,
            error: None,
            _subscriptions: subscriptions,
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.name.read(cx).value().trim().to_string();
        if let Some(error) = validate_server_name(&name) {
            self.error = Some(error.into());
            cx.notify();
            return;
        }
        self.loading = true;
        self.error = None;
        Chat::global(cx)
            .update(cx, |chat, cx| chat.create_server(name, cx))
            .detach();
        self.loading = false;
        window.close_dialog(cx);
    }
}

impl Render for CreateServerDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let name = self.name.read(cx).value().to_string();
        let preview = Some(initials(&name))
            .filter(|initials| !initials.is_empty())
            .unwrap_or("N".into());

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                DialogHeader::new()
                    .child(DialogTitle::new().child("Create Server"))
                    .child(
                        DialogDescription::new()
                            .child("Give your server a name and upload a picture."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .size_16()
                            .items_center()
                            .justify_center()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .text_color(white())
                            .bg(t.primary)
                            .when(circle, |div| div.rounded_full())
                            .child(preview),
                    )
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("Server Name"),
                            )
                            .child(
                                Input::new(&self.name)
                                    .text_xs()
                                    .prefix(icon("users").size_4().text_color(t.muted_foreground)),
                            ),
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
                            .disabled(self.loading || name.trim().is_empty())
                            .loading(self.loading)
                            .icon(icon("plus"))
                            .label(if self.loading {
                                "Creating…"
                            } else {
                                "Create Server"
                            })
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{initials, validate_server_name};

    #[test]
    fn makes_initials() {
        assert_eq!(initials("rust lovers club"), "RL");
        assert_eq!(initials("  solo "), "S");
        assert_eq!(initials(""), "");
    }

    #[test]
    fn validates_names() {
        assert!(validate_server_name("a").is_some());
        assert!(validate_server_name(" ab ").is_none());
        assert!(validate_server_name(&"x".repeat(33)).is_some());
    }
}
