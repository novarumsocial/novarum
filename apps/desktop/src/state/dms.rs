// Port of apps/frontend/src/lib/dms.svelte.ts.
use gpui_kit::*;
use serde::Deserialize;
use serde_json::json;

use crate::{
    api,
    models::{DmChannel, DmLastMessage, DmLastMessageAuthor, DmType, DmUpdate, MessageData, PublicUser},
    state::{
        chat::UploadFile,
        router::{self, encode},
        session::{Session, SessionUser},
    },
    util::system_message::system_text,
};

pub type DmEntry = DmChannel;

pub const RING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn same_user(username: &str, homeserver: &str, other_username: &str, other_homeserver: &str) -> bool {
    username.eq_ignore_ascii_case(other_username) && homeserver.eq_ignore_ascii_case(other_homeserver)
}

/// relayed federated messages carry the host's user ids, so authors are matched by handle to ours
fn to_preview(dm: &DmEntry, message: &MessageData, me: Option<&SessionUser>) -> DmLastMessage {
    let author = &message.author;
    let author_id = match me {
        Some(me) if same_user(&me.username, &me.homeserver, &author.username, &author.homeserver) => me.id.clone(),
        _ => dm
            .participants
            .iter()
            .find(|user| same_user(&user.username, &user.homeserver, &author.username, &author.homeserver))
            .map(|user| user.user_id.clone())
            .unwrap_or_else(|| author.user_id.clone()),
    };
    DmLastMessage {
        id: message.id.clone(),
        author_id,
        content: message.content.clone(),
        attachment_count: message.attachments.len() as u32,
        system: message.system.clone(),
        author: Some(DmLastMessageAuthor {
            username: author.username.clone(),
            display_name: author.display_name.clone(),
        }),
    }
}

fn person_name(display_name: Option<&str>, username: &str) -> String {
    display_name.filter(|name| !name.is_empty()).unwrap_or(username).to_string()
}

/// "You: hi", "Ana: hi" in a group, or what the homeserver wrote ("Ana added Leo...").
pub fn dm_preview_text(dm: &DmEntry, me: Option<&SessionUser>) -> Option<String> {
    let last = dm.last_message.as_ref()?;
    let from_me = me.is_some_and(|me| me.id == last.author_id);
    // (display name, username) of whoever wrote it, even after they left the group
    let author: Option<(Option<&str>, &str)> = if from_me {
        me.map(|me| (me.display_name.as_deref(), me.username.as_str()))
    } else {
        dm.participants
            .iter()
            .find(|user| user.user_id == last.author_id)
            .map(|user| (user.display_name.as_deref(), user.username.as_str()))
            .or_else(|| last.author.as_ref().map(|author| (author.display_name.as_deref(), author.username.as_str())))
    };
    if let Some(system) = &last.system {
        return author.map(|(display_name, username)| system_text(system, display_name, username));
    }

    let text = match (&last.content, last.attachment_count) {
        (Some(content), _) => content.clone(),
        (None, 0) => return None,
        (None, 1) => "Sent an attachment".into(),
        (None, count) => format!("Sent {count} attachments"),
    };
    if from_me {
        return Some(format!("You: {text}"));
    }
    // in a group, who said it matters
    match author {
        Some((display_name, username)) if dm.kind == DmType::GroupDm => {
            Some(format!("{}: {text}", person_name(display_name, username)))
        }
        _ => Some(text),
    }
}

/// federated DM ids look like fed:channel:<homeserver>:<id> (see anchor's federationIds.ts)
fn is_from_homeserver(dm: &DmEntry, homeserver: &str) -> bool {
    dm.id.starts_with(&format!("fed:channel:{}:", encode(homeserver)))
}

#[derive(Debug, Clone, PartialEq)]
pub struct DmDisplay {
    pub name: String,
    pub avatar_url: Option<String>,
    pub avatar_color: Option<String>,
    pub other: Option<PublicUser>,
}

