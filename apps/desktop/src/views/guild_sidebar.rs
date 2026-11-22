// Port of apps/frontend/src/lib/components/guild-sidebar.svelte.
use gpui_kit::component::{menu::ContextMenuExt, tooltip::Tooltip};

use crate::prelude::*;

use crate::{
    models::Server,
    state::{
        chat::Chat,
        dms::{DmEntry, Dms, dm_display, dm_path},
        friends::Friends,
        notification_settings::{NotificationSettings, Target},
        router,
        settings::SettingsStore,
    },
    ui::avatar::{avatar, avatar_with_fallback},
    views::{
        create_server_dialog::open_create_server,
        notification_menu::{Noun, notification_menu},
    },
};

/// Keeps the user's current ordering while items are added, removed or updated: known ids stay
/// where they are, new ones go to the end.
pub fn sync_order(current: &[String], incoming: &[String]) -> Vec<String> {
    let kept = current.iter().filter(|id| incoming.contains(id)).cloned();
    let added = incoming.iter().filter(|id| !current.contains(id)).cloned();
    kept.chain(added).collect()
}

/// svelte-dnd-action's "consider": the dragged item takes the hovered item's place.
pub fn move_to(order: &mut Vec<String>, dragged: &str, target: &str) -> bool {
    let (Some(from), Some(to)) = (
        order.iter().position(|id| id == dragged),
        order.iter().position(|id| id == target),
    ) else {
        return false;
    };
    if from == to {
        return false;
    }
    let item = order.remove(from);
    order.insert(to, item);
    true
}

/// `ring-2 ring-primary ring-offset-1 ring-offset-background`, drawn outside the box.
pub fn focus_ring(color: Hsla, circle: bool) -> Div {
    div()
        .absolute()
        .top(px(-3.0))
        .left(px(-3.0))
        .right(px(-3.0))
        .bottom(px(-3.0))
        .border_2()
        .border_color(color)
        .when(circle, |ring| ring.rounded_full())
}

/// The red count in the corner of the home and server buttons.
fn count_badge(count: usize, circle: bool, t: Tokens) -> Div {
    div()
        .absolute()
        .right(px(-6.0))
        .bottom(px(-4.0))
        .flex()
        .h(px(18.0))
        .min_w(px(18.0))
        .items_center()
        .justify_center()
        .px_1()
        .bg(t.destructive)
        .border_2()
        .border_color(t.background)
        .text_size(px(10.0))
        .line_height(px(10.0))
        .font_weight(FontWeight::BOLD)
        .text_color(t.destructive_foreground)
        .when(circle, |badge| badge.rounded_full())
        .child(if count > 99 {
            "99+".to_string()
        } else {
            count.to_string()
        })
}

/// The server being dragged, which is also its own drag preview.
#[derive(Clone)]
struct ServerDrag {
    server: Server,
    circle: bool,
}

impl Render for ServerDrag {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let server = &self.server;
        div()
            .size_10()
            .overflow_hidden()
            .opacity(0.8)
            .bg(if server.down {
                t.destructive
            } else {
                t.primary
            })
            .when(self.circle, |div| div.rounded_full())
            .child(
                avatar_with_fallback(
                    server.avatar_url.as_deref(),
                    &server.name,
                    Some(&server.initials),
                    None,
                    40.0,
                    cx,
                )
                .bg(transparent_black())
                .text_xs()
                .text_color(t.primary_foreground),
            )
    }
}

pub struct GuildSidebar {
    order: Vec<String>,
    /// the order when a drag started, to tell on drop whether anything moved
    drag_origin: Option<Vec<String>>,
    reordering: bool,
    _subscriptions: Vec<Subscription>,
}

