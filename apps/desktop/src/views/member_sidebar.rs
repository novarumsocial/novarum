// Port of apps/frontend/src/lib/components/member-sidebar.svelte
use std::rc::Rc;

use gpui_kit::component::menu::{ContextMenuExt, PopupMenu, PopupMenuItem};

use crate::{
    models::{Author, UserStatus},
    prelude::*,
    state::{
        chat::Chat,
        dms::Dms,
        friends::{FriendStatus, Friends},
        router::Router,
        settings::SettingsStore,
    },
    views::{
        profile_card::{OnCall, bot_badge, emerald, profile_card_row},
        shell::ShellState,
    },
};

/// Online members first, then everyone marked offline.
pub fn split_by_status(members: &[Author]) -> (Vec<Author>, Vec<Author>) {
    members
        .iter()
        .cloned()
        .partition(|member| member.status != Some(UserStatus::Offline))
}

pub struct MemberSidebar {
    _subscriptions: Vec<Subscription>,
}

impl MemberSidebar {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _subscriptions = vec![
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Friends::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Router::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
        ];
        Self { _subscriptions }
    }
}

/// `openDm`: only friends have a DM to open; resolves to its channel.
fn open_dm(member: &Author, cx: &mut App) -> Task<Option<String>> {
    let Some(user_id) = Friends::global(cx)
        .read(cx)
        .user_id_for(&member.username, &member.server)
    else {
        return Task::ready(None);
    };
    Dms::global(cx).update(cx, |dms, cx| dms.open(user_id, cx))
}

fn member_menu(menu: PopupMenu, member: &Author, can_manage: bool, cx: &App) -> PopupMenu {
    let destructive = theme::tokens(cx).destructive;
    let danger = move |label: String| {
        PopupMenuItem::element(move |_, _| div().text_color(destructive).child(label.clone()))
    };
    let friend = Friends::global(cx)
        .read(cx)
        .status_for(&member.username, &member.server)
        == FriendStatus::Friend;
    let mention = member.clone();
    let mut menu =
        menu.item(PopupMenuItem::new("Profile"))
            .item(PopupMenuItem::new("Mention").on_click(move |_, _, cx| {
                let member = mention.clone();
                Chat::global(cx).update(cx, |chat, cx| chat.request_mention(member, cx));
            }));
    if friend {
        let (message, call) = (member.clone(), member.clone());
        menu = menu
            .item(
                PopupMenuItem::new("Message")
                    .on_click(move |_, _, cx| open_dm(&message, cx).detach()),
            )
            .item(
                PopupMenuItem::new("Start a Call").on_click(move |_, _, cx| {
                    let open = open_dm(&call, cx);
                    cx.spawn(async move |cx| {
                        if let Some(channel_id) = open.await {
                            cx.update(|cx| ShellState::start_call(&channel_id, cx));
                        }
                    })
                    .detach();
                }),
            );
    }
    menu = menu
        .separator()
        .item(PopupMenuItem::new("Mute"))
        .item(danger("Block".into()));
    if can_manage {
        menu = menu
            .separator()
            .item(PopupMenuItem::new("Roles"))
            .separator()
            .item(danger(format!("Kick {}", member.username)))
            .item(danger(format!("Ban {}", member.username)));
    }
    menu
}

impl Render for MemberSidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let chat = Chat::global(cx).read(cx);
        let can_manage = chat
            .current_server(cx)
            .is_some_and(|server| server.can_manage_channels);
        let (online, offline) = split_by_status(&chat.members);
        let on_call: OnCall = Rc::new(|id, _, cx| ShellState::start_call(id, cx));

        let row = |member: &Author, is_online: bool, cx: &mut Context<Self>| {
            let name = member.name().to_string();
            let avatar = div()
                .relative()
                .child(ui::avatar::avatar(
                    member.avatar_url.as_deref(),
                    &name,
                    member.avatar_color.as_deref(),
                    28.0,
                    cx,
                ))
                .when(is_online, |avatar| {
                    let size = if circle { 11.0 } else { 10.0 };
                    avatar.child(
                        div()
                            .absolute()
                            .right(px(-1.0))
                            .bottom(px(-1.0))
                            .size(px(size))
                            .border_2()
                            .border_color(t.sidebar)
                            .bg(emerald())
                            .when(circle, |dot| dot.rounded_full()),
                    )
                });
            let trigger = div()
                .group("member-row")
                .flex()
                .w_full()
                .items_center()
                .gap_2()
                .px_1()
                .py_1()
                .child(avatar)
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .text_sm()
                                .text_color(t.foreground)
                                .child(name),
                        )
                        .when(is_online && member.is_bot, |row| {
                            row.child(bot_badge(cx).mt(px(2.0)).ml(px(6.0)))
                        })
                        .child(
                            div()
                                .min_w_0()
                                .ml_1()
                                .mt(px(2.0))
                                .truncate()
                                .text_size(px(10.0))
                                .text_color(t.muted_foreground)
                                .opacity(0.0)
                                .group_hover("member-row", |s| s.opacity(1.0))
                                .child(format!("({})", member.server)),
                        ),
                );
            let menu_member = member.clone();
            div()
                .id(SharedString::from(format!("member-{}", member.user_id)))
                .child(profile_card_row(
                    SharedString::from(format!("member-card-{}", member.user_id)),
                    member.clone(),
                    Some(on_call.clone()),
                    trigger,
                ))
                .context_menu(move |menu, _, cx| member_menu(menu, &menu_member, can_manage, cx))
        };
        let online_rows: Vec<_> = online.iter().map(|member| row(member, true, cx)).collect();
        let offline_rows: Vec<_> = offline
            .iter()
            .map(|member| row(member, false, cx))
            .collect();

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(t.sidebar)
            .child(
                div()
                    .h_12()
                    .flex_shrink_0()
                    .border_b_1()
                    .border_color(t.border),
            )
            .child(
                div()
                    .id("members")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .gap_2()
                    .overflow_y_scroll()
                    .px_3()
                    .py_3()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(t.muted_foreground)
                            .child(icon("users").size(px(14.0)))
                            .child(format!("Online - {}", online.len())),
                    )
                    .child(div().flex().flex_col().gap(px(2.0)).children(online_rows))
                    .when(!offline.is_empty(), |list| {
                        list.child(
                            div()
                                .mt_4()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(t.muted_foreground)
                                .child(format!("Offline - {}", offline.len())),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .opacity(0.5)
                                .children(offline_rows),
                        )
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::split_by_status;
    use crate::models::{Author, UserStatus};

    fn member(id: &str, status: Option<UserStatus>) -> Author {
        Author {
            user_id: id.into(),
            username: id.into(),
            server: "x".into(),
            display_name: None,
            avatar_url: None,
            avatar_color: None,
            speaking_ring_color: None,
            banner_url: None,
            about: None,
            is_bot: false,
            status,
        }
    }

    #[test]
    fn splits_online_and_offline() {
        let members = [
            member("a", Some(UserStatus::Online)),
            member("b", Some(UserStatus::Offline)),
            member("c", None),
        ];
        let (online, offline) = split_by_status(&members);
        assert_eq!(
            online
                .iter()
                .map(|m| m.user_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "c"]
        );
        assert_eq!(
            offline
                .iter()
                .map(|m| m.user_id.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
    }
}
