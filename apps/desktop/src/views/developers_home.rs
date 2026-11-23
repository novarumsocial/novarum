// Port of apps/frontend/src/lib/components/developers-home.svelte.
use std::{rc::Rc, time::Duration};

use chrono::DateTime;
use gpui_kit::component::{
    ActiveTheme, WindowExt,
    input::{Input, InputEvent, InputState, Textarea, TextareaState},
    menu::{DropdownMenu, PopupMenuItem},
    radio::Radio,
    switch::Switch,
    tab::{Tab, TabBar},
};

use crate::prelude::*;
use crate::{
    api,
    state::{
        bots::{BotPatch, DeveloperBot, Developers},
        chat::UploadFile,
        router::{self, ChatRoute, Router},
    },
    ui::avatar::avatar,
    views::{
        avatar_crop_dialog::{CropOptions, open_avatar_crop, pick_image},
        settings_group::settings_group,
        settings_row::settings_row,
        shell::{MD, ShellState},
    },
};

/// Tailwind's `xl` breakpoint.
const XL: f32 = 1280.0;
/// Where the web app lives, for links people share (`window.location.origin`).
const WEB_ORIGIN: &str = "https://app.novarum.me";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BotTab {
    General,
    Token,
    Commands,
    Install,
}

const TABS: [(BotTab, &str, &str); 4] = [
    (BotTab::General, "General", "settings-2"),
    (BotTab::Token, "Token", "key-round"),
    (BotTab::Commands, "Commands", "square-slash"),
    (BotTab::Install, "Add to a guild", "user-plus"),
];

pub fn bot_path(id: Option<&str>) -> String {
    match id {
        Some(id) => format!("/guilds/developers/{}", router::encode(id)),
        None => "/guilds/developers".into(),
    }
}

pub fn install_url(handle: &str, admin: bool) -> String {
    format!(
        "{WEB_ORIGIN}/authorize?bot={}{}",
        router::encode(handle),
        if admin { "&role=ADMIN" } else { "" }
    )
}