/// What a DM is called and shown as: the other person, or the group's name and icon.
pub fn dm_display(dm: &DmEntry) -> DmDisplay {
    if dm.kind != DmType::GroupDm {
        let other = dm.participants.first();
        return DmDisplay {
            name: other
                .map(|user| person_name(user.display_name.as_deref(), &user.username))
                .unwrap_or_else(|| "Direct Message".into()),
            avatar_url: other.and_then(|user| user.avatar_url.clone()),
            avatar_color: other.and_then(|user| user.avatar_color.clone()),
            other: other.cloned(),
        };
    }
    let people: Vec<String> = dm
        .participants
        .iter()
        .filter(|user| !user.is_bot)
        .map(|user| person_name(user.display_name.as_deref(), &user.username))
        .collect();
    let name = match dm.name.as_deref() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ if !people.is_empty() => people.join(", "),
        _ => "Empty group".into(),
    };
    DmDisplay { name, avatar_url: dm.icon_url.clone(), avatar_color: None, other: None }
}

pub fn dm_path(channel_id: &str, message_id: Option<&str>) -> String {
    let path = format!("/guilds/dms/{}", encode(channel_id));
    match message_id {
        Some(message_id) => format!("{path}/{}", encode(message_id)),
        None => path,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct IncomingCall {
    pub channel_id: String,
    pub user: PublicUser,
}

#[derive(Deserialize)]
struct DmList {
    dms: Vec<DmEntry>,
    #[serde(default)]
    pending: Vec<String>,
}

#[derive(Deserialize)]
struct Created {
    id: String,
}

pub struct Dms {
    pub list: Vec<DmEntry>,
    pub loading: bool,
    pub error: Option<String>,
    /// homeservers whose DMs are still on their way; each one fills in on its own.
    pub pending: Vec<String>,
    pub incoming_call: Option<IncomingCall>,
    pub outgoing_call: Option<String>,
    generation: usize,
}

struct GlobalDms(Entity<Dms>);
impl Global for GlobalDms {}

pub fn init(cx: &mut App) {
    let dms = cx.new(|_| Dms {
        list: vec![],
        loading: false,
        error: None,
        pending: vec![],
        incoming_call: None,
        outgoing_call: None,
        generation: 0,
    });
    cx.set_global(GlobalDms(dms));
}

/// `null` on success, the server's message otherwise.
fn error_of<T>(result: api::ApiResult<T>, fallback: &str) -> Result<(), String> {
    result.map(|_| ()).map_err(|error| api::error_message(&error.body, fallback))
}

impl Dms {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalDms>().0.clone()
    }

    pub fn get(&self, channel_id: &str) -> Option<&DmEntry> {
        self.list.iter().find(|dm| dm.id == channel_id)
    }

    /// the DM that already exists with this friend, if any — used to avoid opening duplicates.
    pub fn with_user(&self, user_id: &str) -> Option<&DmEntry> {
        self.list.iter().find(|dm| dm.kind == DmType::Dm && dm.participants.iter().any(|user| user.user_id == user_id))
    }

    pub fn load(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.loading = true;
        self.error = None;
        self.generation += 1;
        let generation = self.generation;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::get::<DmList>("/dm").await;
            let _ = this.update(cx, |dms, cx| {
                if generation != dms.generation {
                    return;
                }
                dms.loading = false;
                cx.notify();
                let Ok(DmList { dms: list, pending }) = result else {
                    dms.error = Some("Could not load your direct messages.".into());
                    return;
                };
                // keep showing federated DMs until their homeserver's fetch replaces them.
                let kept =
                    dms.list.drain(..).filter(|dm| pending.iter().any(|homeserver| is_from_homeserver(dm, homeserver)));
                dms.list = list.into_iter().chain(kept.collect::<Vec<_>>()).collect();
                for homeserver in &pending {
                    dms.load_homeserver(homeserver.clone(), generation, cx).detach();
                }
                dms.pending = pending;
            });
        })
    }

    fn load_homeserver(&mut self, homeserver: String, generation: usize, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let result = api::get::<DmList>(format!("/dm/homeserver/{homeserver}")).await;
            let _ = this.update(cx, |dms, cx| {
                if generation != dms.generation {
                    return;
                }
                if let Ok(result) = result {
                    dms.list.retain(|dm| !is_from_homeserver(dm, &homeserver));
                    for dm in result.dms {
                        dms.upsert(dm, cx);
                    }
                }
                dms.pending.retain(|item| *item != homeserver);
                cx.notify();
            });
        })
    }

    /// resolves the DM channel with a friend, creating it if needed, without navigating.
    pub fn ensure(&mut self, user_id: String, cx: &mut Context<Self>) -> Task<Option<String>> {
        if let Some(existing) = self.with_user(&user_id) {
            return Task::ready(Some(existing.id.clone()));
        }
        cx.spawn(async move |this, cx| {
            let dm = api::post::<DmEntry>("/dm", json!({ "userId": user_id })).await.ok()?;
            let id = dm.id.clone();
            this.update(cx, |dms, cx| dms.upsert(dm, cx)).ok()?;
            Some(id)
        })
    }

    pub fn open(&mut self, user_id: String, cx: &mut Context<Self>) -> Task<Option<String>> {
        let ensure = self.ensure(user_id, cx);
        cx.spawn(async move |_, cx| {
            let channel_id = ensure.await;
            if let Some(channel_id) = &channel_id {
                cx.update(|cx| router::goto(dm_path(channel_id, None), cx));
            }
            channel_id
        })
    }

    pub fn close(&mut self, channel_id: String, cx: &mut Context<Self>) -> Task<()> {
        let closed = self.get(&channel_id).cloned();
        self.list.retain(|dm| dm.id != channel_id);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::post::<api::Ignored>(format!("/dm/{channel_id}/close"), json!({})).await;
            if let (Err(_), Some(closed)) = (result, closed) {
                let _ = this.update(cx, |dms, cx| dms.upsert(closed, cx));
            }
        })
    }

    /// a group with these friends; any number of them, so adding people to a 1:1 makes a new group
    pub fn create_group(
        &mut self,
        user_ids: Vec<String>,
        name: String,
        cx: &mut Context<Self>,
    ) -> Task<Result<String, String>> {
        cx.spawn(async move |this, cx| {
            let dm = api::post::<DmEntry>("/dm/group", json!({ "userIds": user_ids, "name": name }))
                .await
                .map_err(|error| api::error_message(&error.body, "Could not create the group."))?;
            let id = dm.id.clone();
            let _ = this.update(cx, |dms, cx| dms.upsert(dm, cx));
            cx.update(|cx| router::goto(dm_path(&id, None), cx));
            Ok(id)
        })
    }

    pub fn add_members(&self, channel_id: &str, user_ids: Vec<String>, cx: &App) -> Task<Result<(), String>> {
        let request = api::post::<api::Ignored>(format!("/dm/{channel_id}/members"), json!({ "userIds": user_ids }));
        cx.spawn(async move |_| error_of(request.await, "Could not add them."))
    }

    pub fn kick(&self, channel_id: &str, user_id: &str, cx: &App) -> Task<Result<(), String>> {
        let request = api::delete::<api::Ignored>(format!("/dm/{channel_id}/members/{user_id}"));
        cx.spawn(async move |_| error_of(request.await, "Could not remove them."))
    }

    pub fn transfer_owner(&self, channel_id: &str, user_id: &str, cx: &App) -> Task<Result<(), String>> {
        let request = api::post::<api::Ignored>(format!("/dm/{channel_id}/owner"), json!({ "userId": user_id }));
        cx.spawn(async move |_| error_of(request.await, "Could not transfer the group."))
    }

    pub fn rename(&self, channel_id: &str, name: &str, cx: &App) -> Task<Result<(), String>> {
        let request = api::patch::<api::Ignored>(format!("/dm/{channel_id}"), json!({ "name": name }));
        cx.spawn(async move |_| error_of(request.await, "Could not rename the group."))
    }

    pub fn upload_icon(&self, channel_id: &str, icon: UploadFile, cx: &App) -> Task<Result<(), String>> {
        let request = api::post_file::<api::Ignored>(format!("/dm/{channel_id}/icon"), "icon", icon);
        cx.spawn(async move |_| error_of(request.await, "Could not upload the icon."))
    }

    pub fn add_bot(&self, channel_id: &str, username: &str, homeserver: &str, cx: &App) -> Task<Result<(), String>> {
        let body = json!({ "username": username, "homeserver": homeserver });
        let request = api::post::<api::Ignored>(format!("/dm/{channel_id}/bots"), body);
        cx.spawn(async move |_| error_of(request.await, "Could not add the bot."))
    }

    pub fn leave(&mut self, channel_id: String, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            let result = api::post::<api::Ignored>(format!("/dm/{channel_id}/leave"), json!({})).await;
            error_of(result, "Could not leave the group.")?;
            let _ = this.update(cx, |dms, cx| dms.remove(&channel_id, cx));
            Ok(())
        })
    }

    pub fn remove(&mut self, channel_id: &str, cx: &mut Context<Self>) {
        self.list.retain(|dm| dm.id != channel_id);
        if self.incoming_call.as_ref().is_some_and(|call| call.channel_id == channel_id) {
            self.incoming_call = None;
        }
        if self.outgoing_call.as_deref() == Some(channel_id) {
            self.outgoing_call = None;
        }
        cx.notify();
    }

    pub fn update(&mut self, change: DmUpdate, cx: &mut Context<Self>) {
        if let Some(dm) = self.list.iter_mut().find(|dm| dm.id == change.id) {
            dm.name = change.name;
            dm.icon_url = change.icon_url;
            dm.owner_id = change.owner_id;
            dm.participants = change.participants;
            cx.notify();
        }
    }

    pub fn upsert(&mut self, dm: DmEntry, cx: &mut Context<Self>) {
        match self.list.iter_mut().find(|item| item.id == dm.id) {
            Some(existing) => *existing = dm,
            None => self.list.insert(0, dm),
        }
        cx.notify();
    }

    pub fn handle_message(&mut self, message: &MessageData, active: bool, cx: &mut Context<Self>) {
        if self.get(&message.channel_id).is_none() {
            self.load(cx).detach();
            return;
        }
        let me = Session::user(cx);
        if let Some(dm) = self.list.iter_mut().find(|dm| dm.id == message.channel_id) {
            let last = to_preview(dm, message, me.as_ref());
            let from_self = me.as_ref().is_some_and(|me| me.id == last.author_id);
            dm.last_message_at = Some(message.created_at.clone());
            dm.last_message = Some(last);
            dm.unread = !active && !from_self;
        }
        cx.notify();
    }

    pub fn handle_message_edit(&mut self, message: &MessageData, cx: &mut Context<Self>) {
        let me = Session::user(cx);
        for dm in &mut self.list {
            if dm.last_message.as_ref().is_some_and(|last| last.id == message.id) {
                dm.last_message = Some(to_preview(dm, message, me.as_ref()));
            }
        }
        cx.notify();
    }

    /// the preview before a deleted newest message isn't known here, so the server picks it again
    pub fn handle_message_delete(&mut self, message_id: &str, cx: &mut Context<Self>) {
        if self.list.iter().any(|dm| dm.last_message.as_ref().is_some_and(|last| last.id == message_id)) {
            self.load(cx).detach();
        }
    }

    pub fn mark_read(&mut self, channel_id: &str, cx: &mut Context<Self>) {
        if let Some(dm) = self.list.iter_mut().find(|dm| dm.id == channel_id) {
            dm.unread = false;
            cx.notify();
        }
    }

    pub fn set_incoming_call(&mut self, call: Option<IncomingCall>, cx: &mut Context<Self>) {
        self.incoming_call = call;
        cx.notify();
    }

    pub fn set_outgoing_call(&mut self, channel_id: Option<String>, cx: &mut Context<Self>) {
        self.outgoing_call = channel_id;
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{DmEntry, dm_display, dm_path, dm_preview_text};
    use crate::models::{DmLastMessage, DmType, PublicUser, SystemMessage};
    use crate::state::session::SessionUser;

    fn user(id: &str, name: &str) -> PublicUser {
        PublicUser {
            user_id: id.into(),
            username: name.to_lowercase(),
            homeserver: "x".into(),
            display_name: Some(name.into()),
            avatar_url: None,
            avatar_color: None,
            speaking_ring_color: None,
            banner_url: None,
            about: None,
            is_bot: false,
        }
    }

    fn me() -> SessionUser {
        SessionUser {
            id: "me".into(),
            username: "ana".into(),
            homeserver: "x".into(),
            handle: "@ana:x".into(),
            email: None,
            display_name: Some("Ana".into()),
            avatar_url: None,
            avatar_color: None,
            speaking_ring_color: None,
            banner_url: None,
            about: None,
            is_bot: false,
        }
    }

    fn dm(kind: DmType, participants: Vec<PublicUser>, last: Option<(&str, Option<&str>, u32)>) -> DmEntry {
        DmEntry {
            id: "d1".into(),
            kind,
            participants,
            name: None,
            icon_url: None,
            owner_id: None,
            last_message_at: None,
            last_message: last.map(|(author_id, content, attachment_count)| DmLastMessage {
                id: "m".into(),
                author_id: author_id.into(),
                content: content.map(str::to_string),
                attachment_count,
                system: None,
                author: None,
            }),
            unread: false,
            joined_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn previews_say_who_wrote_what() {
        let me = me();
        let one = dm(DmType::Dm, vec![user("leo", "Leo")], Some(("leo", Some("hi"), 0)));
        assert_eq!(dm_preview_text(&one, Some(&me)).as_deref(), Some("hi"));
        let mine = dm(DmType::Dm, vec![user("leo", "Leo")], Some(("me", None, 2)));
        assert_eq!(dm_preview_text(&mine, Some(&me)).as_deref(), Some("You: Sent 2 attachments"));
        let group = dm(DmType::GroupDm, vec![user("leo", "Leo")], Some(("leo", None, 1)));
        assert_eq!(dm_preview_text(&group, Some(&me)).as_deref(), Some("Leo: Sent an attachment"));
        let mut system = dm(DmType::GroupDm, vec![user("leo", "Leo")], Some(("leo", None, 0)));
        system.last_message.as_mut().unwrap().system = Some(SystemMessage::MemberLeft);
        assert_eq!(dm_preview_text(&system, Some(&me)).as_deref(), Some("Leo left the group."));
        assert_eq!(dm_preview_text(&dm(DmType::Dm, vec![], None), Some(&me)), None);
    }

    #[test]
    fn displays_people_or_groups() {
        assert_eq!(dm_display(&dm(DmType::Dm, vec![user("leo", "Leo")], None)).name, "Leo");
        assert_eq!(dm_display(&dm(DmType::Dm, vec![], None)).name, "Direct Message");
        let mut group = dm(DmType::GroupDm, vec![user("leo", "Leo"), user("mia", "Mia")], None);
        assert_eq!(dm_display(&group).name, "Leo, Mia");
        group.name = Some("Crew".into());
        assert_eq!(dm_display(&group).name, "Crew");
        assert_eq!(dm_display(&dm(DmType::GroupDm, vec![], None)).name, "Empty group");
    }

    #[test]
    fn builds_dm_paths() {
        assert_eq!(dm_path("fed:channel:a.b:1", None), "/guilds/dms/fed%3Achannel%3Aa.b%3A1");
        assert_eq!(dm_path("d", Some("m")), "/guilds/dms/d/m");
    }
}
