// Port of apps/frontend/src/lib/components/guild-settings-dialog.svelte.
use std::{path::PathBuf, rc::Rc};

use gpui_kit::component::{
    ActiveTheme, WindowExt,
    dialog::{DialogDescription, DialogHeader, DialogTitle},
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
};
use serde::Deserialize;

use crate::prelude::*;

use crate::{
    api,
    models::Server,
    state::{
        bots::{add_bot_to_guild, parse_bot_handle, remove_bot_from_guild},
        chat::{Chat, UploadFile, content_type_for},
    },
    ui::avatar::{avatar, avatar_with_fallback},
    views::avatar_crop_dialog::{CropOptions, open_avatar_crop},
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tab {
    Server,
    Members,
    Bots,
    Roles,
}

const TABS: [(Tab, &str, &str); 4] = [
    (Tab::Server, "Server Profile", "cog"),
    (Tab::Members, "Members", "users"),
    (Tab::Bots, "Bots", "bot"),
    (Tab::Roles, "Roles", "tags"),
];

const PICTURE_TYPES: [&str; 4] = ["image/gif", "image/jpeg", "image/png", "image/webp"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvatarPayload {
    avatar_url: String,
}

pub struct GuildSettingsDialog {
    server_id: String,
    tab: Tab,
    bot_handle: Entity<InputState>,
    bot_admin: bool,
    bot_busy: bool,
    bot_message: Option<(bool, String)>,
    uploading: bool,
    upload_error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// Two initials from the name's words (or its parts split on anything not a letter or digit).
pub fn initials_for(name: &str) -> String {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .take(2)
        .filter_map(|part| part.chars().next())
        .flat_map(char::to_uppercase)
        .collect()
}

pub fn open_guild_settings(server: &Server, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| GuildSettingsDialog::new(server.id.clone(), window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.w(px(672.0)).p_6().child(view.clone())
    });
}

impl GuildSettingsDialog {
    fn new(server_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let bot_handle =
            cx.new(|cx| InputState::new(window, cx).placeholder("@weatherbot:novarum.me"));
        let subscriptions = vec![cx.subscribe_in(
            &bot_handle,
            window,
            |this, _, event: &InputEvent, window, cx| {
                match event {
                    InputEvent::Change => this.bot_message = None,
                    InputEvent::PressEnter { .. } => this.add_bot(window, cx),
                    _ => {}
                }
                cx.notify();
            },
        )];
        Self {
            server_id,
            tab: Tab::Server,
            bot_handle,
            bot_admin: false,
            bot_busy: false,
            bot_message: None,
            uploading: false,
            upload_error: None,
            _subscriptions: subscriptions,
        }
    }

    fn add_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = self.bot_handle.read(cx).value().to_string();
        if handle.trim().is_empty() || self.bot_busy {
            return;
        }
        let Some((username, homeserver)) = parse_bot_handle(&handle) else {
            self.bot_message = Some((false, "Use a full handle, like @name:server.".into()));
            return cx.notify();
        };
        self.bot_busy = true;
        cx.notify();
        let (guild_id, role) = (
            self.server_id.clone(),
            if self.bot_admin { "ADMIN" } else { "MEMBER" },
        );
        cx.spawn_in(window, async move |this, cx| {
            let result = add_bot_to_guild(&guild_id, &username, &homeserver, role).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.bot_busy = false;
                this.bot_message = Some(match result {
                    Ok(()) => {
                        this.bot_handle
                            .update(cx, |input, cx| input.set_value("", window, cx));
                        (true, format!("Added @{username}:{homeserver}."))
                    }
                    Err(error) => (false, error),
                });
                cx.notify();
            });
        })
        .detach();
    }

    fn remove_bot(&mut self, user_id: String, cx: &mut Context<Self>) {
        self.bot_busy = true;
        cx.notify();
        let guild_id = self.server_id.clone();
        cx.spawn(async move |this, cx| {
            let result = remove_bot_from_guild(&guild_id, &user_id).await;
            let _ = this.update(cx, |this, cx| {
                this.bot_busy = false;
                this.bot_message = result.err().map(|error| (false, error));
                cx.notify();
            });
        })
        .detach();
    }

    fn pick_picture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let _ = this.update_in(cx, |this, window, cx| this.select_picture(path, window, cx));
        })
        .detach();
    }

    fn select_picture(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(file) = UploadFile::from_path(&path) else {
            self.upload_error = Some("Could not upload the guild picture.".into());
            return cx.notify();
        };
        if !PICTURE_TYPES.contains(&file.content_type.as_str()) {
            self.upload_error = Some("Choose a GIF, JPEG, PNG, or WebP image.".into());
            return cx.notify();
        }
        self.upload_error = None;
        cx.notify();
        if file.content_type == "image/gif" {
            return self.upload_picture(file.bytes, true, cx);
        }
        let this = cx.entity();
        let options = CropOptions {
            title: "Crop Guild Picture".into(),
            description: "Adjust the image to fit your guild icon.".into(),
            action_label: "Use Picture".into(),
            ..Default::default()
        };
        open_avatar_crop(
            file.bytes,
            options,
            Rc::new(move |png, _, cx| {
                this.update(cx, |this, cx| this.upload_picture(png, false, cx))
            }),
            window,
            cx,
        );
    }

    fn upload_picture(&mut self, bytes: Vec<u8>, gif: bool, cx: &mut Context<Self>) {
        self.uploading = true;
        self.upload_error = None;
        cx.notify();
        let name = if gif {
            "guild-avatar.gif"
        } else {
            "guild-avatar.png"
        };
        let file = UploadFile {
            name: name.into(),
            content_type: content_type_for(name).into(),
            bytes,
        };
        let guild_id = self.server_id.clone();
        cx.spawn(async move |this, cx| {
            let result = api::post_file::<AvatarPayload>(
                format!("/guilds/{guild_id}/avatar"),
                "avatar",
                file,
            )
            .await;
            let _ = this.update(cx, |this, cx| {
                this.uploading = false;
                match result {
                    Ok(payload) => Chat::global(cx).update(cx, |chat, cx| {
                        chat.update_guild_avatar(&guild_id, payload.avatar_url, cx)
                    }),
                    Err(_) => {
                        this.upload_error = Some("Could not upload the guild picture.".into())
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_server(&mut self, server: &Server, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let uploading = self.uploading;
        let picture = div()
            .id("guild-picture")
            .group("guild-picture")
            .relative()
            .size_16()
            .flex_shrink_0()
            .overflow_hidden()
            .rounded_full()
            .child(avatar(server.avatar_url.as_deref(), &server.name, None, 64.0, cx).text_lg())
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(white())
                    .when(uploading, |overlay| overlay.bg(black().opacity(0.55)))
                    .group_hover("guild-picture", |overlay| overlay.bg(black().opacity(0.55)))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(2.0))
                            .text_size(px(10.0))
                            .font_weight(FontWeight::MEDIUM)
                            .when(!uploading, |content| content.invisible())
                            .group_hover("guild-picture", |content| content.visible())
                            .child(icon("camera").size_4())
                            .when(uploading, |content| content.child("Uploading...")),
                    ),
            )
            .map(|picture| {
                if uploading {
                    picture.cursor(CursorStyle::OperationNotAllowed)
                } else {
                    picture.cursor_pointer()
                }
            })
            .when(!uploading, |picture| {
                picture.on_click(cx.listener(|this, _, window, cx| this.pick_picture(window, cx)))
            });

        div()
            .flex()
            .flex_col()
            .gap_5()
            .pb_1()
            .child(
                div().flex().items_center().gap_4().child(picture).child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .child("Guild Picture"),
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(t.muted_foreground)
                                .child("GIF, JPEG, PNG, or WebP formats are supported!"),
                        )
                        .when_some(self.upload_error.clone(), |this, error| {
                            this.child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(t.destructive)
                                    .child(error),
                            )
                        }),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(ui::label("Guild Name"))
                    .child(
                        div()
                            .h_9()
                            .px_3()
                            .flex()
                            .items_center()
                            .border_1()
                            .border_color(t.input)
                            .rounded(t.radius)
                            .text_sm()
                            .opacity(0.5)
                            .child(server.name.clone()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(ui::label("Description"))
                    .child(
                        div()
                            .min_h_20()
                            .w_full()
                            .px_3()
                            .py_2()
                            .border_1()
                            .border_color(t.input)
                            .rounded(t.radius)
                            .text_sm()
                            .text_color(t.muted_foreground)
                            .opacity(0.5)
                            .child(
                                server
                                    .description
                                    .clone()
                                    .filter(|description| !description.is_empty())
                                    .unwrap_or("Add a description for your guild".into()),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(t.muted_foreground)
                            .child("More guild settings are coming soon!"),
                    ),
            )
    }

    fn member_row(&self, cx: &App) -> Div {
        let t = theme::tokens(cx);
        div()
            .flex()
            .items_center()
            .gap_3()
            .px_3()
            .py_2()
            .border_1()
            .border_color(t.border)
            .bg(t.card)
            .rounded(t.radius)
    }

    fn render_members(&mut self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let members = Chat::global(cx).read(cx).members.clone();
        let count = members.len();
        let rows = members.into_iter().map(|member| {
            let name = member
                .display_name
                .clone()
                .filter(|name| !name.is_empty())
                .unwrap_or(member.username.clone());
            let id = SharedString::from(member.user_id.clone());
            self.member_row(cx)
                .child(avatar_with_fallback(
                    member.avatar_url.as_deref(),
                    &name,
                    Some(&initials_for(&member.username)),
                    None,
                    32.0,
                    cx,
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .child(name),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(t.muted_foreground)
                                .child(format!("@{}:{}", member.username, member.server)),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_shrink_0()
                        .gap(px(6.0))
                        .child(
                            Button::new(SharedString::from(format!("kick-{id}")))
                                .danger()
                                .xsmall()
                                .label("Kick")
                                .disabled(true),
                        )
                        .child(
                            Button::new(SharedString::from(format!("ban-{id}")))
                                .danger()
                                .xsmall()
                                .label("Ban")
                                .disabled(true),
                        ),
                )
        });
        div()
            .flex()
            .flex_col()
            .gap_3()
            .pb_1()
            .child(
                div()
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .child("Members ")
                    .child(
                        div()
                            .text_color(t.muted_foreground)
                            .child(format!("({count})")),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .children(rows)
                    .when(count == 0, |list| {
                        list.child(
                            div()
                                .text_size(px(11.0))
                                .text_color(t.muted_foreground)
                                .child("No members found."),
                        )
                    }),
            )
    }

    fn render_bots(&mut self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let bots: Vec<_> = Chat::global(cx)
            .read(cx)
            .members
            .iter()
            .filter(|member| member.is_bot)
            .cloned()
            .collect();
        let count = bots.len();
        let empty_handle = self.bot_handle.read(cx).value().trim().is_empty();
        let this = cx.entity();
        let role = Button::new("bot-role")
            .outline()
            .w(px(128.0))
            .label(if self.bot_admin { "Admin" } else { "Member" })
            .dropdown_caret(true)
            .dropdown_menu(move |menu, _, _| {
                let (member, admin) = (this.clone(), this.clone());
                menu.item(PopupMenuItem::new("Member").on_click(move |_, _, cx| {
                    member.update(cx, |this, cx| {
                        this.bot_admin = false;
                        cx.notify();
                    })
                }))
                .item(PopupMenuItem::new("Admin").on_click(move |_, _, cx| {
                    admin.update(cx, |this, cx| {
                        this.bot_admin = true;
                        cx.notify();
                    })
                }))
            });

        let message = match &self.bot_message {
            Some((ok, text)) => {
                div().text_xs().text_color(if *ok { rgb(0x10b981).into() } else { t.destructive }).child(text.clone())
            }
            None => div()
                .text_size(px(11.0))
                .text_color(t.muted_foreground)
                .child("Bots can read and send messages in every channel. Only the guild owner can add admin bots."),
        };

        let rows = bots
            .into_iter()
            .map(|member| {
                let name = member
                    .display_name
                    .clone()
                    .filter(|name| !name.is_empty())
                    .unwrap_or(member.username.clone());
                let user_id = member.user_id.clone();
                self.member_row(cx)
                    .child(avatar(
                        member.avatar_url.as_deref(),
                        &name,
                        member.avatar_color.as_deref(),
                        32.0,
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
                                    .gap(px(6.0))
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(div().truncate().child(name))
                                    .child(bot_badge(cx)),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_xs()
                                    .text_color(t.muted_foreground)
                                    .child(format!("@{}:{}", member.username, member.server)),
                            ),
                    )
                    .child(
                        Button::new(SharedString::from(format!("remove-{user_id}")))
                            .danger()
                            .xsmall()
                            .label("Remove")
                            .disabled(self.bot_busy)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.remove_bot(user_id.clone(), cx)
                            })),
                    )
            })
            .collect::<Vec<_>>();

        div()
            .flex()
            .flex_col()
            .gap_5()
            .pb_1()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(ui::label("Add a bot"))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(div().flex_1().min_w_0().child(Input::new(&self.bot_handle).text_xs()))
                            .child(role)
                            .child(
                                Button::new("add-bot")
                                    .primary()
                                    .label("Add")
                                    .disabled(self.bot_busy || empty_handle)
                                    .on_click(cx.listener(|this, _, window, cx| this.add_bot(window, cx))),
                            ),
                    )
                    .child(message),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .child("In this guild ")
                            .child(div().text_color(t.muted_foreground).child(format!("({count})"))),
                    )
                    .children(rows)
                    .when(count == 0, |list| {
                        list.child(
                            div()
                                .text_size(px(11.0))
                                .text_color(t.muted_foreground)
                                .child("No bots yet. Add one with its handle, or open a bot's invite link."),
                        )
                    }),
            )
    }
}

