// Port of apps/frontend/src/lib/components/new-dm-dialog.svelte
use gpui_kit::component::{
    WindowExt,
    input::{Input, InputState},
};

use crate::{
    api,
    models::DmType,
    prelude::*,
    state::{
        dms::{DmEntry, Dms},
        friends::{FriendEntry, Friends},
    },
    views::friends_home::matches_query,
};

/// The dialog's button: what submitting does with `selected` friends.
pub fn submit_label(add_to: Option<DmType>, selected: usize) -> String {
    let action = match add_to {
        Some(DmType::GroupDm) => "Add to Group",
        Some(DmType::Dm) => "Create Group",
        None if selected > 1 => "Create Group",
        None => "Open DM",
    };
    if selected > 1 {
        format!("{action} ({selected})")
    } else {
        action.into()
    }
}

/// Friends that aren't in the group yet and match the search.
pub fn visible_friends<'a>(
    accepted: &'a [FriendEntry],
    in_group: &[String],
    query: &str,
) -> Vec<&'a FriendEntry> {
    accepted
        .iter()
        .filter(|entry| !in_group.contains(&entry.user.user_id) && matches_query(entry, query))
        .collect()
}

/// Without `add_to`, one friend opens a 1:1 and more start a group. With a group, the picked
/// friends join it; with a 1:1, a new group starts with the other person and the picked friends.
pub fn open_new_dm_dialog(add_to: Option<DmEntry>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| NewDmDialog::new(add_to.clone(), window, cx));
    let title = if add_to.is_some() {
        "Add People"
    } else {
        "New Message"
    };
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title(title).w(px(448.0)).child(view.clone())
    });
}

