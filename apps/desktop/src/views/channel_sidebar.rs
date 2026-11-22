// Port of apps/frontend/src/lib/components/channel-sidebar.svelte.
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use gpui_kit::component::{
    Side,
    menu::{ContextMenuExt, DropdownMenu, PopupMenu, PopupMenuItem},
};

use crate::prelude::*;

use crate::{
    models::{Author, Channel, ChannelCategory, ChannelType, Server},
    state::{
        chat::Chat,
        notification_settings::{NotificationSettings, Target},
        settings::SettingsStore,
        voice::{Voice, VoiceState},
    },
    ui::{
        avatar::{DEFAULT_SPEAKING_RING_COLOR, avatar_with_fallback},
        trigger::trigger,
    },
    views::{
        create_channel_dialog::open_create_channel,
        edit_channel_dialog::open_edit_channel,
        guild_settings_dialog::{initials_for, open_guild_settings},
        guild_sidebar::{move_to, sync_order},
        invite_dialog::open_invite,
        notification_menu::{Noun, notification_menu},
        profile_card::profile_card,
        shell::ShellState,
    },
};

/// Tailwind's `-600` shades the web picks from for a participant without an avatar color.
const AVATAR_COLORS: [&str; 12] = [
    "#e11d48", "#0284c7", "#059669", "#d97706", "#9333ea", "#0891b2", "#db2777", "#65a30d", "#4f46e5", "#0d9488",
    "#ea580c", "#7c3aed",
];

const ROSE_400: u32 = 0xfb7185;
const ROSE_600: u32 = 0xe11d48;

/// `avatarBg`: the web's string hash, with JavaScript's 32-bit `<<`.
pub fn avatar_bg(id: &str) -> &'static str {
    let mut hash = 0f64;
    for unit in id.encode_utf16() {
        let shifted = ((hash as i64) as i32).wrapping_shl(5) as f64;
        hash = unit as f64 + (shifted - hash);
    }
    AVATAR_COLORS[(hash.abs() % AVATAR_COLORS.len() as f64) as usize]
}

/// Who's in a voice channel: the server's presence list, plus anyone the live call knows about.
pub fn voice_users(
    presences: &[(String, Option<String>)],
    live: Option<&HashMap<String, VoiceState>>,
) -> Vec<(String, Option<String>)> {
    let mut users = presences.to_vec();
    let mut live_ids: Vec<&String> = live.into_iter().flat_map(|states| states.keys()).collect();
    live_ids.sort();
    for id in live_ids {
        if !users.iter().any(|(user_id, _)| user_id == id) {
            users.push((id.clone(), None));
        }
    }
    users
}

#[derive(Clone)]
struct ChannelDrag {
    category_id: String,
    channel: Channel,
}

impl Render for ChannelDrag {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let channel = &self.channel;
        div()
            .flex()
            .w(px(224.0))
            .items_center()
            .gap(px(6.0))
            .px_2()
            .py_1()
            .text_sm()
            .bg(t.sidebar)
            .opacity(0.9)
            .text_color(t.sidebar_foreground)
            .child(icon(if channel.kind == ChannelType::Voice { "volume-2" } else { "hash" }).size_4())
            .child(div().truncate().child(channel_label(channel)))
    }
}

fn channel_label(channel: &Channel) -> String {
    channel.label.clone().filter(|label| !label.is_empty()).unwrap_or(channel.name.clone())
}

