// Port of apps/frontend/src/lib/components/group-members.svelte
use std::rc::Rc;

use gpui_kit::component::menu::{ContextMenuExt, PopupMenuItem};

use crate::{
    models::Author,
    prelude::*,
    state::{
        dms::{DmEntry, Dms},
        friends::Friends,
        router::{self, ChatRoute, Router},
        session::Session,
    },
    views::{
        group_settings_dialog::open_group_settings,
        new_dm_dialog::open_new_dm_dialog,
        profile_card::{OnCall, amber, bot_badge, emerald, profile_card_row},
        shell::ShellState,
    },
};

/// `dms.kick` or `dms.transferOwner`, run on a member from the context menu.
type GroupAction = fn(&Dms, &str, &str, &App) -> Task<Result<(), String>>;

pub struct GroupMembers {
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl GroupMembers {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _subscriptions = vec![
            cx.observe(&Dms::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Friends::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Router::global(cx), |this: &mut Self, _, cx| {
                this.error = None;
                cx.notify();
            }),
        ];
        Self { error: None, _subscriptions }
    }

    fn group(cx: &App) -> Option<DmEntry> {
        let ChatRoute::Dms { channel_id: Some(id), .. } = Router::route(cx) else { return None };
        Dms::global(cx).read(cx).get(&id).cloned()
    }

    /// `act`: shows the request's error, if any.
    fn act(&mut self, task: Task<Result<(), String>>, leaving: bool, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.error = result.err();
                if this.error.is_none() && leaving {
                    router::goto("/guilds/dms", cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for GroupMembers {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let Some(group) = Self::group(cx) else { return div().size_full().bg(t.sidebar) };
        let me = Session::user(cx);
        let is_owner = me.as_ref().is_some_and(|me| group.owner_id.as_deref() == Some(me.id.as_str()));
        let members: Vec<Author> = me
            .iter()
            .map(|me| Author::from(&me.as_public()))
            .chain(group.participants.iter().map(Author::from))
            .collect();
        let view = cx.entity().downgrade();
        let on_call: OnCall = Rc::new(|id, _, cx| ShellState::start_call(id, cx));

        let header = div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap_1()
            .h_12()
            .px_2()
            .border_b_1()
            .border_color(t.border)
            .child(Button::new("add-people").ghost().icon(icon("user-plus")).tooltip("Add people").on_click({
                let group = group.clone();
                move |_, window, cx| open_new_dm_dialog(Some(group.clone()), window, cx)
            }))
            .when(is_owner, |header| {
                let id = group.id.clone();
                header.child(
                    Button::new("group-settings")
                        .ghost()
                        .icon(icon("settings"))
                        .tooltip("Group settings")
                        .on_click(move |_, window, cx| open_group_settings(id.clone(), window, cx)),
                )
            })
            .child(div().flex_1())
            .child(Button::new("leave-group").ghost().icon(icon("log-out")).tooltip("Leave group").on_click(
                cx.listener({
                    let id = group.id.clone();
                    move |this, _, _, cx| {
                        let leave = Dms::global(cx).update(cx, |dms, cx| dms.leave(id.clone(), cx));
                        this.act(leave, true, cx);
                    }
                }),
            ));

        let online: Vec<bool> = members
            .iter()
            .map(|member| {
                me.as_ref().is_some_and(|me| me.id == member.user_id)
                    || Friends::global(cx).read(cx).is_online(&member.user_id)
            })
            .collect();
        let rows: Vec<_> = members.iter().zip(online).map(|(member, online)| {
            let name = member.name().to_string();
            let is_self = me.as_ref().is_some_and(|me| me.id == member.user_id);
            let avatar = div()
                .relative()
                .child(ui::avatar::avatar(member.avatar_url.as_deref(), &name, member.avatar_color.as_deref(), 28.0, cx))
                .when(online, |avatar| {
                    avatar.child(
                        div()
                            .absolute()
                            .right(px(-1.0))
                            .bottom(px(-1.0))
                            .size(px(10.0))
                            .border_2()
                            .border_color(t.sidebar)
                            .bg(emerald()),
                    )
                });
            let trigger = div()
                .flex()
                .w_full()
                .items_center()
                .gap_2()
                .px_1()
                .py_1()
                .when(!online, |row| row.opacity(0.5))
                .child(avatar)
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .items_center()
                        .child(div().truncate().text_sm().text_color(t.foreground).child(name))
                        .when(member.is_bot, |row| row.child(bot_badge(cx).ml(px(6.0))))
                        .when(group.owner_id.as_deref() == Some(member.user_id.as_str()), |row| {
                            row.child(icon("crown").ml(px(6.0)).size(px(14.0)).flex_shrink_0().text_color(amber()))
                        }),
                );

            let user_id = member.user_id.clone();
            let is_bot = member.is_bot;
            let group_id = group.id.clone();
            let view = view.clone();
            div()
                .id(SharedString::from(format!("member-{user_id}")))
                .child(profile_card_row(
                    SharedString::from(format!("member-card-{user_id}")),
                    member.clone(),
                    Some(on_call.clone()),
                    trigger,
                ))
                .context_menu(move |menu, _, cx| {
                    let copy_id = user_id.clone();
                    let mut menu = menu.item(
                        PopupMenuItem::new("Copy User ID")
                            .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy_id.clone()))),
                    );
                    if is_owner && !is_self {
                        menu = menu.separator();
                        let act = |run: GroupAction| {
                            let (view, group_id, user_id) = (view.clone(), group_id.clone(), user_id.clone());
                            move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                                let task = run(Dms::global(cx).read(cx), &group_id, &user_id, cx);
                                let _ = view.update(cx, |this, cx| this.act(task, false, cx));
                            }
                        };
                        if !is_bot {
                            menu = menu.item(PopupMenuItem::new("Make Group Owner").on_click(act(Dms::transfer_owner)));
                        }
                        let color = theme::tokens(cx).destructive;
                        menu = menu.item(
                            PopupMenuItem::element(move |_, _| div().text_color(color).child("Remove from Group"))
                                .on_click(act(Dms::kick)),
                        );
                    }
                    menu
                })
        }).collect();

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(t.sidebar)
            .child(header)
            .child(
                div()
                    .id("group-members")
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
                            .child(format!("Members - {}", members.len())),
                    )
                    .children(self.error.clone().map(|error| div().text_xs().text_color(t.destructive).child(error)))
                    .child(div().flex().flex_col().gap(px(2.0)).children(rows)),
            )
    }
}