impl GuildSidebar {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Dms::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Friends::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&NotificationSettings::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&router::Router::global(cx), |_, _, cx| cx.notify()),
        ];
        Self {
            order: Vec::new(),
            drag_origin: None,
            reordering: false,
            _subscriptions: subscriptions,
        }
    }

    /// Saves the order once a drag ends (`handleFinalize`), wherever the server was let go.
    fn finalize_drag(&mut self, cx: &mut Context<Self>) {
        let Some(origin) = self.drag_origin.take() else {
            return;
        };
        if origin == self.order {
            return;
        }
        self.reordering = true;
        let save =
            Chat::global(cx).update(cx, |chat, cx| chat.reorder_guilds(self.order.clone(), cx));
        cx.spawn(async move |this, cx| {
            save.await;
            let _ = this.update(cx, |this, cx| {
                this.reordering = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn mentions(guild_id: &str, cx: &App) -> usize {
        let notifications = NotificationSettings::global(cx).read(cx);
        Chat::global(cx)
            .read(cx)
            .channels_by_server
            .get(guild_id)
            .into_iter()
            .flatten()
            .flat_map(|category| &category.channels)
            .filter(|channel| {
                notifications.shows_mentions(Target {
                    channel_id: &channel.id,
                    guild_id: Some(guild_id),
                })
            })
            .map(|channel| channel.mention as usize)
            .sum()
    }

    fn unread_dms(cx: &App) -> Vec<DmEntry> {
        let notifications = NotificationSettings::global(cx).read(cx);
        let mut unread: Vec<DmEntry> = Dms::global(cx)
            .read(cx)
            .list
            .iter()
            .filter(|dm| {
                dm.unread
                    && notifications.shows_unread(Target {
                        channel_id: &dm.id,
                        guild_id: None,
                    })
            })
            .cloned()
            .collect();
        unread.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));
        unread
    }

    fn render_home(&self, active: bool, circle: bool, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let requests = Friends::global(cx).read(cx).incoming.len();
        div()
            .id("home")
            .relative()
            .flex()
            .size_10()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(t.muted_foreground)
            .hover(|home| home.text_color(t.foreground))
            .when(circle, |home| home.rounded_full())
            .when(!active, |home| home.opacity(0.7))
            .child(icon("home-sunrise").size(px(26.0)))
            .when(active, |home| home.child(focus_ring(t.primary, circle)))
            .when(requests > 0, |home| {
                home.child(count_badge(requests, circle, t))
            })
            .on_click(|_, _, cx| {
                Chat::global(cx).update(cx, |chat, cx| chat.select_server(None, cx))
            })
            .into_any_element()
    }

    fn render_unread_dm(&self, dm: &DmEntry, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let display = dm_display(dm);
        let path = dm_path(&dm.id, None);
        let name = SharedString::from(display.name.clone());
        div()
            .id(SharedString::from(format!("unread-dm-{}", dm.id)))
            .relative()
            .size_10()
            .flex_shrink_0()
            .cursor_pointer()
            .hover(|button| button.opacity(0.9))
            .child(avatar(
                display.avatar_url.as_deref(),
                &display.name,
                display.avatar_color.as_deref(),
                40.0,
                cx,
            ))
            .child(
                div()
                    .absolute()
                    .right(px(-2.0))
                    .bottom(px(-2.0))
                    .size_3()
                    .rounded_full()
                    .bg(t.destructive)
                    .border_2()
                    .border_color(t.background),
            )
            .tooltip(move |window, cx| Tooltip::new(name.clone()).build(window, cx))
            .on_click(move |_, _, cx| router::goto(&path, cx))
            .into_any_element()
    }

    fn render_server(
        &self,
        server: &Server,
        active: bool,
        circle: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::tokens(cx);
        let mentions = Self::mentions(&server.id, cx);
        let id = server.id.clone();
        let menu_id = server.id.clone();
        let drag = ServerDrag {
            server: server.clone(),
            circle,
        };
        let opacity = if server.down {
            0.4
        } else if active {
            1.0
        } else {
            0.6
        };

        div()
            .id(SharedString::from(format!("server-{}", server.id)))
            .relative()
            .flex()
            .size_10()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .text_xs()
            .font_weight(FontWeight::BOLD)
            .text_color(white())
            .bg(if server.down {
                t.destructive
            } else {
                t.primary
            })
            .when(circle, |button| button.rounded_full())
            .opacity(opacity)
            .when(!server.down, |button| {
                button.hover(|button| button.opacity(0.9))
            })
            .child(
                div()
                    .size_full()
                    .overflow_hidden()
                    .when(circle, |inner| inner.rounded_full())
                    .child(
                        avatar_with_fallback(
                            server.avatar_url.as_deref(),
                            &server.name,
                            Some(&server.initials),
                            None,
                            40.0,
                            cx,
                        )
                        .bg(transparent_black())
                        .text_xs()
                        .text_color(t.primary_foreground),
                    ),
            )
            .when(active, |button| button.child(focus_ring(t.primary, circle)))
            .when(mentions > 0, |button| {
                button.child(count_badge(mentions, circle, t))
            })
            .map(|button| {
                if server.down {
                    button.cursor(CursorStyle::OperationNotAllowed)
                } else {
                    button.cursor_pointer().on_click(move |_, _, cx| {
                        Chat::global(cx).update(cx, |chat, cx| chat.select_server(Some(&id), cx))
                    })
                }
            })
            .on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.clone()))
            .on_drag_move(cx.listener({
                let target = server.id.clone();
                move |this, event: &DragMoveEvent<ServerDrag>, _, cx| {
                    if !event.bounds.contains(&event.event.position) {
                        return;
                    }
                    let dragged = event.drag(cx).server.id.clone();
                    this.drag_origin.get_or_insert_with(|| this.order.clone());
                    if move_to(&mut this.order, &dragged, &target) {
                        cx.notify();
                    }
                }
            }))
            .context_menu(move |menu, window, cx| {
                notification_menu(
                    menu.min_w(px(224.0)),
                    &menu_id,
                    None,
                    Noun::Server,
                    window,
                    cx,
                )
            })
            .into_any_element()
    }
}

