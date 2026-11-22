// Port of apps/frontend/src/lib/components/friends-home.svelte
use std::sync::LazyLock;

use gpui_kit::component::{
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
};
use regex::Regex;

use crate::{
    models::UserStatus,
    prelude::*,
    state::{
        dms::Dms,
        friends::{FriendEntry, Friends},
        settings::SettingsStore,
    },
    views::{
        profile_card::{emerald, neutral_500},
        shell::{MD, ShellState},
    },
};

const SM: f32 = 640.0;
const XL: f32 = 1280.0;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Online,
    All,
    Pending,
    Add,
}

/// Search by name or handle, like the web's `nameFor`/`handleFor` match.
pub fn matches_query(entry: &FriendEntry, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || entry.user.name().to_lowercase().contains(&query)
        || entry.user.handle().to_lowercase().contains(&query)
}

/// The Online/All list: filtered by the search, online friends first.
pub fn friend_list(accepted: &[FriendEntry], online_only: bool, query: &str) -> Vec<FriendEntry> {
    let mut list: Vec<FriendEntry> = accepted
        .iter()
        .filter(|entry| {
            (!online_only || entry.status == UserStatus::Online) && matches_query(entry, query)
        })
        .cloned()
        .collect();
    list.sort_by_key(|entry| entry.status != UserStatus::Online);
    list
}

/// `handleSchema`: "@name:server" or "name:server", split into username and homeserver.
pub fn parse_handle(handle: &str) -> Result<(String, String), &'static str> {
    static HANDLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@?[^:\s@]+:\S+$").unwrap());
    let handle = handle.trim();
    if !HANDLE.is_match(handle) {
        return Err("Use a full handle, like @name:server.");
    }
    let (username, homeserver) = handle
        .trim_start_matches('@')
        .split_once(':')
        .unwrap_or_default();
    Ok((username.into(), homeserver.into()))
}

pub struct FriendsHome {
    tab: Tab,
    query: Entity<InputState>,
    handle: Entity<InputState>,
    add_result: Option<(bool, String)>,
    _subscriptions: Vec<Subscription>,
}

