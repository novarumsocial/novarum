// Port of apps/frontend/src/lib/components/dm-sidebar.svelte
use chrono::DateTime;
use gpui_kit::component::menu::{ContextMenuExt, PopupMenuItem};

use crate::{
    models::DmType,
    prelude::*,
    state::{
        chat::Chat,
        dms::{DmEntry, Dms, dm_display, dm_path, dm_preview_text},
        friends::Friends,
        notification_settings::{NotificationSettings, Target},
        router::{self, ChatRoute, Router},
        session::Session,
        settings::SettingsStore,
    },
    views::{
        group_settings_dialog::open_group_settings,
        new_dm_dialog::open_new_dm_dialog,
        notification_menu::{Noun, notification_menu},
        profile_card::{emerald, green},
        shell::ShellState,
    },
};

fn timestamp(date: &str) -> i64 {
    DateTime::parse_from_rfc3339(date).map(|date| date.timestamp_millis()).unwrap_or(0)
}

/// Newest conversation first: by its last message, or when you joined it.
pub fn sorted_entries(list: &[DmEntry]) -> Vec<DmEntry> {
    let mut entries = list.to_vec();
    entries.sort_by_key(|dm| std::cmp::Reverse(timestamp(dm.last_message_at.as_deref().unwrap_or(&dm.joined_at))));
    entries
}

pub struct DmSidebar {
    _subscriptions: Vec<Subscription>,
}

impl DmSidebar {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _subscriptions = vec![
            cx.observe(&Dms::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Friends::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Router::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&NotificationSettings::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
        ];
        Self { _subscriptions }
    }
}

/// `itemClass(active)`
fn item(id: impl Into<ElementId>, active: bool, cx: &App) -> Stateful<Div> {
    let t = theme::tokens(cx);
    div()
        .id(id)
        .flex()
        .w_full()
        .items_center()
        .gap(px(6.0))
        .px_2()
        .py_1()
        .text_sm()
        .cursor_pointer()
        .when(active, |item| item.bg(t.primary.opacity(0.1)).text_color(t.sidebar_foreground))
        .when(!active, |item| item.text_color(t.muted_foreground).hover(|s| s.text_color(t.sidebar_foreground)))
}

fn close_dm(id: &str, active: bool, cx: &mut App) {
    let id = id.to_string();
    Dms::global(cx).update(cx, |dms, cx| dms.close(id, cx)).detach();
    if active {
        router::goto("/guilds/dms", cx);
    }
}

fn destructive_item(label: &'static str, cx: &App) -> PopupMenuItem {
    let color = theme::tokens(cx).destructive;
    PopupMenuItem::element(move |_, _| div().text_color(color).child(label))
}

