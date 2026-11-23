// Port of apps/frontend/src/lib/components/profile-card.svelte
use std::rc::Rc;

use gpui_kit::component::{
    input::{Input, InputEvent, InputState},
    popover::Popover,
};

use crate::{
    models::{Author, UserStatus},
    prelude::*,
    state::{
        chat::Chat,
        dms::Dms,
        friends::{FriendStatus, Friends},
        session::Session,
        settings::SettingsStore,
    },
};

/// `onCall(channelId)`: start a call from the card's "Call" button.
pub type OnCall = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// Tailwind colors the web uses for presence and badges.
pub fn emerald() -> Hsla {
    theme::oklch(0.696, 0.17, 162.48, 1.0)
}
pub fn green() -> Hsla {
    theme::oklch(0.723, 0.219, 149.579, 1.0)
}
pub fn amber() -> Hsla {
    theme::oklch(0.769, 0.188, 70.08, 1.0)
}
pub fn neutral_500() -> Hsla {
    theme::oklch(0.556, 0.0, 0.0, 1.0)
}
fn neutral_900() -> Hsla {
    theme::oklch(0.205, 0.0, 0.0, 1.0)
}

/// bot-badge.svelte
pub fn bot_badge(cx: &App) -> Div {
    let t = theme::tokens(cx);
    div()
        .flex()
        .flex_shrink_0()
        .items_center()
        .h_4()
        .px_1()
        .bg(t.primary)
        .text_color(t.primary_foreground)
        .text_size(px(10.0))
        .line_height(px(10.0))
        .font_weight(FontWeight::SEMIBOLD)
        .child("Bot")
}

/// The popover needs a `Selectable` trigger; this wraps any element as one.
#[derive(IntoElement)]
struct Trigger {
    element: Div,
    open: bool,
}

impl Selectable for Trigger {
    fn selected(mut self, selected: bool) -> Self {
        self.open = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.open
    }
}

impl RenderOnce for Trigger {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        self.element
    }
}

// the message list and voice views open it from authors and participants
#[allow(dead_code)]
pub fn profile_card(
    id: impl Into<ElementId>,
    user: Author,
    on_call: Option<OnCall>,
    trigger: impl IntoElement,
) -> AnyElement {
    profile_popover(id.into(), user, on_call, div().child(trigger), false)
}

/// The card around a trigger that fills its row, like the member lists' `class="flex w-full"`.
pub fn profile_card_row(
    id: impl Into<ElementId>,
    user: Author,
    on_call: Option<OnCall>,
    trigger: Div,
) -> AnyElement {
    profile_popover(id.into(), user, on_call, trigger, true)
}

fn profile_popover(
    id: ElementId,
    user: Author,
    on_call: Option<OnCall>,
    trigger: Div,
    full: bool,
) -> AnyElement {
    let draft_id = SharedString::from(format!("{id:?}-draft"));
    Popover::new(id)
        .anchor(Anchor::LeftCenter)
        .offset(px(8.0))
        .w(px(288.0))
        .p_0()
        .overflow_hidden()
        .when(full, |popover| {
            popover.trigger_style(StyleRefinement::default().w_full())
        })
        .trigger(Trigger {
            element: trigger.cursor_pointer(),
            open: false,
        })
        .content(move |state, window, cx| {
            card(&user, on_call.clone(), draft_id.clone(), state, window, cx)
        })
        .into_any_element()
}

/// The friend button's label and what it does, by the friendship's state.
pub fn friend_action_label(status: FriendStatus) -> &'static str {
    match status {
        FriendStatus::Incoming => "Accept friend request",
        FriendStatus::Outgoing => "Cancel friend request",
        FriendStatus::Friend => "Remove friend",
        FriendStatus::None => "Add friend",
    }
}

fn run_friend_action(
    user: &Author,
    status: FriendStatus,
    friendship: Option<String>,
    cx: &mut App,
) {
    Friends::global(cx).update(cx, |friends, cx| match (status, friendship) {
        (FriendStatus::Incoming, Some(id)) => friends.accept(id, cx).detach(),
        (FriendStatus::Outgoing | FriendStatus::Friend, Some(id)) => {
            friends.remove(id, cx).detach()
        }
        (FriendStatus::None, _) => friends
            .request(user.user_id.clone(), &user.username, &user.server, cx)
            .detach(),
        _ => {}
    });
}