impl FriendsHome {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search"));
        let handle = cx.new(|cx| InputState::new(window, cx).placeholder("@name:server"));
        let _subscriptions = vec![
            cx.observe(&Friends::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&ShellState::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&query, |_, _, cx| cx.notify()),
            cx.subscribe_in(
                &handle,
                window,
                |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::PressEnter { .. } => this.send_request(window, cx),
                    InputEvent::Change => {
                        this.add_result = None;
                        cx.notify();
                    }
                    _ => cx.notify(),
                },
            ),
        ];
        Self {
            tab: Tab::Online,
            query,
            handle,
            add_result: None,
            _subscriptions,
        }
    }

    fn set_tab(&mut self, tab: Tab, window: &mut Window, cx: &mut Context<Self>) {
        self.tab = tab;
        if tab == Tab::Add {
            self.handle.update(cx, |input, cx| input.focus(window, cx));
        }
        cx.notify();
    }

    fn send_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = self.handle.read(cx).value().trim().to_string();
        let (username, homeserver) = match parse_handle(&handle) {
            Ok(parts) => parts,
            Err(message) => {
                self.add_result = Some((false, message.into()));
                cx.notify();
                return;
            }
        };
        let friends = Friends::global(cx);
        let request = friends.update(cx, |friends, cx| {
            friends.request(handle, &username, &homeserver, cx)
        });
        cx.spawn_in(window, async move |this, cx| {
            let sent = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.add_result = Some(if sent {
                    this.handle
                        .update(cx, |input, cx| input.set_value("", window, cx));
                    (
                        true,
                        format!("Friend request sent to @{username}:{homeserver}."),
                    )
                } else {
                    let error = friends.read(cx).error.clone();
                    (
                        false,
                        error.unwrap_or_else(|| "Could not send the friend request.".into()),
                    )
                });
                cx.notify();
            });
        })
        .detach();
    }

    /// The `person` snippet: avatar with a presence dot, name and subtitle.
    fn person(
        entry: &FriendEntry,
        subtitle: &str,
        size: f32,
        group: &'static str,
        cx: &mut App,
    ) -> [Div; 2] {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let name = entry.user.name().to_string();
        let avatar = div()
            .relative()
            .flex_shrink_0()
            .child(ui::avatar::avatar(
                entry.user.avatar_url.as_deref(),
                &name,
                entry.user.avatar_color.as_deref(),
                size,
                cx,
            ))
            .child(
                div()
                    .absolute()
                    .right(px(-4.0))
                    .bottom(px(-4.0))
                    .size(px(14.0))
                    .border(px(3.0))
                    .border_color(t.background)
                    .group_hover(group, |s| s.border_color(t.card))
                    .bg(if entry.status == UserStatus::Online {
                        emerald()
                    } else {
                        neutral_500()
                    })
                    .when(circle, |dot| dot.rounded_full()),
            );
        let text = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .min_w_0()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(div().truncate().child(name))
                    .child(
                        div()
                            .ml_1()
                            .flex_shrink_0()
                            .text_size(px(10.0))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(t.muted_foreground)
                            .opacity(0.0)
                            .group_hover(group, |s| s.opacity(1.0))
                            .child(format!("({})", entry.user.homeserver)),
                    ),
            )
            .child(
                div()
                    .mt(px(2.0))
                    .truncate()
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .child(subtitle.to_string()),
            );
        [avatar, text]
    }

    /// The `action` snippet: a square ghost icon button.
    fn action(
        id: SharedString,
        icon_name: &str,
        tone: Option<Hsla>,
        disabled: bool,
        group: &'static str,
        on_click: impl Fn(&mut App) + 'static,
        cx: &App,
    ) -> Stateful<Div> {
        let t = theme::tokens(cx);
        div()
            .id(id.clone())
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .size_9()
            .rounded(t.radius)
            .bg(t.card)
            .text_color(t.muted_foreground)
            .group_hover(group, |s| s.bg(t.background))
            .when(disabled, |button| button.opacity(0.5))
            .when(!disabled, |button| {
                button
                    .cursor_pointer()
                    .hover(move |s| s.text_color(tone.unwrap_or(t.foreground)).bg(t.accent))
                    .on_click(move |_, _, cx| on_click(cx))
            })
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(id.clone()).build(window, cx)
            })
            .child(icon(icon_name).size_4())
    }

    fn empty(title: &str, body: &str, cx: &App) -> Div {
        let t = theme::tokens(cx);
        div()
            .flex()
            .flex_col()
            .flex_1()
            .items_center()
            .justify_center()
            .px_6()
            .py_16()
            .child(
                icon("users")
                    .size_10()
                    .text_color(t.muted_foreground.opacity(0.5)),
            )
            .child(
                div()
                    .mt_4()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(title.to_string()),
            )
            .child(
                div()
                    .mt_1()
                    .max_w(px(320.0))
                    .text_center()
                    .text_xs()
                    .line_height(px(20.0))
                    .text_color(t.muted_foreground)
                    .child(body.to_string()),
            )
    }

    fn section_label(text: String, cx: &App) -> Div {
        div()
            .px_3()
            .pt_4()
            .pb_2()
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme::tokens(cx).muted_foreground)
            .child(text)
    }

    fn row(id: SharedString, cx: &App) -> Stateful<Div> {
        let t = theme::tokens(cx);
        div()
            .id(id)
            .group("friend-row")
            .relative()
            .flex()
            .items_center()
            .gap_3()
            .border_t_1()
            .border_color(t.border)
            .px_3()
            .py(px(10.0))
            .hover(|s| s.bg(t.card).border_color(transparent_black()))
    }

    fn render_friends(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let friends = Friends::global(cx).read(cx);
        let (loading, accepted, busy_ids) = (
            friends.loading,
            friends.accepted.clone(),
            friends.busy_user_ids.clone(),
        );
        let online_count = accepted
            .iter()
            .filter(|entry| entry.status == UserStatus::Online)
            .count();
        if loading && accepted.is_empty() {
            return vec![
                ui::muted("Loading friends…", cx)
                    .px_3()
                    .py_8()
                    .into_any_element(),
            ];
        }
        if accepted.is_empty() {
            return vec![
                Self::empty(
                    "No friends yet",
                    "Add someone with their handle and they’ll show up here once they accept.",
                    cx,
                )
                .into_any_element(),
                div()
                    .flex()
                    .justify_center()
                    .mt(px(-40.0))
                    .mb_16()
                    .child(
                        Button::new("add-first")
                            .primary()
                            .label("Add friend")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.set_tab(Tab::Add, window, cx)
                            })),
                    )
                    .into_any_element(),
            ];
        }
        if self.tab == Tab::Online && online_count == 0 {
            return vec![
                Self::empty(
                    "No one’s around right now",
                    "Friends who come online will show up here.",
                    cx,
                )
                .into_any_element(),
            ];
        }

        let t = theme::tokens(cx);
        let query = self.query.read(cx).value().to_string();
        let list = friend_list(&accepted, self.tab == Tab::Online, &query);
        let label = format!(
            "{} — {}",
            if self.tab == Tab::Online {
                "Online"
            } else {
                "All friends"
            },
            list.len()
        );

        let search = div()
            .flex()
            .items_center()
            .h_9()
            .pl_3()
            .pr_3()
            .bg(t.sidebar)
            .rounded(t.radius)
            .text_sm()
            .child(
                div()
                    .flex_1()
                    .child(Input::new(&self.query).appearance(false)),
            )
            .child(icon("search").size_4().text_color(t.muted_foreground));

        let rows: Vec<AnyElement> = if list.is_empty() {
            vec![
                ui::muted(format!("No friends match “{}”.", query.trim()), cx)
                    .px_3()
                    .py_8()
                    .into_any_element(),
            ]
        } else {
            list.iter()
                .map(|entry| {
                    let user_id = entry.user.user_id.clone();
                    let name = entry.user.name().to_string();
                    let busy = busy_ids.contains(&user_id);
                    let open = {
                        let user_id = user_id.clone();
                        move |cx: &mut App| {
                            let user_id = user_id.clone();
                            Dms::global(cx)
                                .update(cx, |dms, cx| dms.open(user_id, cx))
                                .detach();
                        }
                    };
                    let open_row = open.clone();
                    let remove_id = user_id.clone();
                    let [avatar, text] = Self::person(
                        entry,
                        if entry.status == UserStatus::Online {
                            "Online"
                        } else {
                            "Offline"
                        },
                        32.0,
                        "friend-row",
                        cx,
                    );
                    Self::row(SharedString::from(format!("friend-{user_id}")), cx)
                        .child(
                            // the whole row opens the DM; the action buttons sit above it
                            div()
                                .id(SharedString::from(format!("open-{user_id}")))
                                .absolute()
                                .inset_0()
                                .cursor_pointer()
                                .on_click(move |_, _, cx| open_row(cx)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_1()
                                .min_w_0()
                                .items_center()
                                .gap_3()
                                .child(avatar)
                                .child(text),
                        )
                        .child(
                            div()
                                .relative()
                                .flex()
                                .flex_shrink_0()
                                .items_center()
                                .gap_2()
                                .child(Self::action(
                                    format!("Message {name}").into(),
                                    "message-square",
                                    None,
                                    false,
                                    "friend-row",
                                    open,
                                    cx,
                                ))
                                .child(
                                    Button::new(SharedString::from(format!("more-{user_id}")))
                                        .ghost()
                                        .icon(icon("ellipsis-vertical"))
                                        .w(px(36.0))
                                        .h(px(36.0))
                                        .bg(t.card)
                                        .text_color(t.muted_foreground)
                                        .tooltip("More")
                                        .dropdown_menu_with_anchor(
                                            Anchor::TopRight,
                                            move |menu, _, cx| {
                                                let t = theme::tokens(cx);
                                                let remove_id = remove_id.clone();
                                                menu.min_w(px(192.0)).item(
                                                    PopupMenuItem::element(move |_, _| {
                                                        div()
                                                            .text_color(t.destructive)
                                                            .child("Remove friend")
                                                    })
                                                    .disabled(busy)
                                                    .on_click(move |_, _, cx| {
                                                        let user_id = remove_id.clone();
                                                        Friends::global(cx)
                                                            .update(cx, |friends, cx| {
                                                                friends.remove(user_id, cx)
                                                            })
                                                            .detach();
                                                    }),
                                                )
                                            },
                                        ),
                                ),
                        )
                        .into_any_element()
                })
                .collect()
        };

        vec![
            search.into_any_element(),
            Self::section_label(label, cx).into_any_element(),
            div().flex().flex_col().children(rows).into_any_element(),
        ]
    }

    fn render_pending(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let friends = Friends::global(cx).read(cx);
        let pending: Vec<(FriendEntry, bool)> = friends
            .incoming
            .iter()
            .map(|entry| (entry.clone(), true))
            .chain(friends.outgoing.iter().map(|entry| (entry.clone(), false)))
            .collect();
        let busy_ids = friends.busy_user_ids.clone();
        if pending.is_empty() {
            return vec![
                Self::empty(
                    "No pending requests",
                    "Requests you send or receive will wait here until they’re answered.",
                    cx,
                )
                .into_any_element(),
            ];
        }
        let t = theme::tokens(cx);
        let label = format!("Pending — {}", pending.len());
        let rows: Vec<_> = pending
            .into_iter()
            .map(|(entry, incoming)| {
                let user_id = entry.user.user_id.clone();
                let name = entry.user.name().to_string();
                let busy = busy_ids.contains(&user_id);
                let [avatar, text] = Self::person(
                    &entry,
                    if incoming {
                        "Incoming friend request"
                    } else {
                        "Outgoing friend request"
                    },
                    32.0,
                    "friend-row",
                    cx,
                );
                let act = |run: fn(&mut Friends, String, &mut Context<Friends>) -> Task<bool>| {
                    let user_id = user_id.clone();
                    move |cx: &mut App| {
                        let user_id = user_id.clone();
                        Friends::global(cx)
                            .update(cx, |friends, cx| run(friends, user_id, cx))
                            .detach();
                    }
                };
                let actions = if incoming {
                    vec![
                        Self::action(
                            format!("Accept {name}").into(),
                            "check",
                            Some(emerald()),
                            busy,
                            "friend-row",
                            act(Friends::accept),
                            cx,
                        ),
                        Self::action(
                            format!("Ignore {name}").into(),
                            "x",
                            Some(t.destructive),
                            busy,
                            "friend-row",
                            act(Friends::decline),
                            cx,
                        ),
                    ]
                } else {
                    vec![Self::action(
                        format!("Cancel request to {name}").into(),
                        "x",
                        Some(t.destructive),
                        busy,
                        "friend-row",
                        act(Friends::remove),
                        cx,
                    )]
                };
                Self::row(SharedString::from(format!("pending-{user_id}")), cx)
                    .child(avatar)
                    .child(text)
                    .child(
                        div()
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .gap_2()
                            .children(actions),
                    )
            })
            .collect();
        vec![
            Self::section_label(label, cx).into_any_element(),
            div().flex().flex_col().children(rows).into_any_element(),
        ]
    }

    fn render_add(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let t = theme::tokens(cx);
        let wide = ShellState::global(cx).read(cx).width >= SM;
        let focused = self.handle.read(cx).focus_handle(cx).is_focused(window);
        let empty_handle = self.handle.read(cx).value().trim().is_empty();
        let border = match &self.add_result {
            Some((true, _)) => emerald(),
            Some((false, _)) => t.destructive,
            None if focused => t.ring,
            None => t.border,
        };
        let form = div()
            .mt_4()
            .flex()
            .items_center()
            .gap_2()
            .border_1()
            .border_color(border)
            .rounded(t.radius)
            .bg(t.sidebar)
            .p(px(6.0))
            .pl_3()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_8()
                    .flex()
                    .items_center()
                    .text_sm()
                    .child(Input::new(&self.handle).appearance(false)),
            )
            .child(
                Button::new("send-request")
                    .primary()
                    .small()
                    .disabled(empty_handle)
                    .label(if wide { "Send friend request" } else { "Send" })
                    .on_click(cx.listener(|this, _, window, cx| this.send_request(window, cx))),
            );
        vec![
            div()
                .border_b_1()
                .border_color(t.border)
                .pb_6()
                .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child("Add friend"))
                .child(ui::muted("You can add friends with their Novarum handle. It’s on their profile.", cx).mt_1())
                .child(form)
                .children(self.add_result.clone().map(|(ok, message)| {
                    div().mt_2().text_xs().text_color(if ok { emerald() } else { t.destructive }).child(message)
                }))
                .into_any_element(),
            Self::empty(
                "Your friends will show up here",
                "Once someone accepts your request, you can message them from the Online and All tabs.",
                cx,
            )
            .into_any_element(),
        ]
    }

    fn render_active_now(&mut self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let online: Vec<FriendEntry> = Friends::global(cx)
            .read(cx)
            .accepted
            .iter()
            .filter(|entry| entry.status == UserStatus::Online)
            .cloned()
            .collect();
        let body = if online.is_empty() {
            div()
                .mt_4()
                .text_center()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child("It’s quiet for now…"),
                )
                .child(
                    div()
                        .mt_1()
                        .text_xs()
                        .line_height(px(20.0))
                        .text_color(t.muted_foreground)
                        .child("When friends come online, they’ll show up here."),
                )
        } else {
            div()
                .mt_4()
                .flex()
                .flex_col()
                .gap_2()
                .children(online.iter().map(|entry| {
                    let user_id = entry.user.user_id.clone();
                    let [avatar, text] = Self::person(entry, "Online", 40.0, "active-now", cx);
                    div()
                        .id(SharedString::from(format!("active-{user_id}")))
                        .group("active-now")
                        .flex()
                        .w_full()
                        .items_center()
                        .gap_3()
                        .border_1()
                        .border_color(t.border)
                        .bg(t.sidebar)
                        .p_3()
                        .cursor_pointer()
                        .hover(|s| s.bg(t.card))
                        .on_click(move |_, _, cx| {
                            let user_id = user_id.clone();
                            Dms::global(cx)
                                .update(cx, |dms, cx| dms.open(user_id, cx))
                                .detach();
                        })
                        .child(avatar)
                        .child(text)
                }))
        };
        div()
            .w_80()
            .flex_shrink_0()
            .border_l_1()
            .border_color(t.border)
            .p_4()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Active now"),
            )
            .child(body)
    }
}