impl Render for DmSidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let route = Router::route(cx);
        let me = Session::user(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let dms = Dms::global(cx).read(cx);
        let entries = sorted_entries(&dms.list);
        let pending = dms.pending.clone();

        let rows: Vec<AnyElement> = entries
            .iter()
            .map(|entry| {
                let display = dm_display(entry);
                let other = display.other.clone();
                let group = entry.kind == DmType::GroupDm;
                let preview = dm_preview_text(entry, me.as_ref())
                    .or_else(|| group.then(|| format!("{} members", entry.participants.len() + 1)));
                let active =
                    matches!(&route, ChatRoute::Dms { channel_id: Some(id), .. } if *id == entry.id);
                let unread = entry.unread
                    && NotificationSettings::global(cx)
                        .read(cx)
                        .shows_unread(Target { channel_id: &entry.id, guild_id: None });
                let in_call = Chat::global(cx).read(cx).voice_states.get(&entry.id).is_some_and(|states| !states.is_empty());
                let online = other.as_ref().is_some_and(|user| Friends::global(cx).read(cx).is_online(&user.user_id));
                let id = entry.id.clone();

                let avatar = div()
                    .relative()
                    .flex_shrink_0()
                    .child(ui::avatar::avatar(
                        display.avatar_url.as_deref(),
                        &display.name,
                        display.avatar_color.as_deref(),
                        24.0,
                        cx,
                    ))
                    .when(online, |avatar| {
                        avatar.child(
                            div()
                                .absolute()
                                .right(px(-1.0))
                                .bottom(px(-1.0))
                                .size(px(10.0))
                                .border_2()
                                .border_color(t.sidebar)
                                .bg(emerald())
                                .when(circle, |dot| dot.rounded_full()),
                        )
                    });

                let close_id = id.clone();
                let row = item(SharedString::from(format!("dm-{id}")), active, cx)
                    .group("dm-row")
                    .child(avatar)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .when(unread, |name| name.font_weight(FontWeight::SEMIBOLD))
                                    .child(display.name.clone()),
                            )
                            .children(preview.map(|preview| {
                                div()
                                    .truncate()
                                    .text_xs()
                                    .text_color(if unread { t.sidebar_foreground } else { t.muted_foreground })
                                    .child(preview)
                            })),
                    )
                    .when(in_call, |row| row.child(icon("phone").size(px(14.0)).flex_shrink_0().text_color(green())))
                    .when(unread, |row| {
                        row.child(div().size(px(6.0)).flex_shrink_0().rounded_full().bg(t.primary))
                    })
                    .child(
                        div()
                            .id(SharedString::from(format!("close-{id}")))
                            .flex_shrink_0()
                            .text_color(t.muted_foreground)
                            .opacity(0.0)
                            .group_hover("dm-row", |s| s.opacity(1.0))
                            .hover(|s| s.text_color(t.sidebar_foreground))
                            .tooltip(|window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new("Close direct message").build(window, cx)
                            })
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                close_dm(&close_id, active, cx);
                            })
                            .child(icon("x").size(px(14.0))),
                    )
                    .on_click({
                        let id = id.clone();
                        move |_, _, cx| router::goto(dm_path(&id, None), cx)
                    });

                let entry = entry.clone();
                let owner = me.as_ref().is_some_and(|me| entry.owner_id.as_deref() == Some(me.id.as_str()));
                row.context_menu(move |menu, window, cx| {
                    let id = entry.id.clone();
                    let other_id = other.as_ref().map(|user| user.user_id.clone());
                    let friend = other_id.as_ref().is_some_and(|user_id| Friends::global(cx).read(cx).is_friend(user_id));
                    let mut menu = notification_menu(menu.min_w(px(224.0)), &id, None, Noun::Conversation, window, cx)
                        .separator()
                        .item(PopupMenuItem::new("Mark as read").on_click({
                            let id = id.clone();
                            move |_, _, cx| Dms::global(cx).update(cx, |dms, cx| dms.mark_read(&id, cx))
                        }))
                        .separator()
                        .item(PopupMenuItem::new("Profile"))
                        .item(PopupMenuItem::new("Start a Call").on_click({
                            let id = id.clone();
                            move |_, _, cx| {
                                router::goto(dm_path(&id, None), cx);
                                ShellState::start_call(&id, cx);
                            }
                        }));
                    if group {
                        if owner {
                            menu = menu.item(PopupMenuItem::new("Group Settings").on_click({
                                let id = id.clone();
                                move |_, window, cx| open_group_settings(id.clone(), window, cx)
                            }));
                        }
                        menu = menu.item(destructive_item("Leave Group", cx).on_click({
                            let id = id.clone();
                            move |_, _, cx| {
                                Dms::global(cx).update(cx, |dms, cx| dms.leave(id.clone(), cx)).detach();
                                if active {
                                    router::goto("/guilds/dms", cx);
                                }
                            }
                        }));
                    } else {
                        menu = menu.item(PopupMenuItem::new("Close DM").on_click({
                            let id = id.clone();
                            move |_, _, cx| close_dm(&id, active, cx)
                        }));
                    }
                    if let Some(user_id) = other_id.clone().filter(|_| friend) {
                        menu = menu.item(PopupMenuItem::new("Remove Friend").on_click(move |_, _, cx| {
                            let user_id = user_id.clone();
                            Friends::global(cx).update(cx, |friends, cx| friends.remove(user_id, cx)).detach();
                        }));
                    }
                    menu.separator()
                        .item(
                            PopupMenuItem::new("Copy User ID")
                                .icon(icon("id-card-lanyard"))
                                .disabled(other_id.is_none())
                                .on_click(move |_, _, cx| {
                                    if let Some(user_id) = &other_id {
                                        cx.write_to_clipboard(ClipboardItem::new_string(user_id.clone()));
                                    }
                                }),
                        )
                        .item(
                            PopupMenuItem::new("Copy Channel ID")
                                .icon(icon("id-card-lanyard"))
                                .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(id.clone()))),
                        )
                })
                .into_any_element()
            })
            .collect();

        let empty = entries.is_empty() && pending.is_empty();
        div().flex().flex_col().w(px(240.0)).h_full().bg(t.sidebar).child(
            div()
                .id("dm-list")
                .flex()
                .flex_col()
                .flex_1()
                .gap(px(2.0))
                .overflow_y_scroll()
                .mt_2()
                .p_2()
                .child(
                    item("friends", route == ChatRoute::Home, cx)
                        .child(icon("users").size_4().flex_shrink_0())
                        .child(div().flex_1().truncate().child("Friends"))
                        .on_click(|_, _, cx| router::goto("/guilds", cx)),
                )
                .child(
                    item("developers", matches!(route, ChatRoute::Developers { .. }), cx)
                        .child(icon("bot").size_4().flex_shrink_0())
                        .child(div().flex_1().truncate().child("Developers"))
                        .on_click(|_, _, cx| router::goto("/guilds/developers", cx)),
                )
                .child(div().mt_3().h_px().flex_shrink_0().bg(t.border))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .px_2()
                        .pt_3()
                        .pb_1()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(t.muted_foreground)
                                .child("DIRECT MESSAGES"),
                        )
                        .child(
                            div()
                                .id("new-dm")
                                .cursor_pointer()
                                .text_color(t.muted_foreground)
                                .hover(|s| s.text_color(t.sidebar_foreground))
                                .tooltip(|window, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new("Start a direct message").build(window, cx)
                                })
                                .on_click(|_, window, cx| open_new_dm_dialog(None, window, cx))
                                .child(icon("plus").size(px(14.0))),
                        ),
                )
                .children(rows)
                .children(pending.into_iter().map(|homeserver| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .px_2()
                        .py_1()
                        .text_xs()
                        .text_color(t.muted_foreground)
                        .child(
                            icon("loader-circle").size(px(14.0)).flex_shrink_0().with_animation(
                                SharedString::from(format!("pending-{homeserver}")),
                                Animation::new(std::time::Duration::from_secs(1)).repeat(),
                                |icon, delta| icon.transform(Transformation::rotate(percentage(delta))),
                            ),
                        )
                        .child(div().flex_1().truncate().child(format!("Waiting for {homeserver}…")))
                }))
                .when(empty, |list| {
                    list.child(
                        div()
                            .mt_4()
                            .px_2()
                            .flex()
                            .justify_center()
                            .text_center()
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child("No direct messages yet :("),
                    )
                }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::sorted_entries;
    use crate::models::{DmChannel, DmType};

    fn dm(id: &str, last: Option<&str>, joined: &str) -> DmChannel {
        DmChannel {
            id: id.into(),
            kind: DmType::Dm,
            participants: vec![],
            name: None,
            icon_url: None,
            owner_id: None,
            last_message_at: last.map(str::to_string),
            last_message: None,
            unread: false,
            joined_at: joined.into(),
        }
    }

    #[test]
    fn sorts_newest_conversations_first() {
        let list = [
            dm("old", Some("2026-01-01T00:00:00.000Z"), "2025-01-01T00:00:00.000Z"),
            dm("joined", None, "2026-03-01T00:00:00.000Z"),
            dm("new", Some("2026-05-01T10:00:00.000Z"), "2025-01-01T00:00:00.000Z"),
        ];
        let ids: Vec<String> = sorted_entries(&list).into_iter().map(|dm| dm.id).collect();
        assert_eq!(ids, ["new", "joined", "old"]);
    }
}
