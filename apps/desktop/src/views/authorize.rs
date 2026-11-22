// Port of apps/frontend/src/routes/authorize/+page.svelte.
use crate::prelude::*;
use gpui_kit::component::{ActiveTheme, radio::Radio, text::TextView};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api,
    models::PublicUser,
    state::{
        router::{self, Router},
        session::Session,
    },
    theme::Tokens,
    ui::{self, avatar::avatar, icon},
    views::auth_card::{amber_500, auth_card, auth_page, big_spinner, card_header, emerald},
};

#[derive(Clone, Deserialize)]
struct Bot {
    user: PublicUser,
    public: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Guild {
    id: String,
    name: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GuildList {
    guilds: Vec<Guild>,
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Member,
    Admin,
}

pub struct AuthorizePage {
    handle: String,
    bot_ref: Option<(String, String)>,
    loading: bool,
    not_found: bool,
    bot: Option<Bot>,
    guilds: Vec<Guild>,
    guild_id: String,
    role: Role,
    adding: bool,
    error: Option<String>,
    added: bool,
}

/// bots.svelte.ts's `parseBotHandle`: `@name:homeserver` or `name:homeserver`.
fn parse_bot_handle(handle: &str) -> Option<(String, String)> {
    let handle = handle.trim();
    let (username, homeserver) = handle.strip_prefix('@').unwrap_or(handle).split_once(':')?;
    let username_ok = (2..=32).contains(&username.chars().count())
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
    let homeserver_ok = !homeserver.is_empty() && !homeserver.chars().any(char::is_whitespace);
    (username_ok && homeserver_ok).then(|| (username.to_string(), homeserver.to_string()))
}

impl AuthorizePage {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let router = Router::global(cx).read(cx);
        let handle = router.param("bot").unwrap_or_default();
        let role = if router.param("role").as_deref() == Some("ADMIN") {
            Role::Admin
        } else {
            Role::Member
        };
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(&router.query)
            .finish();
        let here = if query.is_empty() {
            router.path.clone()
        } else {
            format!("{}?{query}", router.path)
        };
        let bot_ref = parse_bot_handle(&handle);

        let session = Session::global(cx);
        let refresh = (!session.read(cx).initialized).then(|| Session::refresh(cx));
        let lookup = bot_ref.clone();
        cx.spawn(async move |this, cx| {
            let user = match refresh {
                Some(refresh) => refresh.await,
                None => cx.update(|cx| Session::user(cx)),
            };
            if user.is_none() {
                cx.update(|cx| {
                    router::goto(format!("/login?redirect={}", router::encode(&here)), cx)
                });
                return;
            }
            let Some((username, homeserver)) = lookup else {
                let _ = this.update(cx, |this, cx| {
                    this.not_found = true;
                    this.loading = false;
                    cx.notify();
                });
                return;
            };
            let query = [("username", username), ("homeserver", homeserver)];
            let (bot, list) = futures::join!(
                api::get_query::<Bot>("/bots/lookup", &query),
                api::get::<GuildList>("/guilds/list"),
            );
            let _ = this.update(cx, |this, cx| {
                this.bot = bot.ok();
                this.not_found = this.bot.is_none();
                this.guilds = list.map(|list| list.guilds).unwrap_or_default();
                this.guild_id = this
                    .guilds
                    .first()
                    .map(|guild| guild.id.clone())
                    .unwrap_or_default();
                this.loading = false;
                cx.notify();
            });
        })
        .detach();

        Self {
            handle,
            bot_ref,
            loading: true,
            not_found: false,
            bot: None,
            guilds: Vec::new(),
            guild_id: String::new(),
            role,
            adding: false,
            error: None,
            added: false,
        }
    }

    fn add(&mut self, cx: &mut Context<Self>) {
        let Some((username, homeserver)) = self.bot_ref.clone() else {
            return;
        };
        if self.guild_id.is_empty() {
            return;
        }
        self.adding = true;
        cx.notify();
        let role = if self.role == Role::Admin {
            "ADMIN"
        } else {
            "MEMBER"
        };
        let path = format!("/guilds/{}/bots", self.guild_id);
        cx.spawn(async move |this, cx| {
            let result = api::post::<api::Ignored>(
                path,
                json!({ "username": username, "homeserver": homeserver, "role": role }),
            )
            .await;
            let _ = this.update(cx, |this, cx| {
                this.error = result.err().map(|error| {
                    error
                        .body
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Could not add the bot.")
                        .to_string()
                });
                this.adding = false;
                this.added = this.error.is_none();
                cx.notify();
            });
        })
        .detach();
    }

    fn guild(&self) -> Option<&Guild> {
        self.guilds.iter().find(|guild| guild.id == self.guild_id)
    }

    fn render_form(&mut self, bot: Bot, name: String, cx: &mut Context<Self>) -> Div {
        let t = Tokens::dark();
        let header = div()
            .px_6()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(avatar(
                        bot.user.avatar_url.as_deref(),
                        &name,
                        bot.user.avatar_color.as_deref(),
                        48.0,
                        cx,
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(div().truncate().child(name.clone()))
                                    .child(
                                        div()
                                            .flex()
                                            .h_4()
                                            .flex_shrink_0()
                                            .items_center()
                                            .bg(t.primary)
                                            .px_1()
                                            .text_size(px(10.0))
                                            .line_height(relative(1.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(t.primary_foreground)
                                            .child("Bot"),
                                    ),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .font_family(cx.theme().mono_font_family.clone())
                                    .text_xs()
                                    .text_color(t.muted_foreground)
                                    .child(bot.user.handle()),
                            ),
                    ),
            )
            .when_some(
                bot.user.about.clone().filter(|about| !about.is_empty()),
                |header, about| {
                    header.child(
                        div()
                            .mt_3()
                            .text_sm()
                            .text_color(t.foreground.opacity(0.8))
                            .line_clamp(4)
                            .child(TextView::markdown("bot-about", about)),
                    )
                },
            );

        let guilds = if self.guilds.is_empty() {
            ui::muted("You aren't in any guilds yet.", cx).into_any_element()
        } else {
            let last = self.guilds.len() - 1;
            let rows = self
                .guilds
                .clone()
                .into_iter()
                .enumerate()
                .map(|(index, guild)| {
                    let checked = guild.id == self.guild_id;
                    let id = guild.id.clone();
                    let select = cx.listener(move |this, _, _, cx| {
                        this.guild_id = id.clone();
                        cx.notify();
                    });
                    div()
                        .id(SharedString::from(format!("guild-{}", guild.id)))
                        .flex()
                        .items_center()
                        .gap_3()
                        .px_3()
                        .py_2()
                        .cursor_pointer()
                        .when(index != last, |row| row.border_b_1().border_color(t.border))
                        .when(checked, |row| row.bg(t.primary.opacity(0.1)))
                        .when(!checked, |row| row.hover(|s| s.bg(t.muted.opacity(0.4))))
                        .child(
                            Radio::new(SharedString::from(format!("radio-{}", guild.id)))
                                .checked(checked),
                        )
                        .child(avatar(
                            guild.avatar_url.as_deref(),
                            &guild.name,
                            None,
                            28.0,
                            cx,
                        ))
                        .child(div().truncate().text_sm().child(guild.name))
                        .on_click(select)
                });
            div()
                .id("guilds")
                .max_h(px(240.0))
                .overflow_y_scroll()
                .border_1()
                .border_color(t.border)
                .flex()
                .flex_col()
                .children(rows)
                .into_any_element()
        };

        let role_option =
            |role: Role, title: &'static str, detail: &'static str, cx: &mut Context<Self>| {
                div()
                    .id(title)
                    .flex()
                    .items_start()
                    .gap_3()
                    .cursor_pointer()
                    .child(
                        Radio::new(SharedString::from(format!("role-{title}")))
                            .checked(self.role == role)
                            .mt(px(2.0)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().text_sm().child(title))
                            .child(div().text_xs().text_color(t.muted_foreground).child(detail)),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.role = role;
                        cx.notify();
                    }))
            };

        let content = div()
            .px_6()
            .flex()
            .flex_col()
            .gap_5()
            .when(!bot.public, |content| {
                content.child(
                    div()
                        .flex()
                        .gap_2()
                        .border_l_2()
                        .border_color(amber_500())
                        .pl_3()
                        .text_xs()
                        .line_height(px(20.0))
                        .text_color(t.muted_foreground)
                        .child(icon("lock").mt(px(2.0)).size(px(14.0)).flex_shrink_0().text_color(amber_500()))
                        .child("This bot is private. Only the person who made it can add it to guilds."),
                )
            })
            .child(div().flex().flex_col().gap_2().child(ui::label("Add it to")).child(guilds))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(ui::label("As"))
                    .child(role_option(Role::Member, "Member", "Reads and sends messages like everyone else.", cx))
                    .child(role_option(
                        Role::Admin,
                        "Admin",
                        "Also manages channels and posts in owner-only channels. Guild owners only.",
                        cx,
                    )),
            )
            .when_some(self.error.clone(), |content, error| content.child(ui::error_text(error, cx)));

