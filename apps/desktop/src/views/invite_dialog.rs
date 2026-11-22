// Port of apps/frontend/src/lib/components/invite-dialog.svelte.
use std::time::Duration;

use gpui_kit::component::{
    ActiveTheme, WindowExt,
    dialog::{DialogDescription, DialogHeader, DialogTitle},
    input::{Input, InputEvent, InputState},
};

use crate::prelude::*;

use crate::{
    api,
    state::{
        chat::Chat,
        dms::Dms,
        friends::{FriendEntry, Friends},
    },
    ui::avatar::avatar,
};

/// The web app's origin, which `window.location.origin` is on the web.
const WEB_ORIGIN: &str = "https://app.novarum.me";

pub struct InviteDialog {
    guild_id: String,
    code: String,
    copied: bool,
    loading: bool,
    query: Entity<InputState>,
    link: Entity<InputState>,
    inviting: Option<String>,
    invited: Vec<String>,
    _subscriptions: Vec<Subscription>,
}

fn name_for(entry: &FriendEntry) -> String {
    entry
        .user
        .display_name
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or(entry.user.username.clone())
}

fn handle_for(entry: &FriendEntry) -> String {
    format!("@{}:{}", entry.user.username, entry.user.homeserver)
}

/// Friends who aren't in the guild yet, matching the search by name or handle.
pub fn visible_friends<'a>(
    accepted: &'a [FriendEntry],
    member_ids: &[&str],
    query: &str,
) -> Vec<&'a FriendEntry> {
    let query = query.trim().to_lowercase();
    accepted
        .iter()
        .filter(|entry| !member_ids.contains(&entry.user.user_id.as_str()))
        .filter(|entry| {
            query.is_empty()
                || name_for(entry).to_lowercase().contains(&query)
                || handle_for(entry).to_lowercase().contains(&query)
        })
        .collect()
}

pub fn open_invite(guild_id: String, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| InviteDialog::new(guild_id, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.w(px(448.0)).p_6().child(view.clone())
    });
}

impl InviteDialog {
    fn new(guild_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search friends"));
        let link = cx.new(|cx| InputState::new(window, cx));
        let subscriptions = vec![cx.subscribe(&query, |_, _, _: &InputEvent, cx| cx.notify())];
        let mut this = Self {
            guild_id,
            code: String::new(),
            copied: false,
            loading: false,
            query,
            link,
            inviting: None,
            invited: Vec::new(),
            _subscriptions: subscriptions,
        };
        this.fetch_invite(window, cx);
        this
    }

    fn invite_url(&self) -> String {
        format!("{WEB_ORIGIN}/i/{}@{}", self.code, api::anchor().home_server)
    }

    fn set_code(&mut self, code: String, window: &mut Window, cx: &mut Context<Self>) {
        self.code = code;
        let url = self.invite_url();
        self.link
            .update(cx, |link, cx| link.set_value(url, window, cx));
    }