/// The `pattern="[a-zA-Z0-9._]+"` and length checks of the new bot's username.
pub fn valid_bot_username(username: &str) -> bool {
    (2..=32).contains(&username.chars().count())
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

pub fn quickstart(base_url: &str) -> String {
    format!(
        "import {{ Client }} from '@novarum/sdk';

const client = new Client({{
  token: process.env.BOT_TOKEN!,
  baseUrl: '{base_url}',
}});

client.on('messageCreate', async (message) => {{
  if (message.content === '!ping') await message.reply('Pong!');
}});

await client.login();
console.log(`Logged in as ${{client.user!.tag}}`);"
    )
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// `<BotBadge />`
fn bot_badge(cx: &App) -> Div {
    let t = theme::tokens(cx);
    div()
        .flex()
        .h_4()
        .flex_shrink_0()
        .items_center()
        .bg(t.primary)
        .px_1()
        .text_size(px(10.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(t.primary_foreground)
        .child("Bot")
}

/// Caps an input at `max` characters, like `maxlength`.
fn limit<S: 'static>(input: &Entity<InputState>, max: usize, cx: &mut Context<S>) -> Subscription {
    cx.subscribe(input, move |_, input, event: &InputEvent, cx| {
        let value = input.read(cx).value();
        if matches!(event, InputEvent::Change) && value.chars().count() > max {
            let truncated: String = value.chars().take(max).collect();
            cx.defer(move |cx| {
                let Some(window) = cx.active_window() else {
                    return;
                };
                let _ = window.update(cx, |_, window, cx| {
                    input.update(cx, |input, cx| input.set_value(truncated, window, cx))
                });
            });
        }
    })
}

pub struct DevelopersHome {
    tab: BotTab,
    form_bot: Option<String>,
    display_name: Entity<InputState>,
    about: Entity<TextareaState>,
    saving: bool,
    save_error: Option<String>,
    saved: bool,
    uploading: bool,
    resetting: bool,
    token_error: Option<String>,
    copied: Option<&'static str>,
    install_admin: bool,
    new_username: Entity<InputState>,
    new_display_name: Entity<InputState>,
    creating: bool,
    create_error: Option<String>,
    delete_confirm: Entity<InputState>,
    deleting: bool,
    _copied_timer: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl DevelopersHome {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let display_name = cx.new(|cx| InputState::new(window, cx));
        let about = cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(4)
                .placeholder("What does your bot do? People see this on its profile.")
        });
        let new_username = cx.new(|cx| InputState::new(window, cx).placeholder("weatherbot"));
        let new_display_name = cx.new(|cx| InputState::new(window, cx).placeholder("Weather"));
        let delete_confirm = cx.new(|cx| InputState::new(window, cx));
        let mut subscriptions = vec![
            cx.observe(&Developers::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Router::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&ShellState::global(cx), |_, _, cx| cx.notify()),
            limit(&display_name, 64, cx),
            limit(&new_username, 32, cx),
            limit(&new_display_name, 64, cx),
            cx.subscribe(&about, |this, about, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.saved = false;
                    let value = about.read(cx).value();
                    if value.chars().count() > 512 {
                        let truncated: String = value.chars().take(512).collect();
                        cx.defer(move |cx| {
                            let Some(window) = cx.active_window() else {
                                return;
                            };
                            let _ = window.update(cx, |_, window, cx| {
                                about.update(cx, |about, cx| about.set_value(truncated, window, cx))
                            });
                        });
                    }
                    cx.notify();
                }
            }),
        ];
        for input in [
            &display_name,
            &new_username,
            &new_display_name,
            &delete_confirm,
        ] {
            subscriptions.push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.saved = false;
                    cx.notify();
                }
            }));
        }
        subscriptions.push(cx.subscribe_in(
            &display_name,
            window,
            |this, _, event: &InputEvent, _, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.save_profile(cx);
                }
            },
        ));
        for input in [&new_username, &new_display_name] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.create(window, cx);
                    }
                },
            ));
        }
        Self {
            tab: BotTab::General,
            form_bot: None,
            display_name,
            about,
            saving: false,
            save_error: None,
            saved: false,
            uploading: false,
            resetting: false,
            token_error: None,
            copied: None,
            install_admin: false,
            new_username,
            new_display_name,
            creating: false,
            create_error: None,
            delete_confirm,
            deleting: false,
            _copied_timer: None,
            _subscriptions: subscriptions,
        }
    }

    fn selected_id(cx: &App) -> Option<String> {
        match Router::route(cx) {
            ChatRoute::Developers { bot_id } => bot_id,
            _ => None,
        }
    }

    fn selected(cx: &App) -> Option<DeveloperBot> {
        let id = Self::selected_id(cx);
        Developers::global(cx).read(cx).find(id.as_deref()).cloned()
    }

    /// The name everyone sees, following the form as you type.
    fn preview_name(&self, bot: &DeveloperBot, cx: &App) -> String {
        let name = self.display_name.read(cx).value().trim().to_string();
        if name.is_empty() {
            bot.user.username.clone()
        } else {
            name
        }
    }

    /// the form follows the bot you pick
    fn sync_form(
        &mut self,
        bot: Option<&DeveloperBot>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = bot.map(|bot| bot.user.user_id.clone());
        if id == self.form_bot {
            return;
        }
        self.form_bot = id;
        let name = bot
            .and_then(|bot| bot.user.display_name.clone())
            .unwrap_or_default();
        let about = bot
            .and_then(|bot| bot.user.about.clone())
            .unwrap_or_default();
        let placeholder = bot.map(|bot| bot.user.username.clone()).unwrap_or_default();
        self.display_name.update(cx, |input, cx| {
            input.set_value(name, window, cx);
            input.set_placeholder(placeholder, window, cx);
        });
        self.about
            .update(cx, |input, cx| input.set_value(about, window, cx));
        self.save_error = None;
        self.saved = false;
    }

    fn open(id: Option<&str>, cx: &mut App) {
        router::goto(bot_path(id), cx);
    }

    fn copy(&mut self, what: &'static str, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.copied = Some(what);
        self._copied_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1500))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.copied == Some(what) {
                    this.copied = None;
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let username = self.new_username.read(cx).value().trim().to_string();
        if self.creating || !valid_bot_username(&username) {
            if !valid_bot_username(&username) {
                self.create_error =
                    Some("Use 2 to 32 letters, numbers, dots or underscores.".into());
                cx.notify();
            }
            return;
        }
        let display_name = self.new_display_name.read(cx).value().trim().to_string();
        self.creating = true;
        self.create_error = None;
        cx.notify();
        let create = Developers::global(cx).update(cx, |developers, cx| {
            developers.create(username, display_name, cx)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = create.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.creating = false;
                match result {
                    Err(error) => this.create_error = Some(error),
                    Ok(bot) => {
                        window.close_dialog(cx);
                        for input in [&this.new_username, &this.new_display_name] {
                            input.update(cx, |input, cx| input.set_value("", window, cx));
                        }
                        this.tab = BotTab::Token;
                        Self::open(Some(&bot.user.user_id), cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_profile(&mut self, cx: &mut Context<Self>) {
        let Some(bot) = Self::selected(cx) else {
            return;
        };
        let display_name = self.display_name.read(cx).value().trim().to_string();
        let about = self.about.read(cx).value().trim().to_string();
        let patch = BotPatch {
            display_name: Some((!display_name.is_empty()).then_some(display_name)),
            about: Some((!about.is_empty()).then_some(about)),
            public: None,
        };
        self.saving = true;
        cx.notify();
        let update = Developers::global(cx).update(cx, |developers, cx| {
            developers.update(bot.user.user_id, patch, cx)
        });
        cx.spawn(async move |this, cx| {
            let result = update.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                this.saved = result.is_ok();
                this.save_error = result.err();
                cx.notify();
            });
        })
        .detach();
    }

    fn set_public(&mut self, id: String, public: bool, cx: &mut Context<Self>) {
        let patch = BotPatch {
            public: Some(public),
            ..Default::default()
        };
        let update =
            Developers::global(cx).update(cx, |developers, cx| developers.update(id, patch, cx));
        cx.spawn(async move |this, cx| {
            let result = update.await;
            let _ = this.update(cx, |this, cx| {
                this.save_error = result.err();
                cx.notify();
            });
        })
        .detach();
    }

    fn pick_avatar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picked = pick_image(cx);
        cx.spawn_in(window, async move |this, cx| {
            let picked = picked.await;
            let _ = this.update_in(cx, |this, window, cx| match picked {
                Err(error) => {
                    this.save_error = Some(error);
                    cx.notify();
                }
                Ok(None) => {}
                Ok(Some(file)) if file.content_type == "image/gif" => this.upload_avatar(file, cx),
                Ok(Some(file)) => {
                    let weak = cx.entity().downgrade();
                    let on_crop = Rc::new(move |bytes: Vec<u8>, _: &mut Window, cx: &mut App| {
                        let file = UploadFile {
                            name: "avatar.png".into(),
                            content_type: "image/png".into(),
                            bytes,
                        };
                        let _ = weak.update(cx, |this, cx| this.upload_avatar(file, cx));
                    });
                    let options = CropOptions {
                        title: "Crop avatar".into(),
                        description: "Adjust the image to fit your bot's avatar.".into(),
                        action_label: "Use avatar".into(),
                        ..Default::default()
                    };
                    open_avatar_crop(file.bytes, options, on_crop, window, cx);
                }
            });
        })
        .detach();
    }

    fn upload_avatar(&mut self, file: UploadFile, cx: &mut Context<Self>) {
        let Some(bot) = Self::selected(cx) else {
            return;
        };
        let file = UploadFile {
            name: if file.content_type == "image/gif" {
                "avatar.gif".into()
            } else {
                "avatar.png".into()
            },
            ..file
        };
        self.uploading = true;
        cx.notify();
        let upload = Developers::global(cx).update(cx, |developers, cx| {
            developers.upload_avatar(bot.user.user_id, file, cx)
        });
        cx.spawn(async move |this, cx| {
            let result = upload.await;
            let _ = this.update(cx, |this, cx| {
                this.uploading = false;
                this.save_error = result.err();
                cx.notify();
            });
        })
        .detach();
    }

    fn reset_token(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot) = Self::selected(cx) else {
            return;
        };
        self.resetting = true;
        cx.notify();
        let reset = Developers::global(cx).update(cx, |developers, cx| {
            developers.regenerate_token(bot.user.user_id, cx)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = reset.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.resetting = false;
                this.token_error = result.err();
                window.close_dialog(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn delete_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot) = Self::selected(cx) else {
            return;
        };
        self.deleting = true;
        cx.notify();
        let remove = Developers::global(cx)
            .update(cx, |developers, cx| developers.remove(bot.user.user_id, cx));
        cx.spawn_in(window, async move |this, cx| {
            let result = remove.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.deleting = false;
                window.close_dialog(cx);
                this.delete_confirm
                    .update(cx, |input, cx| input.set_value("", window, cx));
                match result {
                    Err(error) => this.save_error = Some(error),
                    Ok(()) => {
                        this.save_error = None;
                        Self::open(None, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // ---- dialogs ----

    fn dialog_title(title: String, description: String, cx: &App) -> Div {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            )
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::NORMAL)
                    .text_color(theme::tokens(cx).muted_foreground)
                    .child(description),
            )
    }

    fn open_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.create_error = None;
        let view = cx.entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let this = view.read(cx);
            let username = this.new_username.read(cx).value().trim().to_string();
            let can_create = !this.creating && username.chars().count() >= 2;
            let description = format!(
                "Its handle will be @{}:{}.",
                if username.is_empty() {
                    "username"
                } else {
                    &username
                },
                api::anchor().home_server
            );
            let create = view.clone();
            dialog
                .w(px(448.0))
                .title(Self::dialog_title("New bot".into(), description, cx))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_4()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.0))
                                .child(ui::label("Username"))
                                .child(Input::new(&this.new_username).text_xs())
                                .child(
                                    ui::muted("Letters, numbers, dots and underscores.", cx)
                                        .text_xs(),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.0))
                                .child(ui::label("Display name"))
                                .child(Input::new(&this.new_display_name).text_xs()),
                        )
                        .when_some(this.create_error.clone(), |form, error| {
                            form.child(ui::error_text(error, cx).text_xs())
                        }),
                )
                .footer(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("create-cancel")
                                .ghost()
                                .label("Cancel")
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        )
                        .child(
                            Button::new("create-bot")
                                .primary()
                                .disabled(!can_create)
                                .label(if this.creating {
                                    "Creating…"
                                } else {
                                    "Create bot"
                                })
                                .on_click(move |_, window, cx| {
                                    create.update(cx, |this, cx| this.create(window, cx))
                                }),
                        ),
                )
        });
    }

    fn open_reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let resetting = view.read(cx).resetting;
            let reset = view.clone();
            dialog
                .w(px(448.0))
                .title(Self::dialog_title(
                    "Reset the token?".into(),
                    "The current token stops working right away and anything running with it disconnects.".into(),
                    cx,
                ))
                .footer(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(Button::new("reset-cancel").ghost().label("Cancel").on_click(|_, window, cx| window.close_dialog(cx)))
                        .child(
                            Button::new("reset-token")
                                .primary()
                                .disabled(resetting)
                                .label(if resetting { "Resetting…" } else { "Reset token" })
                                .on_click(move |_, window, cx| reset.update(cx, |this, cx| this.reset_token(window, cx))),
                        ),
                )
        });
    }

    fn open_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let this = view.read(cx);
            let bot = Self::selected(cx);
            let username = bot
                .as_ref()
                .map(|bot| bot.user.username.clone())
                .unwrap_or_default();
            let name = bot
                .as_ref()
                .map(|bot| bot.user.name().to_string())
                .unwrap_or_default();
            let confirmed = this.delete_confirm.read(cx).value() == username.as_str();
            let deleting = this.deleting;
            let remove = view.clone();
            let mono = cx.theme().mono_font_family.clone();
            dialog
                .w(px(448.0))
                .title(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(
                            div()
                                .text_lg()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(format!("Delete {name}?")),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .text_sm()
                                .font_weight(FontWeight::NORMAL)
                                .text_color(theme::tokens(cx).muted_foreground)
                                .child("This can't be undone. Type\u{a0}")
                                .child(div().font_family(mono).child(username))
                                .child("\u{a0}to confirm."),
                        ),
                )
                .child(Input::new(&this.delete_confirm).text_xs())
                .footer(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("delete-cancel")
                                .ghost()
                                .label("Cancel")
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        )
                        .child(
                            Button::new("delete-bot")
                                .danger()
                                .disabled(deleting || !confirmed)
                                .label(if deleting {
                                    "Deleting…"
                                } else {
                                    "Delete bot"
                                })
                                .on_click(move |_, window, cx| {
                                    remove.update(cx, |this, cx| this.delete_bot(window, cx))
                                }),
                        ),
                )
        });
    }

    // ---- rendering ----

    fn copy_button(&self, what: &'static str, text: String, cx: &mut Context<Self>) -> Button {
        let copied = self.copied == Some(what);
        Button::new(SharedString::from(format!("copy-{what}")))
            .ghost()
            .small()
            .text_color(theme::tokens(cx).muted_foreground)
            .child(if copied {
                icon("check").size(px(14.0)).text_color(rgb(0x10b981))
            } else {
                icon("copy").size(px(14.0))
            })
            .on_click(cx.listener(move |this, _, _, cx| this.copy(what, text.clone(), cx)))
    }

    fn code(&self, what: &'static str, title: &str, text: String, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        div()
            .border_1()
            .border_color(t.border)
            .bg(t.sidebar)
            .child(
                div()
                    .flex()
                    .h_9()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(t.border)
                    .pr_1()
                    .pl_3()
                    .child(
                        div()
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child(title.to_string()),
                    )
                    .child(self.copy_button(what, text.clone(), cx)),
            )
            .child(
                div()
                    .id(what)
                    .overflow_x_scroll()
                    .p_3()
                    .font_family(cx.theme().mono_font_family.clone())
                    .text_xs()
                    .line_height(px(20.0))
                    .whitespace_nowrap()
                    .children(
                        text.lines()
                            .map(|line| div().min_h_5().child(line.to_string())),
                    ),
            )
    }

    fn quickstart_panel(&self, revealed: Option<&str>, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let mono = cx.theme().mono_font_family.clone();
        div()
            .min_w_0()
            .child(
                div()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Run your bot"),
            )
            .child(
                div()
                    .mt_1()
                    .flex()
                    .flex_wrap()
                    .text_sm()
                    .line_height(px(24.0))
                    .text_color(t.muted_foreground)
                    .child(format!(
                        "Install the SDK, {}save the code as bot.ts and start it with\u{a0}",
                        if revealed.is_some() {
                            "put the token in a .env file, "
                        } else {
                            ""
                        }
                    ))
                    .child(div().font_family(mono).text_xs().child("bun bot.ts"))
                    .child("."),
            )
            .child(
                div()
                    .mt_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.code("terminal", "Terminal", "bun add @novarum/sdk".into(), cx))
                    .when_some(revealed, |codes, token| {
                        codes.child(self.code("env", ".env", format!("BOT_TOKEN={token}"), cx))
                    })
                    .child(self.code("bot.ts", "bot.ts", quickstart(&api::base_url()), cx)),
            )
            .child(
                div()
                    .mt_3()
                    .flex()
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .child("More in the\u{a0}")
                    .child(
                        div()
                            .id("bot-guide")
                            .text_color(t.link)
                            .cursor_pointer()
                            .hover(|link| link.underline())
                            .child("bot guide")
                            .on_click(|_, _, cx| {
                                crate::desktop::open_url(
                                    "https://novarum.me/bots/getting-started/",
                                    cx,
                                )
                            }),
                    )
                    .child("."),
            )
    }

    fn render_header(
        &self,
        selected: Option<&DeveloperBot>,
        narrow: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let t = theme::tokens(cx);
        let mut breadcrumb = div()
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .text_sm()
            .font_weight(FontWeight::SEMIBOLD)
            .child(
                icon("bot")
                    .size_5()
                    .flex_shrink_0()
                    .mr(px(2.0))
                    .text_color(t.muted_foreground),
            );
        if let Some(bot) = selected {
            let selected_id = bot.user.user_id.clone();
            breadcrumb = breadcrumb
                .child(
                    div()
                        .id("developers-link")
                        .text_color(t.muted_foreground)
                        .hover(|link| link.text_color(t.foreground))
                        .cursor_pointer()
                        .child("Developers")
                        .on_click(|_, _, cx| Self::open(None, cx)),
                )
                .child(
                    icon("chevron-right")
                        .size_4()
                        .flex_shrink_0()
                        .text_color(t.muted_foreground),
                )
                .child(
                    Button::new("switch-bot")
                        .ghost()
                        .small()
                        .ml(px(-4.0))
                        .px_2()
                        .child(
                            div()
                                .flex()
                                .min_w_0()
                                .items_center()
                                .gap_1()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(div().truncate().child(self.preview_name(bot, cx)))
                                .child(
                                    icon("chevrons-up-down")
                                        .size(px(14.0))
                                        .flex_shrink_0()
                                        .text_color(t.muted_foreground),
                                ),
                        )
                        .dropdown_menu(move |mut menu, _, cx| {
                            let bots = Developers::global(cx).read(cx).bots.clone();
                            for bot in bots {
                                let id = bot.user.user_id.clone();
                                let checked = id == selected_id;
                                menu = menu.item(
                                    PopupMenuItem::element(move |_, cx| {
                                        let name = bot.user.name().to_string();
                                        div()
                                            .flex()
                                            .w_full()
                                            .items_center()
                                            .gap_2()
                                            .child(avatar(
                                                bot.user.avatar_url.as_deref(),
                                                &name,
                                                bot.user.avatar_color.as_deref(),
                                                24.0,
                                                cx,
                                            ))
                                            .child(div().flex_1().min_w_0().truncate().child(name))
                                            .when(checked, |item| {
                                                item.child(icon("check").size(px(14.0)))
                                            })
                                    })
                                    .on_click(move |_, _, cx| Self::open(Some(&id), cx)),
                                );
                            }
                            menu.min_w(px(240.0)).max_h(px(320.0)).scrollable(true)
                        }),
                );
        } else {
            breadcrumb = breadcrumb.child("Developers");
        }
        div()
            .flex()
            .h_12()
            .flex_shrink_0()
            .items_center()
            .gap_3()
            .border_b_1()
            .border_color(t.border)
            .px_4()
            .when(narrow, |header| {
                header.child(
                    Button::new("open-navigation")
                        .ghost()
                        .small()
                        .child(icon("menu").size_5())
                        .on_click(|_, _, cx| ShellState::open_navigation(cx)),
                )
            })
            .child(breadcrumb)
            .child(
                div().ml_auto().flex_shrink_0().child(
                    Button::new("new-bot")
                        .primary()
                        .small()
                        .icon(icon("plus"))
                        .label("New bot")
                        .on_click(cx.listener(|this, _, window, cx| this.open_create(window, cx))),
                ),
            )
    }

    fn render_list(&self, wide: bool, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let developers = Developers::global(cx).read(cx);
        let (loaded, loading, error, bots) = (
            developers.loaded,
            developers.loading,
            developers.error.clone(),
            developers.bots.clone(),
        );
        let mut list = div().flex_1().min_w_0();
        if loaded && bots.is_empty() {
            list = list
                .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child("Make a bot for Novarum"))
                .child(div().mt_2().max_w(px(520.0)).text_sm().line_height(px(24.0)).text_color(t.muted_foreground).child(
                    "A bot is an account your code controls. It can read and send messages in the guilds it is added to, register slash commands and answer with embeds and buttons.",
                ))
                .child(
                    div().mt_4().child(
                        Button::new("first-bot")
                            .primary()
                            .icon(icon("plus"))
                            .label("Make your first bot")
                            .on_click(cx.listener(|this, _, window, cx| this.open_create(window, cx))),
                    ),
                );
        } else if loaded {
            let rows = bots.into_iter().map(|bot| {
                let name = bot.user.name().to_string();
                let id = bot.user.user_id.clone();
                div()
                    .id(SharedString::from(format!("bot-{id}")))
                    .flex()
                    .w_full()
                    .items_center()
                    .gap_3()
                    .border_t_1()
                    .border_color(t.border)
                    .px_3()
                    .py_3()
                    .cursor_pointer()
                    .hover(|row| row.bg(t.card))
                    .child(avatar(
                        bot.user.avatar_url.as_deref(),
                        &name,
                        bot.user.avatar_color.as_deref(),
                        40.0,
                        cx,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .truncate()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(name),
                                    )
                                    .when(!bot.public, |name| {
                                        name.child(
                                            div()
                                                .flex_shrink_0()
                                                .border_1()
                                                .border_color(t.border)
                                                .px_1()
                                                .text_size(px(10.0))
                                                .line_height(px(16.0))
                                                .text_color(t.muted_foreground)
                                                .child("Private"),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .mt(px(2.0))
                                    .truncate()
                                    .text_xs()
                                    .text_color(t.muted_foreground)
                                    .child(bot.handle.clone()),
                            ),
                    )
                    .child(
                        div()
                            .w_24()
                            .flex_shrink_0()
                            .flex()
                            .justify_end()
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child(plural(bot.commands.len(), "command", "commands")),
                    )
                    .child(
                        div()
                            .w_16()
                            .flex_shrink_0()
                            .flex()
                            .justify_end()
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child(plural(bot.guild_count as usize, "guild", "guilds")),
                    )
                    .child(
                        icon("chevron-right")
                            .size_4()
                            .flex_shrink_0()
                            .text_color(t.muted_foreground),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.tab = BotTab::General;
                        Self::open(Some(&id), cx);
                    }))
            });
            list = list
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Your bots"),
                )
                .child(
                    div()
                        .mt_1()
                        .text_sm()
                        .line_height(px(24.0))
                        .text_color(t.muted_foreground)
                        .child("Pick one to change its profile, token or commands."),
                )
                .child(
                    div()
                        .mt_4()
                        .border_b_1()
                        .border_color(t.border)
                        .children(rows),
                );
        } else if loading {
            list = list.child(ui::muted("Loading your bots…", cx));
        }
        if let Some(error) = error {
            list = list.child(
                div()
                    .mt_4()
                    .border_l_2()
                    .border_color(t.destructive)
                    .pl_3()
                    .text_xs()
                    .line_height(px(20.0))
                    .text_color(t.destructive)
                    .child(error),
            );
        }

        let quickstart = self.quickstart_panel(None, cx).flex_1();
        let grid = div().flex().px_8().py_8();
        if wide {
            grid.gap_12().child(list).child(quickstart)
        } else {
            grid.flex_col().gap_10().child(list).child(quickstart)
        }
    }

    fn render_profile(&self, bot: &DeveloperBot, wide: bool, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let name = self.preview_name(bot, cx);
        let about = self.about.read(cx).value().trim().to_string();
        let color = bot
            .user
            .avatar_color
            .as_deref()
            .and_then(ui::hex)
            .unwrap_or(t.primary);
        let created = DateTime::parse_from_rfc3339(&bot.created_at)
            .map(|date| date.format("%b %-d, %Y").to_string())
            .unwrap_or_default();
        let stats = [
            ("Guilds", bot.guild_count.to_string()),
            ("Commands", bot.commands.len().to_string()),
            (
                "Visibility",
                if bot.public {
                    "Public".into()
                } else {
                    "Private".into()
                },
            ),
            ("Created", created),
        ];
        div()
            .when(wide, |aside| {
                aside
                    .w(px(320.0))
                    .flex_shrink_0()
                    .border_l_1()
                    .border_color(t.border)
            })
            .child(div().h(px(if wide { 80.0 } else { 64.0 })).bg(color))
            .child(
                div()
                    .px(px(if wide { 20.0 } else { 32.0 }))
                    .when(wide, |profile| profile.pb_6())
                    .child(
                        div()
                            .relative()
                            .mt(px(-32.0))
                            .w(px(64.0))
                            .child(div().border_4().border_color(t.background).child(avatar(
                                bot.user.avatar_url.as_deref(),
                                &name,
                                bot.user.avatar_color.as_deref(),
                                56.0,
                                cx,
                            )))
                            .child(
                                Button::new("change-avatar")
                                    .outline()
                                    .absolute()
                                    .right(px(-8.0))
                                    .bottom(px(-4.0))
                                    .size_7()
                                    .bg(t.card)
                                    .disabled(self.uploading)
                                    .loading(self.uploading)
                                    .when(!self.uploading, |button| {
                                        button.child(icon("camera").size(px(14.0)))
                                    })
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.pick_avatar(window, cx)
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .mt_3()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(div().truncate().child(name))
                            .child(bot_badge(cx)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .child(
                                div()
                                    .truncate()
                                    .text_xs()
                                    .text_color(t.muted_foreground)
                                    .child(bot.handle.clone()),
                            )
                            .child(self.copy_button("handle", bot.handle.clone(), cx)),
                    )
                    .when(wide, |profile| {
                        profile
                            .child(
                                div()
                                    .mt_3()
                                    .text_sm()
                                    .line_height(px(24.0))
                                    .when(about.is_empty(), |text| {
                                        text.text_color(t.muted_foreground)
                                    })
                                    .child(if about.is_empty() {
                                        "No description yet.".to_string()
                                    } else {
                                        about
                                    }),
                            )
                            .child(
                                div()
                                    .mt_5()
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.0))
                                    .border_t_1()
                                    .border_color(t.border)
                                    .pt_5()
                                    .text_sm()
                                    .children(stats.map(|(label, value)| {
                                        div()
                                            .flex()
                                            .justify_between()
                                            .gap_4()
                                            .child(
                                                div().text_color(t.muted_foreground).child(label),
                                            )
                                            .child(value)
                                    })),
                            )
                    }),
            )
    }

    fn render_general(&self, bot: &DeveloperBot, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let id = bot.user.user_id.clone();
        div()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_5()
                    .child(div().flex().flex_col().gap(px(6.0)).child(ui::label("Display name")).child(Input::new(&self.display_name).text_xs()))
                    .child(div().flex().flex_col().gap(px(6.0)).child(ui::label("About")).child(Textarea::new(&self.about)))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(
                                Button::new("save-bot")
                                    .primary()
                                    .disabled(self.saving)
                                    .label(if self.saving { "Saving…" } else { "Save changes" })
                                    .on_click(cx.listener(|this, _, _, cx| this.save_profile(cx))),
                            )
                            .when(self.saved, |row| row.child(div().text_xs().text_color(rgb(0x10b981)).child("Saved"))),
                    ),
            )
            .child(div().mt_8().child(settings_group(
                None,
                None,
                [
                    settings_row(
                        "Public bot",
                        Some("Anyone who manages a guild can add a public bot. Turn this off and only you can add it.".into()),
                        false,
                        Switch::new("bot-public")
                            .checked(bot.public)
                            .on_click(cx.listener(move |this, checked: &bool, _, cx| this.set_public(id.clone(), *checked, cx))),
                        cx,
                    ),
                    settings_row(
                        "Delete bot",
                        Some("It leaves every guild and its token stops working. Its messages stay.".into()),
                        false,
                        Button::new("delete")
                            .danger()
                            .icon(icon("trash-2"))
                            .label("Delete")
                            .on_click(cx.listener(|this, _, window, cx| this.open_delete(window, cx))),
                        cx,
                    ),
                ],
                cx,
            )))
            .when_some(self.save_error.clone(), |general, error| {
                general.child(div().mt_4().text_xs().text_color(t.destructive).child(error))
            })
    }

    fn render_token(
        &self,
        bot: &DeveloperBot,
        revealed: Option<String>,
        cx: &mut Context<Self>,
    ) -> Div {
        let t = theme::tokens(cx);
        let mono = cx.theme().mono_font_family.clone();
        let name = self.preview_name(bot, cx);
        let token_box = div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .h_9()
            .px_3()
            .border_1()
            .border_color(t.input)
            .font_family(mono)
            .text_xs()
            .when(revealed.is_none(), |field| field.opacity(0.5))
            .child(
                div()
                    .truncate()
                    .child(revealed.clone().unwrap_or_else(|| "•".repeat(40))),
            );
        div()
            .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child("Token"))
            .child(div().mt_1().text_sm().line_height(px(24.0)).text_color(t.muted_foreground).child(format!(
                "Your code logs in as {name} with this token. Anyone who has it controls the bot, so keep it out of your code and never share it."
            )))
            .child(
                div()
                    .mt_4()
                    .flex()
                    .gap_2()
                    .child(div().flex().flex_1().min_w_0().gap_2().child(token_box).when_some(revealed.clone(), |row, token| {
                        let copied = self.copied == Some("token");
                        row.child(
                            Button::new("copy-token")
                                .outline()
                                .child(icon(if copied { "check" } else { "copy" }).size_4())
                                .on_click(cx.listener(move |this, _, _, cx| this.copy("token", token.clone(), cx))),
                        )
                    }))
                    .child(
                        Button::new("reset-token-open")
                            .outline()
                            .icon(icon("key-round"))
                            .label("Reset token")
                            .on_click(cx.listener(|this, _, window, cx| this.open_reset(window, cx))),
                    ),
            )
            .child(if revealed.is_some() {
                div()
                    .mt_2()
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgb(0xf59e0b))
                    .child("Copy it now. You won't be able to see it again.")
            } else {
                div()
                    .mt_2()
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .child("A token is only shown once. If you lost it, reset it to get a new one.")
            })
            .when_some(self.token_error.clone(), |token, error| {
                token.child(div().mt_2().text_xs().text_color(t.destructive).child(error))
            })
            .child(div().mt_10().child(self.quickstart_panel(revealed.as_deref(), cx)))
    }

    fn render_commands(&self, bot: &DeveloperBot, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let mono = cx.theme().mono_font_family.clone();
        let header = div()
            .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child("Slash commands"))
            .child(div().mt_1().text_sm().line_height(px(24.0)).text_color(t.muted_foreground).child(
                "Your bot registers its commands when it starts, and they work in every guild it is in.",
            ));
        if bot.commands.is_empty() {
            return header.child(
                div()
                    .mt_5()
                    .flex()
                    .flex_col()
                    .items_center()
                    .bg(t.card)
                    .px_4()
                    .py_8()
                    .child(
                        icon("square-slash")
                            .size_8()
                            .text_color(t.muted_foreground.opacity(0.5)),
                    )
                    .child(
                        div()
                            .mt_3()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child("No commands yet"),
                    )
                    .child(
                        div()
                            .mt_1()
                            .max_w(px(384.0))
                            .flex()
                            .flex_wrap()
                            .justify_center()
                            .text_xs()
                            .line_height(px(20.0))
                            .text_color(t.muted_foreground)
                            .child("Register them from your code with\u{a0}")
                            .child(div().font_family(mono).child("client.commands.set([...])"))
                            .child(", then reload this page."),
                    ),
            );
        }
        let rows = bot.commands.iter().map(|command| {
            div()
                .px_4()
                .py(px(14.0))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.0))
                        .text_sm()
                        .child(
                            div()
                                .mr_1()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(format!("/{}", command.name)),
                        )
                        .children(command.options.iter().map(|option| {
                            div()
                                .border_1()
                                .border_color(t.border)
                                .px(px(6.0))
                                .text_xs()
                                .line_height(px(20.0))
                                .text_color(if option.required {
                                    t.foreground
                                } else {
                                    t.muted_foreground
                                })
                                .child(format!(
                                    "{}{}",
                                    option.name,
                                    if option.required { "" } else { "?" }
                                ))
                        })),
                )
                .child(
                    div()
                        .mt_1()
                        .text_xs()
                        .text_color(t.muted_foreground)
                        .child(command.description.clone()),
                )
                .into_any_element()
        });
        header.child(div().mt_5().child(settings_group(None, None, rows, cx)))
    }

    fn render_install(&self, bot: &DeveloperBot, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let name = self.preview_name(bot, cx);
        let url = install_url(&bot.handle, self.install_admin);
        let roles = [
            (false, "Member", "Reads and sends messages, like everyone else in the guild."),
            (
                true,
                "Admin",
                "Also manages channels and posts in owner-only channels. Only guild owners can add admin bots.",
            ),
        ]
        .map(|(admin, label, description)| {
            div()
                .id(label)
                .flex()
                .items_start()
                .gap_3()
                .px_4()
                .py(px(14.0))
                .cursor_pointer()
                .child(
                    div().mt(px(2.0)).child(
                        Radio::new(SharedString::from(format!("install-{label}")))
                            .checked(self.install_admin == admin)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.install_admin = admin;
                                cx.notify();
                            })),
                    ),
                )
                .child(
                    div()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(label))
                        .child(div().mt(px(2.0)).text_xs().text_color(t.muted_foreground).child(description)),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.install_admin = admin;
                    cx.notify();
                }))
                .into_any_element()
        });
        let copied = self.copied == Some("link");
        let (copy_url, goto_url) = (url.clone(), url.replace(WEB_ORIGIN, ""));
        div()
            .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child(format!("Add {name} to a guild")))
            .child(div().mt_1().text_sm().line_height(px(24.0)).text_color(t.muted_foreground).child(format!(
                "Share this link. Whoever opens it picks one of their guilds to add {name} to.{}",
                if bot.public { "" } else { " Your bot is private, so only you can use it." }
            )))
            .child(div().mt_5().child(settings_group(None, None, roles, cx)))
            .child(
                div()
                    .mt_5()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(ui::label("Link"))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                div()
                                    .flex()
                                    .flex_1()
                                    .min_w_0()
                                    .items_center()
                                    .h_9()
                                    .px_3()
                                    .border_1()
                                    .border_color(t.input)
                                    .font_family(cx.theme().mono_font_family.clone())
                                    .text_xs()
                                    .child(div().truncate().child(url)),
                            )
                            .child(
                                Button::new("copy-link")
                                    .outline()
                                    .child(icon(if copied { "check" } else { "copy" }).size_4())
                                    .on_click(cx.listener(move |this, _, _, cx| this.copy("link", copy_url.clone(), cx))),
                            ),
                    ),
            )
            .child(
                div().mt_4().child(
                    Button::new("install")
                        .primary()
                        .icon(icon("user-plus"))
                        .label("Add to one of your guilds")
                        .on_click(move |_, _, cx| router::goto(&goto_url, cx)),
                ),
            )
    }
}

