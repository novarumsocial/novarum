// Port of apps/frontend/src/routes/i/[code]/+page.svelte.
use std::time::Duration;

use crate::prelude::*;
use gpui_kit::component::{
    ActiveTheme,
    input::{Input, InputState},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api, runtime,
    state::{router, session::Session, settings::SettingsStore},
    theme::Tokens,
    ui::{self, icon},
    views::auth_card::{auth_card, auth_page, big_spinner, card_header, footer_link},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteGuild {
    name: String,
    avatar_url: Option<String>,
    member_count: u32,
}

#[derive(Deserialize)]
struct InviteState {
    guild: InviteGuild,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedGuild {
    guild_id: Option<String>,
    guild: Option<AcceptedGuildRef>,
}

#[derive(Deserialize)]
struct AcceptedGuildRef {
    id: String,
}

pub struct InvitePage {
    raw: String,
    invite_code: String,
    home_server: String,
    normalized_home_server: String,
    user_home_server: String,
    loading: bool,
    accepting: bool,
    error: String,
    invite: Option<InviteGuild>,
    accepted: bool,
    copied: bool,
    invite_link: Entity<InputState>,
    _session: Subscription,
}

/// `code@homeserver`, with an optional leading `$` on the code. Without an `@` the whole thing is
/// used for both, like the web page.
fn parse_invite(raw: &str) -> (String, String) {
    let (code, home_server) = raw.rsplit_once('@').unwrap_or((raw, raw));
    (
        code.strip_prefix('$').unwrap_or(code).to_string(),
        home_server.to_string(),
    )
}

fn initials_for(name: &str) -> String {
    name.split_whitespace()
        .take(2)
        .filter_map(|part| part.chars().next())
        .flat_map(char::to_uppercase)
        .take(2)
        .collect()
}

/// The invite lives on its own home server, so it is looked up there rather than on ours.
async fn lookup_invite(home_server: String, code: String) -> Result<InviteGuild, String> {
    let base_url = api::get_anchor_info(home_server)
        .await
        .map_err(|_| "Could not discover this home server.".to_string())?
        .base_url;
    let url = format!(
        "{}/invite/{}",
        base_url.trim_end_matches('/'),
        router::encode(&code)
    );
    runtime::io(async move {
        let response = api::http()
            .get(&url)
            .send()
            .await
            .ok()
            .filter(|response| response.status().is_success());
        let invite = match response {
            Some(response) => response.json::<InviteState>().await.ok(),
            None => None,
        };
        invite
            .map(|invite| invite.guild)
            .ok_or_else(|| "This invite is invalid or has expired.".to_string())
    })
    .await
}

impl InvitePage {
    pub fn new(raw: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (invite_code, home_server) = parse_invite(&raw);
        let normalized_home_server = api::normalize_home_server(&home_server);
        let invite_url = format!("https://app.novarum.me/i/{raw}");
        let invite_link = cx.new(|cx| InputState::new(window, cx).default_value(invite_url));

        let session = Session::global(cx);
        let _session = cx.observe(&session, |_, _, cx| cx.notify());
        if !session.read(cx).initialized {
            Session::refresh(cx).detach();
        }

        let loading = !invite_code.is_empty() && !home_server.is_empty();
        if loading {
            let lookup = lookup_invite(normalized_home_server.clone(), invite_code.clone());
            cx.spawn(async move |this, cx| {
                let result = lookup.await;
                let _ = this.update(cx, |this, cx| {
                    match result {
                        Ok(invite) => this.invite = Some(invite),
                        Err(error) => this.error = error,
                    }
                    this.loading = false;
                    cx.notify();
                });
            })
            .detach();
        }

        Self {
            raw,
            invite_code,
            home_server,
            normalized_home_server,
            user_home_server: api::anchor().home_server,
            loading,
            accepting: false,
            error: String::new(),
            invite: None,
            accepted: false,
            copied: false,
            invite_link,
            _session,
        }
    }

    fn login_redirect(&self) -> String {
        format!(
            "/login?redirect={}",
            router::encode(&format!("/i/{}", self.raw))
        )
    }

    fn accept(&mut self, cx: &mut Context<Self>) {
        self.accepting = true;
        self.error.clear();
        cx.notify();
        if Session::user(cx).is_none() {
            router::goto(self.login_redirect(), cx);
            return;
        }
        let remote = self.normalized_home_server != self.user_home_server;
        let user_home_server = self.user_home_server.clone();
        let mut body = json!({ "code": self.invite_code });
        if remote {
            body["homeserver"] = json!(self.normalized_home_server);
        }

        cx.spawn(async move |this, cx| {
            if remote && api::set_home_server(&user_home_server).await.is_err() {
                let _ = this.update(cx, |this, cx| {
                    this.error = "Could not discover your home server.".into();
                    this.accepting = false;
                    cx.notify();
                });
                return;
            }
            let result = api::post::<Value>("/invite/accept", body).await;
            let _ = this.update(cx, |this, cx| {
                let (status, error) = match &result {
                    Ok(data) => (
                        200,
                        data.get("error")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    ),
                    Err(error) => (
                        error.status,
                        Some(
                            error
                                .body
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Could not accept invite.")
                                .to_string(),
                        ),
                    ),
                };
                if let Some(error) = error {
                    let lower = error.to_lowercase();
                    if status == 401
                        || ["unauthorized", "not authenticated", "no session"]
                            .iter()
                            .any(|text| lower.contains(text))
                    {
                        router::goto(this.login_redirect(), cx);
                        return;
                    }
                    this.error = error;
                    this.accepting = false;
                    cx.notify();
                    return;
                }
                this.accepted = true;
                cx.notify();
                let guild_id = result
                    .ok()
                    .and_then(|data| serde_json::from_value::<AcceptedGuild>(data).ok())
                    .and_then(|data| data.guild_id.or(data.guild.map(|guild| guild.id)));
                router::goto(
                    match guild_id {
                        Some(id) => format!("/guilds/{}", router::encode(&id)),
                        None => "/guilds".into(),
                    },
                    cx,
                );
            });
        })
        .detach();
    }

    fn copy_invite(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(
            self.invite_link.read(cx).value().to_string(),
        ));
        self.copied = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(500))
                .await;
            let _ = this.update(cx, |this, cx| {
                this.copied = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn render_invite(&mut self, invite: InviteGuild, cx: &mut Context<Self>) -> Div {
        let t = Tokens::dark();
        let circle = SettingsStore::get(cx).circle_icons;
        let avatar = invite
            .avatar_url
            .as_deref()
            .and_then(|url| ui::image::remote_img(url, cx));
        let guild = div()
            .flex()
            .items_center()
            .gap_4()
            .rounded_sm()
            .border_1()
            .border_color(t.border)
            .bg(t.muted.opacity(0.3))
            .px_4()
            .py_3()
            .child(
                div()
                    .flex()
                    .size_10()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .bg(t.primary.opacity(0.2))
                    .text_color(t.primary)
                    .when(circle, |div| div.rounded_full())
                    .map(|div| match avatar {
                        Some(avatar) => div.child(avatar),
                        None if invite.avatar_url.is_some() => div,
                        None => div
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(initials_for(&invite.name)),
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .child(invite.name.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child(icon("users").size_3())
                            .child(format!(
                                "{} member{}",
                                invite.member_count,
                                if invite.member_count == 1 { "" } else { "s" }
                            ))
                            .child(div().mx_1().child("·"))
                            .child(format!("@{}", self.home_server)),
                    ),
            );

        div()
            .flex()
            .flex_col()
            .gap_5()
            .child(guild)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(t.foreground)
                            .child("Invite Link"),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                div().flex_1().min_w_0().child(
                                    Input::new(&self.invite_link)
                                        .readonly(true)
                                        .text_xs()
                                        .font_family(cx.theme().mono_font_family.clone()),
                                ),
                            )
                            .child(
                                Button::new("copy-invite")
                                    .outline()
                                    .icon(icon(if self.copied { "check" } else { "copy" }))
                                    .on_click(cx.listener(|this, _, _, cx| this.copy_invite(cx))),
                            ),
                    ),
            )
            .child(
                Button::new("accept")
                    .primary()
                    .large()
                    .w_full()
                    .disabled(self.accepting)
                    .when(self.accepting, |b| b.loading(true).label("Joining…"))
                    .when(!self.accepting, |b| {
                        b.child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child("Accept Invite")
                                .child(icon("arrow-right").size_4()),
                        )
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.accept(cx))),
            )
    }
}

impl Render for InvitePage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = Tokens::dark();
        let initialized = Session::global(cx).read(cx).initialized;
        let card = auth_card(0.85, cx);
        let description = |text: String| Some(div().child(text).into_any_element());

        let card = if self.loading || !initialized {
            card.child(
                div()
                    .px_6()
                    .py_16()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_4()
                    .text_color(t.muted_foreground)
                    .child(big_spinner("invite-loading"))
                    .child(div().text_sm().child("Looking up invite…")),
            )
        } else if self.accepted {
            let name = self
                .invite
                .as_ref()
                .map_or("the server".to_string(), |invite| invite.name.clone());
            card.child(
                card_header(
                    "You joined the server!",
                    description(format!("Redirecting you to {name}…")),
                )
                .gap_4(),
            )
        } else if !self.error.is_empty() {
            card.child(card_header("Invite not found", description(self.error.clone())).gap_4())
                .child(div().px_6().text_sm().text_color(t.muted_foreground).child(
                    "The invite link you're trying to use may have expired or is invalid. Ask the server owner for a new one.",
                ))
                .child(footer_link("Want to start your own?", "register", "Create an account", |_, _, cx| {
                    router::goto("/register", cx)
                }))
        } else if let Some(invite) = self.invite.clone() {
            card.child(
                div()
                    .px_6()
                    .mt(px(6.0))
                    .flex()
                    .flex_col()
                    .gap_1()
                    .text_center()
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("You're invited!"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(t.muted_foreground)
                            .child("Join your friends on this guild."),
                    ),
            )
            .child(div().px_6().child(self.render_invite(invite, cx)))
            .child(footer_link(
                format!("Not {}?", self.home_server),
                "different-account",
                "Sign in with a different account",
                |_, _, cx| router::goto("/register", cx),
            ))
        } else {
            div()
        };
        auth_page(card, true, None, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::{initials_for, parse_invite};

    #[test]
    fn parses_invite_codes() {
        assert_eq!(
            parse_invite("abc@novarum.me"),
            ("abc".into(), "novarum.me".into())
        );
        assert_eq!(
            parse_invite("$abc@localhost:5049"),
            ("abc".into(), "localhost:5049".into())
        );
        assert_eq!(parse_invite("abc"), ("abc".into(), "abc".into()));
    }

    #[test]
    fn makes_initials() {
        assert_eq!(initials_for("rust lovers club"), "RL");
        assert_eq!(initials_for("  solo "), "S");
    }
}