    fn fetch_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.loading = true;
        let get = Chat::global(cx).update(cx, |chat, cx| {
            chat.get_guild_invite(self.guild_id.clone(), cx)
        });
        cx.spawn_in(window, async move |this, cx| {
            let invite = get.await;
            let _ = this.update_in(cx, |this, window, cx| match invite {
                Some(invite) => {
                    this.set_code(invite.code, window, cx);
                    this.loading = false;
                    cx.notify();
                }
                None => this.create_invite(window, cx),
            });
        })
        .detach();
    }

    fn create_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.loading = true;
        cx.notify();
        let create = Chat::global(cx).update(cx, |chat, cx| {
            chat.create_guild_invite(self.guild_id.clone(), cx)
        });
        cx.spawn_in(window, async move |this, cx| {
            let invite = create.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(invite) = invite {
                    this.set_code(invite.code, window, cx);
                }
                this.loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn regenerate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.copied = false;
        self.invited.clear();
        self.create_invite(window, cx);
    }

    fn copy(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(self.invite_url()));
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

    fn invite_friend(&mut self, user_id: String, cx: &mut Context<Self>) {
        self.inviting = Some(user_id.clone());
        cx.notify();
        let url = self.invite_url();
        let ensure = Dms::global(cx).update(cx, |dms, cx| dms.ensure(user_id.clone(), cx));
        cx.spawn(async move |this, cx| {
            let sent = match ensure.await {
                Some(channel_id) => {
                    let send = cx.update(|cx| {
                        Chat::global(cx).update(cx, |chat, cx| {
                            chat.send_message(channel_id, Some(url), vec![], None, cx)
                        })
                    });
                    let _ = send.await;
                    true
                }
                None => false,
            };
            let _ = this.update(cx, |this, cx| {
                if sent {
                    this.invited.push(user_id);
                }
                this.inviting = None;
                cx.notify();
            });
        })
        .detach();
    }

    fn render_friends(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let friends = Friends::global(cx).read(cx).accepted.clone();
        let empty = |text: &'static str| {
            div()
                .py_6()
                .text_center()
                .text_sm()
                .text_color(t.muted_foreground)
                .child(text)
                .into_any_element()
        };
        if friends.is_empty() {
            return empty("You don't have any friends yet.");
        }
        let members: Vec<String> = Chat::global(cx)
            .read(cx)
            .members
            .iter()
            .map(|member| member.user_id.clone())
            .collect();
        let member_ids: Vec<&str> = members.iter().map(String::as_str).collect();
        let query = self.query.read(cx).value().to_string();
        let visible: Vec<FriendEntry> = visible_friends(&friends, &member_ids, &query)
            .into_iter()
            .cloned()
            .collect();
        if visible.is_empty() {
            return empty("No matches.");
        }

        let rows = visible.into_iter().map(|entry| {
            let name = name_for(&entry);
            let user_id = entry.user.user_id.clone();
            let sent = self.invited.contains(&user_id);
            let inviting = self.inviting.as_deref() == Some(user_id.as_str());
            let button = Button::new(SharedString::from(format!("invite-{user_id}")))
                .outline()
                .small()
                .disabled(inviting || sent || self.loading)
                .map(|button| {
                    if sent {
                        button.icon(icon("check"))
                    } else {
                        button.label(if inviting { "Inviting…" } else { "Invite" })
                    }
                })
                .on_click(
                    cx.listener(move |this, _, _, cx| this.invite_friend(user_id.clone(), cx)),
                );
            div()
                .flex()
                .w_full()
                .items_center()
                .gap(px(10.0))
                .px_2()
                .py(px(6.0))
                .text_sm()
                .child(avatar(
                    entry.user.avatar_url.as_deref(),
                    &name,
                    entry.user.avatar_color.as_deref(),
                    32.0,
                    cx,
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(div().truncate().font_weight(FontWeight::MEDIUM).child(name))
                        .child(
                            div()
                                .truncate()
                                .font_family(cx.theme().mono_font_family.clone())
                                .text_size(px(10.0))
                                .text_color(t.muted_foreground)
                                .child(handle_for(&entry)),
                        ),
                )
                .child(button)
        });
        div()
            .id("invite-friends")
            .max_h(px(224.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .children(rows)
            .into_any_element()
    }
}

impl Render for InviteDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let label =
            |text: &'static str| div().text_xs().font_weight(FontWeight::MEDIUM).child(text);

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(DialogHeader::new().child(DialogTitle::new().child("Invite People")).child(
                DialogDescription::new().child(
                    "Share this link to let people join the server. It's active indefinitely until regenerated.",
                ),
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(label("Invite Friends"))
                    .child(Input::new(&self.query).prefix(icon("search").size_4().text_color(t.muted_foreground)))
                    .child(self.render_friends(cx)),
            )
            .child(label("Invite Link"))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.link)
                                .readonly(true)
                                .text_xs()
                                .font_family(cx.theme().mono_font_family.clone()),
                        ),
                    )
                    .child(
                        Button::new("copy-invite")
                            .outline()
                            .disabled(self.loading)
                            .icon(icon(if self.copied { "check" } else { "copy" }))
                            .tooltip("Copy invite link")
                            .on_click(cx.listener(|this, _, _, cx| this.copy(cx))),
                    )
                    .child(
                        Button::new("regenerate-invite")
                            .outline()
                            .disabled(self.loading)
                            .icon(icon("refresh-cw"))
                            .tooltip("Regenerate invite link")
                            .on_click(cx.listener(|this, _, window, cx| this.regenerate(window, cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::visible_friends;
    use crate::{
        models::{PublicUser, UserStatus},
        state::friends::FriendEntry,
    };

    fn friend(id: &str, username: &str, display_name: Option<&str>) -> FriendEntry {
        FriendEntry {
            user: PublicUser {
                user_id: id.into(),
                username: username.into(),
                homeserver: "novarum.me".into(),
                display_name: display_name.map(Into::into),
                avatar_url: None,
                avatar_color: None,
                speaking_ring_color: None,
                banner_url: None,
                about: None,
                is_bot: false,
            },
            status: UserStatus::Online,
            created_at: String::new(),
            accepted_at: None,
        }
    }

    #[test]
    fn filters_members_and_search() {
        let friends = vec![
            friend("1", "ana", Some("Ana B")),
            friend("2", "leo", None),
            friend("3", "max", None),
        ];
        let ids = |list: Vec<&FriendEntry>| {
            list.iter()
                .map(|entry| entry.user.user_id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(visible_friends(&friends, &["3"], "")), ["1", "2"]);
        assert_eq!(ids(visible_friends(&friends, &[], " ANA ")), ["1"]);
        assert_eq!(ids(visible_friends(&friends, &[], "@leo:novarum")), ["2"]);
    }
}