pub struct ChannelSidebar {
    collapsed: HashSet<String>,
    orders: HashMap<String, Vec<String>>,
    /// the category being dragged in and its order when the drag started
    drag_origin: Option<(String, Vec<String>)>,
    reorder_loading: bool,
    delete_text: HashMap<String, String>,
    armed_channel: Option<String>,
    deleting: bool,
    _delete_timer: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl ChannelSidebar {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&NotificationSettings::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Voice::global(cx), |_, _, cx| cx.notify()),
        ];
        Self {
            collapsed: HashSet::new(),
            orders: HashMap::new(),
            drag_origin: None,
            reorder_loading: false,
            delete_text: HashMap::new(),
            armed_channel: None,
            deleting: false,
            _delete_timer: None,
            _subscriptions: subscriptions,
        }
    }

    fn sync_orders(&mut self, categories: &[ChannelCategory]) {
        self.orders = categories
            .iter()
            .map(|category| {
                let incoming: Vec<String> = category.channels.iter().map(|channel| channel.id.clone()).collect();
                let current = self.orders.get(&category.id).cloned().unwrap_or_default();
                (category.id.clone(), sync_order(&current, &incoming))
            })
            .collect();
    }

    /// `handleFinalize`: every channel id in its new order, applied locally then saved.
    fn finalize_drag(&mut self, server_id: String, categories: &[ChannelCategory], cx: &mut Context<Self>) {
        let Some((category_id, origin)) = self.drag_origin.take() else { return };
        if self.orders.get(&category_id) == Some(&origin) {
            return;
        }
        let channel_ids: Vec<String> =
            categories.iter().flat_map(|category| self.orders.get(&category.id).cloned().unwrap_or_default()).collect();
        self.reorder_loading = true;
        let chat = Chat::global(cx);
        let save = chat.update(cx, |chat, cx| {
            chat.reorder_channels(&server_id, &channel_ids, cx);
            chat.save_channel_order(server_id.clone(), channel_ids.clone(), cx)
        });
        cx.spawn(async move |this, cx| {
            save.await;
            let _ = this.update(cx, |this, cx| {
                this.reorder_loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// Asks once ("You sure?") unless shift is held; deleting itself is a TODO on the web too.
    fn delete_channel(&mut self, channel_id: String, shift: bool, cx: &mut Context<Self>) {
        if self.deleting {
            return;
        }
        if !shift && self.armed_channel.as_deref() != Some(channel_id.as_str()) {
            self.delete_text.insert(channel_id.clone(), "You sure?".into());
            self.armed_channel = Some(channel_id.clone());
            self._delete_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(3)).await;
                let _ = this.update(cx, |this, cx| {
                    this.delete_text.insert(channel_id, "Delete Channel".into());
                    this.armed_channel = None;
                    cx.notify();
                });
            }));
            return cx.notify();
        }
        self._delete_timer = None;
        self.delete_text.insert(channel_id, "Delete Channel".into());
        self.armed_channel = None;
        cx.notify();
    }

    fn render_header(&self, server: &Server, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let server = server.clone();
        let shortcut = move |label: &'static str, icon_name: &'static str, destructive: bool| {
            PopupMenuItem::element(move |_, cx| {
                let t = theme::tokens(cx);
                div()
                    .flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .when(destructive, |item| item.text_color(t.destructive))
                    .child(label)
                    .child(icon(icon_name).size_3().text_color(if destructive {
                        t.destructive
                    } else {
                        t.muted_foreground
                    }))
            })
        };
        let name = server.name.clone();
        trigger("guild-menu")
            .flex()
            .h_12()
            .flex_shrink_0()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(t.border)
            .px_4()
            .cursor_pointer()
            .child(
                div()
                    .truncate()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(t.sidebar_foreground)
                    .child(name),
            )
            .child(
                div()
                    .id("guild-menu-chevron")
                    .flex_shrink_0()
                    .text_color(t.muted_foreground)
                    .hover(|chevron| chevron.text_color(t.foreground))
                    .child(icon("chevron-down").size_4()),
            )
            .dropdown_menu_with_anchor(Anchor::TopCenter, move |menu, _, _| {
                let manage = server.can_manage_channels;
                let (invite_id, settings_server, copy_id) = (server.id.clone(), server.clone(), server.id.clone());
                menu.min_w(px(208.0))
                    .when(manage, |menu| {
                        menu.item(
                            shortcut("Invite", "user-round-plus", false)
                                .on_click(move |_, window, cx| open_invite(invite_id.clone(), window, cx)),
                        )
                        .item(
                            shortcut("Settings", "settings", false)
                                .on_click(move |_, window, cx| open_guild_settings(&settings_server, window, cx)),
                        )
                    })
                    .separator()
                    .item(shortcut("Notification Settings", "bell", false))
                    .separator()
                    .item(shortcut("Leave Guild", "log-out", true))
                    .separator()
                    .item(
                        shortcut("Copy Guild ID", "id-card-lanyard", false).on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_id.clone()))
                        }),
                    )
            })
    }

    fn channel_menu(
        &self,
        server: &Server,
        channel: &Channel,
        cx: &mut Context<Self>,
    ) -> impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static {
        let this = cx.entity().downgrade();
        let (server_id, manage) = (server.id.clone(), server.can_manage_channels);
        let channel = channel.clone();
        move |menu, window, cx| {
            let t = theme::tokens(cx);
            let (delete_text, deleting) = this
                .upgrade()
                .map(|this| {
                    let this = this.read(cx);
                    (this.delete_text.get(&channel.id).cloned(), this.deleting)
                })
                .unwrap_or_default();
            let text = channel.kind == ChannelType::Text;
            let copy = |id: String| {
                move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                    cx.write_to_clipboard(ClipboardItem::new_string(id.clone()))
                }
            };
            let menu = menu
                .min_w(px(224.0))
                .check_side(Side::Right)
                .when(text, |menu| {
                    menu.item(
                        PopupMenuItem::new("Mark as Read")
                            .icon(icon("eye"))
                            .disabled(!channel.unread && channel.mention == 0),
                    )
                })
                .item(PopupMenuItem::new("Invite to Channel").icon(icon("user-round-plus")))
                .item(PopupMenuItem::new("Pin Channel to Top").icon(icon("pin")))
                .item(PopupMenuItem::new("Copy Link").icon(icon("link")).on_click(copy(channel.id.clone())))
                .separator();
            let menu = notification_menu(menu, &channel.id, Some(&server_id), Noun::Channel, window, cx).separator();
            let edit = channel.clone();
            let menu = menu.item(
                PopupMenuItem::new("Edit Channel")
                    .icon(icon("pencil"))
                    .on_click(move |_, window, cx| open_edit_channel(edit.clone(), window, cx)),
            );
            let menu = menu.when(manage, |menu| {
                let (owner_guild, owner_channel, owner_only) =
                    (server_id.clone(), channel.id.clone(), channel.owner_only);
                let (this, delete_id) = (this.clone(), channel.id.clone());
                let label = delete_text.unwrap_or("Delete Channel".into());
                menu.when(text, |menu| {
                    menu.item(
                        PopupMenuItem::new("Only Owner Can Send").icon(icon("megaphone")).checked(owner_only).on_click(
                            move |_, _, cx| {
                                let (guild, channel) = (owner_guild.clone(), owner_channel.clone());
                                Chat::global(cx)
                                    .update(cx, |chat, cx| chat.set_owner_only(guild, channel, !owner_only, cx))
                                    .detach();
                            },
                        ),
                    )
                })
                .item(PopupMenuItem::new("Duplicate Channel").icon(icon("copy-plus")))
                .item(
                    PopupMenuItem::element(move |_, _| div().text_color(t.destructive).child(label.clone()))
                        .icon(icon("trash").text_color(t.destructive))
                        .disabled(deleting)
                        .on_click(move |_, window, cx| {
                            let shift = window.modifiers().shift;
                            let id = delete_id.clone();
                            let _ = this.update(cx, |this, cx| this.delete_channel(id, shift, cx));
                        }),
                )
            });
            menu.separator().item(
                PopupMenuItem::new("Copy Channel ID")
                    .icon(icon("id-card-lanyard").size_3())
                    .on_click(copy(channel.id.clone())),
            )
        }
    }

    fn render_channel(
        &self,
        server: &Server,
        category_id: &str,
        channel: &Channel,
        active: bool,
        circle: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::tokens(cx);
        let notifications = NotificationSettings::global(cx).read(cx);
        let target = Target { channel_id: &channel.id, guild_id: Some(&server.id) };
        let show_mention = channel.mention > 0 && notifications.shows_mentions(target);
        let show_unread = channel.unread && notifications.shows_unread(target);
        let bright = show_unread || show_mention;
        let voice = channel.kind == ChannelType::Voice;
        let id = channel.id.clone();

        let row = div()
            .id(SharedString::from(format!("channel-{}", channel.id)))
            .flex()
            .w_full()
            .items_center()
            .gap(px(6.0))
            .px_2()
            .py_1()
            .text_sm()
            .cursor_pointer()
            .map(|row| {
                if active {
                    row.bg(t.primary.opacity(0.1)).text_color(t.sidebar_foreground)
                } else {
                    row.text_color(t.muted_foreground).hover(|row| row.text_color(t.sidebar_foreground))
                }
            })
            .when(self.reorder_loading, |row| row.opacity(0.7))
            .child(
                icon(if voice { "volume-2" } else { "hash" })
                    .size_4()
                    .flex_shrink_0()
                    .when(bright && !voice, |icon| icon.text_color(white())),
            )
            .child(
                div().flex_1().truncate().when(bright, |name| name.text_color(white())).child(channel_label(channel)),
            )
            .when(show_mention, |row| {
                row.child(
                    div()
                        .flex()
                        .size_5()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .bg(t.destructive)
                        .text_size(px(11.0))
                        .font_weight(FontWeight::BOLD)
                        .text_color(t.destructive_foreground)
                        .when(circle, |badge| badge.rounded_full())
                        .child(if channel.mention > 99 { "99+".to_string() } else { channel.mention.to_string() }),
                )
            })
            .when(show_unread && !show_mention, |row| {
                row.child(
                    div()
                        .flex()
                        .size_5()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .child(div().size_2().bg(t.foreground.opacity(0.8)).when(circle, |dot| dot.rounded_full())),
                )
            })
            .on_click(move |_, _, cx| ShellState::select_channel(&id, cx));

        let row = if server.can_manage_channels {
            let drag = ChannelDrag { category_id: category_id.to_string(), channel: channel.clone() };
            let (category, target) = (category_id.to_string(), channel.id.clone());
            row.on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.clone())).on_drag_move(cx.listener(
                move |this, event: &DragMoveEvent<ChannelDrag>, _, cx| {
                    if !event.bounds.contains(&event.event.position) {
                        return;
                    }
                    let drag = event.drag(cx);
                    if drag.category_id != category {
                        return;
                    }
                    let dragged = drag.channel.id.clone();
                    let Some(order) = this.orders.get_mut(&category) else { return };
                    if this.drag_origin.is_none() {
                        this.drag_origin = Some((category.clone(), order.clone()));
                    }
                    if move_to(order, &dragged, &target) {
                        cx.notify();
                    }
                },
            ))
        } else {
            row
        };

        let menu = self.channel_menu(server, channel, cx);
        div()
            .child(row.context_menu(menu))
            .when(voice, |item| item.child(self.render_voice_users(&channel.id, circle, cx)))
            .into_any_element()
    }

    fn render_voice_users(&self, channel_id: &str, circle: bool, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let chat = Chat::global(cx).read(cx);
        let members = chat.members.clone();
        let presences: Vec<(String, Option<String>)> = chat
            .voice_states
            .get(channel_id)
            .into_iter()
            .flatten()
            .map(|presence| (presence.user_id.clone(), presence.name.clone()))
            .collect();
        let voice = Voice::global(cx).read(cx);
        let live = (voice.channel_id.as_deref() == Some(channel_id)).then(|| voice.voice_states.clone());
        let users = voice_users(&presences, live.as_ref());
        if users.is_empty() {
            return div();
        }

        let rows = users.into_iter().map(|(user_id, name)| {
            let member = members.iter().find(|member| member.user_id == user_id).cloned();
            let name = name
                .filter(|name| !name.is_empty())
                .or_else(|| member.as_ref().map(|member| member.name().to_string()))
                .unwrap_or(user_id.clone());
            let state = live.as_ref().and_then(|live| live.get(&user_id)).cloned().unwrap_or_default();
            let ring = member
                .as_ref()
                .and_then(|member| member.speaking_ring_color.as_deref())
                .and_then(ui::hex)
                .or_else(|| ui::hex(DEFAULT_SPEAKING_RING_COLOR))
                .unwrap_or(t.primary);
            let bg =
                member.as_ref().and_then(|member| member.avatar_color.clone()).unwrap_or(avatar_bg(&user_id).into());
            let avatar_url = member.as_ref().and_then(|member| member.avatar_url.clone());
            let rose = |name: &str| icon(name).size(px(14.0)).flex_shrink_0().text_color(rgb(ROSE_400));

            let row = div()
                .flex()
                .w_full()
                .items_center()
                .gap(px(6.0))
                .px_2()
                .py(px(2.0))
                .text_sm()
                .text_color(t.muted_foreground)
                .child(
                    div()
                        .relative()
                        .flex_shrink_0()
                        .child(
                            avatar_with_fallback(
                                avatar_url.as_deref(),
                                &name,
                                Some(&initials_for(&name)),
                                Some(&bg),
                                24.0,
                                cx,
                            )
                            .text_size(px(10.0)),
                        )
                        .when(state.speaking, |avatar| {
                            avatar.child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .border(px(1.5))
                                    .border_color(ring)
                                    .when(circle, |ring| ring.rounded_full())
                                    .child(
                                        div()
                                            .size_full()
                                            .border_1()
                                            .border_color(t.sidebar)
                                            .when(circle, |ring| ring.rounded_full()),
                                    ),
                            )
                        }),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .group_hover("voice-user", |name| name.text_color(t.sidebar_foreground))
                        .child(name.clone()),
                )
                .when(state.self_deafened, |row| row.child(rose("mic-off")).child(rose("headphone-off")))
                .when(state.self_muted && !state.self_deafened, |row| row.child(rose("mic-off")))
                .when(state.camera, |row| row.child(icon("video").size(px(14.0)).flex_shrink_0()))
                .when(state.screen_share, |row| {
                    row.child(
                        div()
                            .flex_shrink_0()
                            .bg(rgb(ROSE_600))
                            .px_1()
                            .py_px()
                            .text_size(px(10.0))
                            .line_height(px(10.0))
                            .font_weight(FontWeight::BOLD)
                            .text_color(white())
                            .when(circle, |live| live.rounded_full())
                            .child("LIVE"),
                    )
                });
            let author = member.unwrap_or_else(|| Author {
                user_id: user_id.clone(),
                username: name.clone(),
                server: String::new(),
                display_name: None,
                avatar_url: None,
                avatar_color: None,
                speaking_ring_color: None,
                banner_url: None,
                about: None,
                is_bot: false,
                status: None,
            });
            div().group("voice-user").flex().w_full().child(profile_card(
                SharedString::from(format!("voice-user-{channel_id}-{user_id}")),
                author,
                None,
                row,
            ))
        });
        div().ml_6().mt(px(2.0)).pb(px(2.0)).flex().flex_col().gap(px(2.0)).children(rows)
    }
}