pub struct NewDmDialog {
    add_to: Option<DmEntry>,
    query: Entity<InputState>,
    selected: Vec<String>,
    busy: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl NewDmDialog {
    fn new(add_to: Option<DmEntry>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search friends"));
        let _subscriptions = vec![
            cx.observe(&Friends::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&query, |_, _, cx| cx.notify()),
        ];
        Self {
            add_to,
            query,
            selected: vec![],
            busy: false,
            error: None,
            _subscriptions,
        }
    }

    fn room(&self) -> usize {
        let taken = self
            .add_to
            .as_ref()
            .map_or(1, |dm| dm.participants.len() + 1);
        (api::anchor().max_group_members as usize).saturating_sub(taken)
    }

    fn toggle(&mut self, user_id: &str, cx: &mut Context<Self>) {
        self.error = None;
        if self.selected.iter().any(|id| id == user_id) {
            self.selected.retain(|id| id != user_id);
        } else if self.selected.len() < self.room() {
            self.selected.push(user_id.into());
        }
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() || self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        cx.notify();
        let ids = self.selected.clone();
        let dms = Dms::global(cx);
        let task: Task<Result<(), String>> = match &self.add_to {
            Some(group) if group.kind == DmType::GroupDm => {
                dms.read(cx).add_members(&group.id, ids, cx)
            }
            Some(dm) => {
                let others = dm
                    .participants
                    .first()
                    .map(|user| user.user_id.clone())
                    .into_iter()
                    .chain(ids)
                    .collect();
                let create = dms.update(cx, |dms, cx| dms.create_group(others, String::new(), cx));
                cx.spawn(async move |_, _| create.await.map(|_| ()))
            }
            None if ids.len() == 1 => {
                let open = dms.update(cx, |dms, cx| dms.open(ids[0].clone(), cx));
                cx.spawn(async move |_, _| {
                    open.await;
                    Ok(())
                })
            }
            None => {
                let create = dms.update(cx, |dms, cx| dms.create_group(ids, String::new(), cx));
                cx.spawn(async move |_, _| create.await.map(|_| ()))
            }
        };
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match result {
                    Err(error) => this.error = Some(error),
                    Ok(()) => window.close_dialog(cx),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for NewDmDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let friends = Friends::global(cx).read(cx);
        let room = self.room();
        let in_group: Vec<String> = self
            .add_to
            .iter()
            .flat_map(|dm| dm.participants.iter().map(|user| user.user_id.clone()))
            .collect();
        let query = self.query.read(cx).value().to_string();
        let visible: Vec<FriendEntry> = visible_friends(&friends.accepted, &in_group, &query)
            .into_iter()
            .cloned()
            .collect();
        let no_friends = friends.accepted.is_empty();
        let description = if self.add_to.is_some() {
            format!("Pick friends to add. {room} more can join.")
        } else {
            format!(
                "Pick a friend, or several to start a group of up to {}.",
                api::anchor().max_group_members
            )
        };

        let empty = |text: &'static str| {
            div()
                .py_6()
                .text_center()
                .text_sm()
                .text_color(t.muted_foreground)
                .child(text)
        };
        let list = if no_friends {
            empty("You don't have any friends yet.")
        } else if visible.is_empty() {
            empty("No matches.")
        } else {
            div()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .children(visible.into_iter().map(|entry| {
                    let user_id = entry.user.user_id.clone();
                    let checked = self.selected.contains(&user_id);
                    let disabled = self.busy || (!checked && self.selected.len() >= room);
                    let name = entry.user.name().to_string();
                    div()
                        .id(SharedString::from(format!("pick-{user_id}")))
                        .flex()
                        .w_full()
                        .items_center()
                        .gap(px(10.0))
                        .px_2()
                        .py(px(6.0))
                        .text_sm()
                        .when(disabled, |row| row.opacity(0.5))
                        .when(!disabled, |row| {
                            row.cursor_pointer().hover(|s| s.bg(t.accent)).on_click(
                                cx.listener(move |this, _, _, cx| this.toggle(&user_id, cx)),
                            )
                        })
                        .child(ui::avatar::avatar(
                            entry.user.avatar_url.as_deref(),
                            &name,
                            entry.user.avatar_color.as_deref(),
                            32.0,
                            cx,
                        ))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .child(div().truncate().font_weight(FontWeight::MEDIUM).child(name))
                                .child(
                                    div()
                                        .truncate()
                                        .text_size(px(10.0))
                                        .text_color(t.muted_foreground)
                                        .child(entry.user.handle()),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_shrink_0()
                                .items_center()
                                .justify_center()
                                .size_4()
                                .border_1()
                                .border_color(if checked { t.primary } else { t.border })
                                .when(checked, |box_| {
                                    box_.bg(t.primary).child(
                                        icon("check").size_3().text_color(t.primary_foreground),
                                    )
                                }),
                        )
                }))
        };

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(ui::muted(description, cx))
            .child(
                Input::new(&self.query)
                    .prefix(icon("search").size_4().text_color(t.muted_foreground)),
            )
            .child(
                div()
                    .id("friends")
                    .max_h(px(288.0))
                    .overflow_y_scroll()
                    .child(list),
            )
            .children(
                self.error
                    .clone()
                    .map(|error| div().text_xs().text_color(t.destructive).child(error)),
            )
            .child(
                div().flex().justify_end().child(
                    Button::new("submit")
                        .primary()
                        .disabled(self.busy || self.selected.is_empty())
                        .label(submit_label(
                            self.add_to.as_ref().map(|dm| dm.kind),
                            self.selected.len(),
                        ))
                        .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{submit_label, visible_friends};
    use crate::models::{DmType, PublicUser, UserStatus};
    use crate::state::friends::FriendEntry;

    fn friend(id: &str, name: &str) -> FriendEntry {
        FriendEntry {
            user: PublicUser {
                user_id: id.into(),
                username: name.to_lowercase(),
                homeserver: "x.y".into(),
                display_name: Some(name.into()),
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
    fn labels_the_submit_button() {
        assert_eq!(submit_label(None, 1), "Open DM");
        assert_eq!(submit_label(None, 3), "Create Group (3)");
        assert_eq!(submit_label(Some(DmType::Dm), 1), "Create Group");
        assert_eq!(submit_label(Some(DmType::GroupDm), 2), "Add to Group (2)");
    }

    #[test]
    fn hides_members_and_filters_by_query() {
        let list = [friend("a", "Ana"), friend("b", "Leo")];
        let ids = |found: Vec<&FriendEntry>| {
            found
                .iter()
                .map(|f| f.user.user_id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(visible_friends(&list, &["a".into()], "")), ["b"]);
        assert_eq!(ids(visible_friends(&list, &[], "an")), ["a"]);
        assert_eq!(ids(visible_friends(&list, &[], "@leo:x")), ["b"]);
    }
}