impl Render for FriendsHome {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let width = ShellState::global(cx).read(cx).width;
        let circle = SettingsStore::get(cx).circle_icons;
        let incoming = Friends::global(cx).read(cx).incoming.len();
        let error = Friends::global(cx).read(cx).error.clone();

        let tab_trigger = |tab: Tab, label: &'static str, cx: &mut Context<Self>| {
            let active = self.tab == tab;
            div()
                .id(label)
                .flex()
                .flex_none()
                .items_center()
                .gap(px(6.0))
                .h_7()
                .px(px(10.0))
                .rounded(t.radius)
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .when(active, |tab| tab.bg(t.muted).text_color(t.foreground))
                .when(!active, |tab| {
                    tab.text_color(t.muted_foreground)
                        .hover(|s| s.bg(t.muted).text_color(t.foreground))
                })
                .child(label)
                .when(tab == Tab::Pending && incoming > 0, |tab| {
                    tab.child(
                        div()
                            .min_w_4()
                            .px_1()
                            .bg(t.destructive)
                            .text_size(px(11.0))
                            .line_height(px(16.0))
                            .font_weight(FontWeight::BOLD)
                            .text_color(white())
                            .text_center()
                            .when(circle, |badge| badge.rounded_full())
                            .child(if incoming > 99 {
                                "99+".to_string()
                            } else {
                                incoming.to_string()
                            }),
                    )
                })
                .on_click(cx.listener(move |this, _, window, cx| this.set_tab(tab, window, cx)))
        };
        let add_active = self.tab == Tab::Add;
        let add_tab = div()
            .id("add-friend")
            .flex()
            .flex_none()
            .items_center()
            .h_7()
            .px(px(10.0))
            .rounded(t.radius)
            .text_sm()
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .when(add_active, |tab| tab.text_color(t.sidebar_primary))
            .when(!add_active, |tab| {
                tab.bg(t.primary)
                    .text_color(t.primary_foreground)
                    .hover(|s| s.bg(t.primary.opacity(0.85)))
            })
            .child("Add friend")
            .on_click(cx.listener(|this, _, window, cx| this.set_tab(Tab::Add, window, cx)));

        let header = div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap_4()
            .h_12()
            .px_4()
            .border_b_1()
            .border_color(t.border)
            .when(width < MD, |header| {
                header.child(
                    Button::new("open-navigation")
                        .ghost()
                        .small()
                        .icon(icon("menu").size_5())
                        .tooltip("Open channels")
                        .on_click(|_, _, cx| ShellState::open_navigation(cx)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap_2()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(icon("users").size_5().text_color(t.muted_foreground))
                    .when(width >= SM, |title| title.child("Friends")),
            )
            .child(div().h_6().w_px().flex_shrink_0().bg(t.border))
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .gap_2()
                    .child(tab_trigger(Tab::Online, "Online", cx))
                    .child(tab_trigger(Tab::All, "All", cx))
                    .child(tab_trigger(Tab::Pending, "Pending", cx))
                    .child(add_tab),
            );

        let content = match self.tab {
            Tab::Online | Tab::All => self.render_friends(cx),
            Tab::Pending => self.render_pending(cx),
            Tab::Add => self.render_add(window, cx),
        };
        let show_error = self.tab != Tab::Add;

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .bg(t.background)
            .child(header)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("friends-content")
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .overflow_y_scroll()
                            .px(if width >= SM { px(24.0) } else { px(12.0) })
                            .pt_4()
                            .pb_6()
                            .children(content)
                            .children(error.filter(|_| show_error).map(|error| {
                                div()
                                    .my_4()
                                    .border_l_2()
                                    .border_color(t.destructive)
                                    .pl_3()
                                    .text_xs()
                                    .line_height(px(20.0))
                                    .text_color(t.destructive)
                                    .child(error)
                            })),
                    )
                    .when(width >= XL, |body| body.child(self.render_active_now(cx))),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{friend_list, parse_handle};
    use crate::models::{PublicUser, UserStatus};
    use crate::state::friends::FriendEntry;

    fn friend(id: &str, name: &str, status: UserStatus) -> FriendEntry {
        FriendEntry {
            user: PublicUser {
                user_id: id.into(),
                username: name.to_lowercase(),
                homeserver: "novarum.me".into(),
                display_name: Some(name.into()),
                avatar_url: None,
                avatar_color: None,
                speaking_ring_color: None,
                banner_url: None,
                about: None,
                is_bot: false,
            },
            status,
            created_at: String::new(),
            accepted_at: None,
        }
    }

    #[test]
    fn lists_online_friends_first_and_filters() {
        let list = [
            friend("a", "Ana", UserStatus::Offline),
            friend("b", "Bea", UserStatus::Online),
            friend("c", "Cai", UserStatus::Offline),
        ];
        let ids = |found: Vec<FriendEntry>| {
            found
                .into_iter()
                .map(|f| f.user.user_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(friend_list(&list, false, "")), ["b", "a", "c"]);
        assert_eq!(ids(friend_list(&list, true, "")), ["b"]);
        assert_eq!(ids(friend_list(&list, false, " CAI ")), ["c"]);
        assert_eq!(ids(friend_list(&list, false, "@ana:novarum")), ["a"]);
    }

    #[test]
    fn parses_handles() {
        assert_eq!(
            parse_handle(" @ana:novarum.me "),
            Ok(("ana".into(), "novarum.me".into()))
        );
        assert_eq!(
            parse_handle("ana:localhost:5049"),
            Ok(("ana".into(), "localhost:5049".into()))
        );
        assert!(parse_handle("ana").is_err());
        assert!(parse_handle("@ana@x:y").is_err());
    }
}
