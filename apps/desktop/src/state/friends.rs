// Port of apps/frontend/src/lib/friends.svelte.ts.
use std::future::Future;

use gpui_kit::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    api,
    models::{PublicUser, UserStatus},
    runtime,
    state::dms::Dms,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendEntry {
    pub user: PublicUser,
    pub status: UserStatus,
    pub created_at: String,
    pub accepted_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FriendStatus {
    Friend,
    Incoming,
    Outgoing,
    None,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FriendsPayload {
    accepted: Vec<FriendEntry>,
    incoming: Vec<FriendEntry>,
    outgoing: Vec<FriendEntry>,
}

pub struct Friends {
    pub accepted: Vec<FriendEntry>,
    pub incoming: Vec<FriendEntry>,
    pub outgoing: Vec<FriendEntry>,
    pub loading: bool,
    pub busy_user_ids: Vec<String>,
    pub error: Option<String>,
    load_generation: usize,
}

struct GlobalFriends(Entity<Friends>);
impl Global for GlobalFriends {}

pub fn init(cx: &mut App) {
    let friends = cx.new(|_| Friends {
        accepted: vec![],
        incoming: vec![],
        outgoing: vec![],
        loading: false,
        busy_user_ids: vec![],
        error: None,
        load_generation: 0,
    });
    cx.set_global(GlobalFriends(friends));
}

fn matches(friend: &FriendEntry, username: &str, homeserver: &str) -> bool {
    friend.user.username == username && friend.user.homeserver.eq_ignore_ascii_case(homeserver)
}

impl Friends {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalFriends>().0.clone()
    }

    pub fn status_for(&self, username: &str, homeserver: &str) -> FriendStatus {
        let has = |list: &[FriendEntry]| {
            list.iter()
                .any(|friend| matches(friend, username, homeserver))
        };
        if has(&self.accepted) {
            FriendStatus::Friend
        } else if has(&self.incoming) {
            FriendStatus::Incoming
        } else if has(&self.outgoing) {
            FriendStatus::Outgoing
        } else {
            FriendStatus::None
        }
    }

    pub fn user_id_for(&self, username: &str, homeserver: &str) -> Option<String> {
        self.accepted
            .iter()
            .chain(&self.incoming)
            .chain(&self.outgoing)
            .find(|friend| matches(friend, username, homeserver))
            .map(|friend| friend.user.user_id.clone())
    }

    pub fn load(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.load_generation += 1;
        let generation = self.load_generation;
        self.loading = true;
        self.error = None;
        cx.notify();
        let result = runtime::io(api::get::<FriendsPayload>("/friends"));
        cx.spawn(async move |this, cx| {
            let result = result.await;
            let _ = this.update(cx, |friends, cx| {
                if generation != friends.load_generation {
                    return;
                }
                friends.loading = false;
                match result {
                    Ok(payload) => {
                        friends.accepted = payload.accepted;
                        friends.incoming = payload.incoming;
                        friends.outgoing = payload.outgoing;
                    }
                    Err(error) => {
                        friends.error = Some(api::error_message(
                            &error.body,
                            "Could not load your friends.",
                        ));
                    }
                }
                cx.notify();
            });
        })
    }

    pub fn is_friend(&self, user_id: &str) -> bool {
        self.accepted
            .iter()
            .any(|entry| entry.user.user_id == user_id)
    }

    pub fn is_online(&self, user_id: &str) -> bool {
        self.accepted
            .iter()
            .any(|entry| entry.user.user_id == user_id && entry.status == UserStatus::Online)
    }

    pub fn update_status(&mut self, user_id: &str, status: UserStatus, cx: &mut Context<Self>) {
        for entry in self
            .accepted
            .iter_mut()
            .filter(|entry| entry.user.user_id == user_id)
        {
            entry.status = status;
        }
        cx.notify();
    }

    pub fn request(
        &mut self,
        user_id: String,
        username: &str,
        homeserver: &str,
        cx: &mut Context<Self>,
    ) -> Task<bool> {
        let request = api::post::<api::Ignored>(
            "/friends/request",
            json!({ "username": username, "homeserver": homeserver }),
        );
        self.mutate(user_id, request, "Could not send the friend request.", cx)
    }

    pub fn accept(&mut self, user_id: String, cx: &mut Context<Self>) -> Task<bool> {
        let request =
            api::post::<api::Ignored>(format!("/friends/requests/{user_id}/accept"), json!({}));
        let accepted = self.mutate(
            user_id.clone(),
            request,
            "Could not accept the friend request.",
            cx,
        );
        cx.spawn(async move |_, cx| {
            let accepted = accepted.await;
            // jump straight into a conversation with the new friend
            if accepted {
                let open =
                    cx.update(|cx| Dms::global(cx).update(cx, |dms, cx| dms.open(user_id, cx)));
                open.await;
            }
            accepted
        })
    }

    pub fn decline(&mut self, user_id: String, cx: &mut Context<Self>) -> Task<bool> {
        let request =
            api::post::<api::Ignored>(format!("/friends/requests/{user_id}/decline"), json!({}));
        self.mutate(
            user_id,
            request,
            "Could not decline the friend request.",
            cx,
        )
    }

    pub fn remove(&mut self, user_id: String, cx: &mut Context<Self>) -> Task<bool> {
        let request = api::delete::<api::Ignored>(format!("/friends/{user_id}"));
        self.mutate(user_id, request, "Could not remove this friend.", cx)
    }

    fn mutate(
        &mut self,
        user_id: String,
        request: impl Future<Output = api::ApiResult<api::Ignored>> + 'static,
        fallback: &'static str,
        cx: &mut Context<Self>,
    ) -> Task<bool> {
        self.busy_user_ids.push(user_id.clone());
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let ok = result.is_ok();
            let load = this.update(cx, |friends, cx| {
                if let Err(error) = result {
                    friends.error = Some(api::error_message(&error.body, fallback));
                }
                cx.notify();
                ok.then(|| friends.load(cx))
            });
            if let Ok(Some(load)) = load {
                load.await;
            }
            let _ = this.update(cx, |friends, cx| {
                friends.busy_user_ids.retain(|id| *id != user_id);
                cx.notify();
            });
            ok
        })
    }
}