/// `sendDm`: opens (or creates) the DM and sends the draft there.
fn send_dm(
    input: &Entity<InputState>,
    friendship: Option<String>,
    window: &mut Window,
    cx: &mut App,
) {
    let content = input.read(cx).value().trim().to_string();
    let Some(friendship) = friendship.filter(|_| !content.is_empty()) else {
        return;
    };
    input.update(cx, |input, cx| input.set_value("", window, cx));
    let open = Dms::global(cx).update(cx, |dms, cx| dms.open(friendship, cx));
    cx.spawn(async move |cx| {
        let Some(channel_id) = open.await else { return };
        let send = cx.update(|cx| {
            Chat::global(cx).update(cx, |chat, cx| {
                chat.send_message(channel_id, Some(content), vec![], None, cx)
            })
        });
        let _ = send.await;
    })
    .detach();
}

fn card(
    user: &Author,
    on_call: Option<OnCall>,
    draft_id: SharedString,
    _state: &mut gpui_kit::component::popover::PopoverState,
    window: &mut Window,
    cx: &mut Context<gpui_kit::component::popover::PopoverState>,
) -> Div {
    let _ = on_call; // Message and Call buttons only show on mobile; the computer gets the draft input
    let t = theme::tokens(cx);
    let circle = SettingsStore::get(cx).circle_icons;
    let me = Session::user(cx);
    let friends = Friends::global(cx).read(cx);
    let status = friends.status_for(&user.username, &user.server);
    let friendship = friends.user_id_for(&user.username, &user.server);
    let busy = friends.busy_user_ids.contains(&user.user_id)
        || friendship
            .as_ref()
            .is_some_and(|id| friends.busy_user_ids.contains(id));
    let is_self = me
        .as_ref()
        .is_some_and(|me| user.username == me.username && user.server == me.homeserver);
    let can_add_friend = !user.user_id.is_empty()
        && me.as_ref().is_none_or(|me| me.id != user.user_id)
        && !user.is_bot;
    let name = user.name().to_string();
    let show_draft = !user.username.is_empty() && !is_self && status == FriendStatus::Friend;

    let banner = div()
        .relative()
        .w_full()
        .h(px(96.0))
        .overflow_hidden()
        .bg(user
            .avatar_color
            .as_deref()
            .and_then(ui::hex)
            .unwrap_or(t.muted))
        .children(
            user.banner_url
                .as_deref()
                .and_then(|url| ui::image::remote(url, cx).ok().flatten())
                .map(|image| img(image).size_full().object_fit(ObjectFit::Contain)),
        );

    let friend_button = can_add_friend.then(|| {
        let user = user.clone();
        let friendship = friendship.clone();
        let glyph = |name: &str| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(icon(name).size_4())
        };
        let icons = match status {
            FriendStatus::Incoming => div().size_full().child(glyph("user-round-arrow-left")),
            FriendStatus::Outgoing => div().size_full().child(glyph("user-round-cog")),
            FriendStatus::Friend => div()
                .size_full()
                .child(glyph("user-round-check").group_hover("friend-action", |s| s.opacity(0.0)))
                .child(
                    glyph("user-round-minus")
                        .opacity(0.0)
                        .text_color(t.destructive)
                        .group_hover("friend-action", |s| s.opacity(1.0)),
                ),
            FriendStatus::None => div().size_full().child(glyph("user-round-plus")),
        };
        div()
            .group("friend-action")
            .absolute()
            .right_3()
            .top_1()
            .child(
                Button::new("friend-action")
                    .w(px(36.0))
                    .h(px(36.0))
                    .tooltip(friend_action_label(status))
                    .disabled(busy)
                    .child(div().relative().size_4().child(icons))
                    .on_click(move |_, _, cx| {
                        run_friend_action(&user, status, friendship.clone(), cx)
                    }),
            )
    });

    let status_dot = user.status.map(|status| {
        let size = if circle { 20.0 } else { 14.0 };
        let border = if circle { 4.0 } else { 3.0 };
        let dot = div()
            .absolute()
            .bottom_0()
            .right_0()
            .size(px(size))
            .border(px(border))
            .border_color(t.popover)
            .when(circle, |dot| dot.rounded_full());
        if status == UserStatus::Online {
            dot.bg(emerald())
        } else {
            dot.bg(neutral_900()).child(
                div()
                    .size_full()
                    .border(px(3.0))
                    .border_color(neutral_500())
                    .when(circle, |d| d.rounded_full()),
            )
        }
    });

    let avatar = div()
        .relative()
        .mt(px(-32.0))
        .w(px(64.0))
        .child(
            div()
                .size(px(64.0))
                .border_4()
                .border_color(t.popover)
                .when(circle, |d| d.rounded_full())
                .overflow_hidden()
                .child(ui::avatar::avatar(
                    user.avatar_url.as_deref(),
                    &name,
                    user.avatar_color.as_deref(),
                    56.0,
                    cx,
                )),
        )
        .children(status_dot);

    let draft = show_draft.then(|| {
        let placeholder = format!("Message @{}:{}", user.username, user.server);
        let friendship = friendship.clone();
        let input = window.use_keyed_state(ElementId::Name(draft_id.clone()), cx, |window, cx| {
            InputState::new(window, cx).placeholder(placeholder)
        });
        let entity = input.clone();
        window.use_keyed_state(
            ElementId::Name(format!("{draft_id}-enter").into()),
            cx,
            move |window, cx| {
                window.subscribe(
                    &entity,
                    cx,
                    move |entity, event: &InputEvent, window, cx| {
                        if let InputEvent::PressEnter { .. } = event {
                            send_dm(&entity, friendship.clone(), window, cx);
                        }
                    },
                )
            },
        );
        div().mt(px(10.0)).child(Input::new(&input).text_xs())
    });

    let about = user
        .about
        .as_deref()
        .map(str::trim)
        .filter(|about| !about.is_empty())
        .map(|about| {
            div()
                .mt_3()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .text_size(px(10.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(t.muted_foreground)
                                .child("BIO"),
                        )
                        .child(div().flex_1().h_px().bg(t.border)),
                )
                .child(
                    div()
                        .text_xs()
                        .line_height(relative(1.625))
                        .line_clamp(6)
                        .text_color(t.foreground.opacity(0.8))
                        .child(about.to_string()),
                )
        });

    div()
        .flex()
        .flex_col()
        .w_full()
        .bg(t.popover)
        .child(banner)
        .child(
            div()
                .relative()
                .px_4()
                .pb_4()
                .children(friend_button)
                .child(avatar)
                .child(
                    div()
                        .mt_2()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .truncate()
                                .text_base()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(name),
                        )
                        .when(user.is_bot, |row| row.child(bot_badge(cx))),
                )
                .child(
                    div()
                        .truncate()
                        .text_size(px(11.0))
                        .text_color(t.muted_foreground)
                        .child(format!("@{}:{}", user.username, user.server)),
                )
                .when(is_self, |body| {
                    body.child(
                        Button::new("edit-profile")
                            .secondary()
                            .mt_3()
                            .w_full()
                            .icon(icon("user-round-cog"))
                            .label("Edit profile")
                            .on_click(cx.listener(|state, _, window, cx| {
                                state.dismiss(window, cx);
                                SettingsStore::set_dialog_open(true, cx);
                            })),
                    )
                })
                .children(about)
                .children(draft),
        )
}

#[cfg(test)]
mod tests {
    use super::friend_action_label;
    use crate::state::friends::FriendStatus;

    #[test]
    fn labels_the_friend_action() {
        assert_eq!(friend_action_label(FriendStatus::None), "Add friend");
        assert_eq!(friend_action_label(FriendStatus::Friend), "Remove friend");
        assert_eq!(
            friend_action_label(FriendStatus::Incoming),
            "Accept friend request"
        );
        assert_eq!(
            friend_action_label(FriendStatus::Outgoing),
            "Cancel friend request"
        );
    }
}