impl Render for GuildSidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.drag_origin.is_some() && !cx.has_active_drag() {
            self.finalize_drag(cx);
        }
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let chat = Chat::global(cx).read(cx);
        let active = chat.active_server(cx);
        let servers: Vec<Server> = chat
            .servers
            .iter()
            .filter(|server| server.id != "home")
            .cloned()
            .collect();
        let ids: Vec<String> = servers.iter().map(|server| server.id.clone()).collect();
        self.order = sync_order(&self.order, &ids);

        let unread_dms = Self::unread_dms(cx);
        let home = self.render_home(active.is_none(), circle, cx);
        let dms: Vec<_> = unread_dms
            .iter()
            .map(|dm| self.render_unread_dm(dm, cx))
            .collect();
        let order = self.order.clone();
        let server_buttons: Vec<_> = order
            .iter()
            .filter_map(|id| servers.iter().find(|server| &server.id == id))
            .map(|server| {
                let active = active.as_deref() == Some(server.id.as_str());
                self.render_server(server, active, circle, cx)
            })
            .collect();

        div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .w(tw(14.0))
            .h_full()
            .items_center()
            .gap(px(6.0))
            .border_r_1()
            .border_color(t.border)
            .bg(t.background)
            .py_3()
            .child(home)
            .children(dms)
            .child(
                div()
                    .my(px(2.0))
                    .h_px()
                    .w_7()
                    .flex_shrink_0()
                    .bg(t.border.opacity(0.5)),
            )
            .child(
                div()
                    .id("servers")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .items_center()
                    .gap(px(6.0))
                    .pt(px(3.0))
                    .overflow_y_scroll()
                    .when(self.reordering, |list| list.opacity(0.7))
                    .children(server_buttons),
            )
            .child(
                div()
                    .mt_auto()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .id("add-server")
                            .flex()
                            .size_10()
                            .items_center()
                            .justify_center()
                            .border_1()
                            .border_dashed()
                            .border_color(t.muted_foreground.opacity(0.3))
                            .text_color(t.muted_foreground)
                            .cursor_pointer()
                            .when(circle, |button| button.rounded_full())
                            .hover(|button| {
                                button
                                    .border_color(t.muted_foreground)
                                    .text_color(t.foreground)
                            })
                            .child(icon("plus").size_4())
                            .tooltip(|window, cx| Tooltip::new("Add server").build(window, cx))
                            .on_click(|_, window, cx| open_create_server(window, cx)),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{move_to, sync_order};

    fn ids(items: &[&str]) -> Vec<String> {
        items.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn sync_keeps_local_order() {
        assert_eq!(
            sync_order(&ids(&["b", "a"]), &ids(&["a", "b", "c"])),
            ids(&["b", "a", "c"])
        );
        assert_eq!(
            sync_order(&ids(&["b", "x", "a"]), &ids(&["a", "b"])),
            ids(&["b", "a"])
        );
        assert_eq!(sync_order(&[], &ids(&["a"])), ids(&["a"]));
    }

    #[test]
    fn moves_into_the_hovered_place() {
        let mut order = ids(&["a", "b", "c", "d"]);
        assert!(move_to(&mut order, "a", "c"));
        assert_eq!(order, ids(&["b", "c", "a", "d"]));
        assert!(move_to(&mut order, "d", "b"));
        assert_eq!(order, ids(&["d", "b", "c", "a"]));
        assert!(!move_to(&mut order, "d", "d"));
        assert!(!move_to(&mut order, "z", "d"));
    }
}