impl Render for DevelopersHome {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let developers = Developers::global(cx);
        if !developers.read(cx).loaded
            && !developers.read(cx).loading
            && developers.read(cx).error.is_none()
        {
            developers
                .update(cx, |developers, cx| developers.load(cx))
                .detach();
        }
        let selected = Self::selected(cx);
        self.sync_form(selected.as_ref(), window, cx);
        let width = f32::from(window.viewport_size().width);
        let wide = width >= XL;

        let body = match &selected {
            None => self.render_list(wide, cx),
            Some(bot) => {
                let revealed = developers
                    .read(cx)
                    .revealed_token
                    .as_ref()
                    .filter(|token| token.bot_id == bot.user.user_id)
                    .map(|token| token.token.clone());
                let selected_tab = TABS
                    .iter()
                    .position(|(tab, _, _)| *tab == self.tab)
                    .unwrap_or(0);
                let tabs = TabBar::new("bot-tabs")
                    .underline()
                    .selected_index(selected_tab)
                    .on_click(cx.listener(|this, index: &usize, _, cx| {
                        this.tab = TABS[*index].0;
                        cx.notify();
                    }))
                    .children(TABS.map(|(_, label, icon_name)| {
                        Tab::new().icon(icon(icon_name)).label(label)
                    }));
                let content = match self.tab {
                    BotTab::General => self.render_general(bot, cx),
                    BotTab::Token => self.render_token(bot, revealed, cx),
                    BotTab::Commands => self.render_commands(bot, cx),
                    BotTab::Install => self.render_install(bot, cx),
                };
                let main = div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .border_b_1()
                            .border_color(t.border)
                            .px_8()
                            .pt_3()
                            .child(tabs),
                    )
                    .child(div().max_w(px(672.0)).px_8().py_6().child(content));
                let profile = self.render_profile(bot, wide, cx);
                if wide {
                    div().flex().min_h_full().child(main).child(profile)
                } else {
                    div().flex().flex_col().child(profile).child(main)
                }
            }
        };

        div()
            .flex()
            .flex_1()
            .min_w_0()
            .flex_col()
            .overflow_hidden()
            .bg(t.background)
            .child(self.render_header(selected.as_ref(), width < MD, cx))
            .child(
                div()
                    .id("developers-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{bot_path, install_url, quickstart, valid_bot_username};

    #[test]
    fn builds_bot_paths_and_install_links() {
        assert_eq!(bot_path(None), "/guilds/developers");
        assert_eq!(bot_path(Some("a b")), "/guilds/developers/a%20b");
        assert_eq!(
            install_url("@weather:novarum.me", false),
            "https://app.novarum.me/authorize?bot=%40weather%3Anovarum.me"
        );
        assert!(install_url("@weather:novarum.me", true).ends_with("&role=ADMIN"));
    }

    #[test]
    fn validates_bot_usernames() {
        assert!(valid_bot_username("weather.bot_2"));
        assert!(!valid_bot_username("w"));
        assert!(!valid_bot_username("weather bot"));
        assert!(!valid_bot_username(&"a".repeat(33)));
    }

    #[test]
    fn the_quickstart_points_at_this_homeserver() {
        let code = quickstart("https://anchor.novarum.me");
        assert!(code.contains("baseUrl: 'https://anchor.novarum.me',"));
        assert!(code.contains("${client.user!.tag}"));
    }
}