/// bot-badge.svelte
pub fn bot_badge(cx: &App) -> Div {
    let t = theme::tokens(cx);
    div()
        .flex()
        .flex_shrink_0()
        .h_4()
        .items_center()
        .px_1()
        .bg(t.primary)
        .text_color(t.primary_foreground)
        .text_size(px(10.0))
        .font_weight(FontWeight::SEMIBOLD)
        .child("Bot")
}

impl Render for GuildSettingsDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let Some(server) = Chat::global(cx)
            .read(cx)
            .servers
            .iter()
            .find(|server| server.id == self.server_id)
            .cloned()
        else {
            return div();
        };
        let content = match self.tab {
            Tab::Server => self.render_server(&server, cx),
            Tab::Members => self.render_members(cx),
            Tab::Bots => self.render_bots(cx),
            Tab::Roles => div()
                .text_size(px(11.0))
                .text_color(t.muted_foreground)
                .child("Role management is coming soon™"),
        };
        let accent_foreground = cx.theme().sidebar_accent_foreground;
        let current = self.tab;
        let tabs = TABS.iter().map(|&(tab, label, icon_name)| {
            let active = current == tab;
            div()
                .id(label)
                .flex()
                .w_full()
                .min_h_10()
                .items_center()
                .gap_2()
                .px_2()
                .py(px(6.0))
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .map(|item| {
                    if active {
                        item.bg(t.sidebar_accent).text_color(accent_foreground)
                    } else {
                        item.text_color(t.muted_foreground)
                            .hover(|item| item.text_color(t.foreground))
                    }
                })
                .child(icon(icon_name).size(px(14.0)))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.tab = tab;
                    cx.notify();
                }))
        });

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                DialogHeader::new()
                    .child(DialogTitle::new().child("Guild Settings"))
                    .child(
                        DialogDescription::new().child("Manage how your guild appears to members."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .h(px(420.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_shrink_0()
                            .w(px(176.0))
                            .gap(px(2.0))
                            .pr_2()
                            .border_r_1()
                            .border_color(t.border)
                            .children(tabs),
                    )
                    .child(
                        div()
                            .id("guild-settings-content")
                            .flex_1()
                            .min_w_0()
                            .pl_4()
                            .pr_1()
                            .overflow_y_scroll()
                            .child(content),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::initials_for;

    #[test]
    fn makes_initials() {
        assert_eq!(initials_for("ana.bell"), "AB");
        assert_eq!(initials_for("leo"), "L");
        assert_eq!(initials_for("__"), "");
    }
}