        let guild_name = self.guild().map(|guild| guild.name.clone());
        let footer = div()
            .px_6()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                Button::new("add-bot")
                    .primary()
                    .large()
                    .w_full()
                    .disabled(self.guild_id.is_empty() || self.adding)
                    .when(self.adding, |b| b.loading(true).label("Adding…"))
                    .when(!self.adding, |b| {
                        b.icon(icon("shield-check")).label(match &guild_name {
                            Some(guild) => format!("Add {name} to {guild}"),
                            None => format!("Add {name}"),
                        })
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.add(cx))),
            )
            .child(
                div()
                    .text_center()
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .child(format!(
                        "{name} will see the messages in every channel of the guild."
                    )),
            );

        div()
            .flex()
            .flex_col()
            .gap_6()
            .child(header)
            .child(content)
            .child(footer)
    }
}

impl Render for AuthorizePage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = Tokens::dark();
        let card = auth_card(0.9, cx);
        let name = self
            .bot
            .as_ref()
            .map(|bot| bot.user.name().to_string())
            .unwrap_or_default();

        let card = match (self.loading, self.bot.clone(), self.guild().cloned()) {
            (true, _, _) => card.child(
                div()
                    .px_6()
                    .py_16()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_4()
                    .text_color(t.muted_foreground)
                    .child(big_spinner("bot-loading"))
                    .child(div().text_sm().child("Looking up the bot…")),
            ),
            (_, None, _) => card
                .child(card_header(
                    "Bot not found",
                    Some(
                        div()
                            .child(if self.handle.is_empty() {
                                "This link is missing the bot it should add.".to_string()
                            } else {
                                format!("There's no bot called {}. Check the link with whoever sent it.", self.handle)
                            })
                            .into_any_element(),
                    ),
                ))
                .child(
                    div().px_6().flex().child(
                        Button::new("back")
                            .outline()
                            .label("Back to Novarum")
                            .on_click(|_, _, cx| router::goto("/guilds", cx)),
                    ),
                ),
            (_, Some(_), Some(guild)) if self.added => card
                .child(
                    div()
                        .px_6()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap_1()
                        .text_center()
                        .child(
                            div()
                                .flex()
                                .size_10()
                                .items_center()
                                .justify_center()
                                .bg(emerald(500).opacity(0.15))
                                .text_color(emerald(500))
                                .child(icon("check").size_5()),
                        )
                        .child(
                            div()
                                .mt_2()
                                .text_xl()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(format!("{name} is in {}", guild.name)),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(t.muted_foreground)
                                .child("Try typing / in a channel to see what it can do."),
                        ),
                )
                .child(
                    div().px_6().child(
                        Button::new("go-to-guild")
                            .primary()
                            .w_full()
                            .label(format!("Go to {}", guild.name))
                            .on_click(move |_, _, cx| {
                                router::goto(format!("/guilds/{}", router::encode(&guild.id)), cx)
                            }),
                    ),
                ),
            (_, Some(bot), _) => card.child(self.render_form(bot, name, cx)),
        };
        auth_page(card, false, Some("/guilds"), cx)
    }
}

#[cfg(test)]
mod tests {
    use super::parse_bot_handle;

    #[test]
    fn parses_bot_handles() {
        assert_eq!(
            parse_bot_handle(" @helper:novarum.me "),
            Some(("helper".into(), "novarum.me".into()))
        );
        assert_eq!(
            parse_bot_handle("helper:localhost:5049"),
            Some(("helper".into(), "localhost:5049".into()))
        );
        assert_eq!(parse_bot_handle("h:novarum.me"), None);
        assert_eq!(parse_bot_handle("helper"), None);
        assert_eq!(parse_bot_handle("he lper:x"), None);
    }
}