impl Render for ChannelSidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let chat = Chat::global(cx).read(cx);
        let Some(server) = chat.current_server(cx).cloned() else {
            return div().w(tw(60.0)).h_full().bg(t.sidebar).into_any_element();
        };
        let categories = chat.current_categories(cx).to_vec();
        let active_channel = chat.active_channel(cx);
        if self.drag_origin.is_some() && !cx.has_active_drag() {
            self.finalize_drag(server.id.clone(), &categories, cx);
        }
        self.sync_orders(&categories);
        let circle = SettingsStore::get(cx).circle_icons;

        let mut list =
            div().id("channels").flex_1().min_h_0().overflow_y_scroll().px_2().py_2().flex().flex_col().gap(px(2.0));
        for category in &categories {
            let collapsed = self.collapsed.contains(&category.id);
            let (toggle_id, guild_id, label) = (category.id.clone(), server.id.clone(), category.label.clone());
            list = list.child(
                div()
                    .flex()
                    .w_full()
                    .items_center()
                    .gap_1()
                    .px_1()
                    .py_1()
                    .child(
                        div()
                            .id(SharedString::from(format!("category-{}", category.id)))
                            .flex()
                            .flex_1()
                            .items_center()
                            .gap_1()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(t.muted_foreground)
                            .cursor_pointer()
                            .hover(|toggle| toggle.text_color(t.sidebar_foreground))
                            .child(
                                icon(if collapsed { "chevron-right" } else { "chevron-down" }).size_3().flex_shrink_0(),
                            )
                            .child(category.label.to_uppercase())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.collapsed.remove(&toggle_id) {
                                    this.collapsed.insert(toggle_id.clone());
                                }
                                cx.notify();
                            })),
                    )
                    .when(server.can_manage_channels, |row| {
                        row.child(
                            div()
                                .id(SharedString::from(format!("add-channel-{}", category.id)))
                                .flex_shrink_0()
                                .text_color(t.muted_foreground)
                                .opacity(0.7)
                                .cursor_pointer()
                                .hover(|add| add.opacity(1.0).text_color(t.sidebar_foreground))
                                .child(icon("plus").size_3())
                                .on_click(move |_, window, cx| {
                                    open_create_channel(guild_id.clone(), Some(label.clone()), window, cx)
                                }),
                        )
                    }),
            );
            if !collapsed {
                let order = self.orders.get(&category.id).cloned().unwrap_or_default();
                let channels: Vec<AnyElement> = order
                    .iter()
                    .filter_map(|id| category.channels.iter().find(|channel| &channel.id == id))
                    .map(|channel| {
                        let active = active_channel.as_deref() == Some(channel.id.as_str());
                        self.render_channel(&server, &category.id, channel, active, circle, cx)
                    })
                    .collect();
                list = list.child(div().flex().flex_col().children(channels));
            }
            if !category.channels.is_empty() {
                list = list.child(div().h_1().flex_shrink_0());
            }
        }

        div()
            .flex()
            .flex_col()
            .w(tw(60.0))
            .h_full()
            .flex_shrink_0()
            .bg(t.sidebar)
            .child(self.render_header(&server, cx))
            .child(list)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{avatar_bg, voice_users};
    use crate::state::voice::VoiceState;

    #[test]
    fn hashes_like_the_web() {
        // Math.abs(hash) % 12 from the web for these ids: 6, 4, 6
        assert_eq!(avatar_bg("abc"), "#db2777");
        assert_eq!(avatar_bg("user-1234-xyz"), "#9333ea");
        assert_eq!(avatar_bg("01JABCDEFGHJKMNPQRSTVWXYZ0123456789"), "#db2777");
    }

    #[test]
    fn merges_live_participants() {
        let presences = vec![("a".to_string(), Some("Ana".to_string()))];
        let live = HashMap::from([("a".to_string(), VoiceState::default()), ("b".to_string(), VoiceState::default())]);
        assert_eq!(voice_users(&presences, None), presences);
        assert_eq!(voice_users(&presences, Some(&live)), vec![("a".into(), Some("Ana".into())), ("b".into(), None)]);
    }
}
