// Port of apps/frontend/src/lib/realtime.svelte.ts: the socket, its reconnects, and every event
// dispatched into the stores.
use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
    time::Duration,
};

use futures::StreamExt;
use gpui_kit::*;
use serde::Serialize;
use serde_json::json;

use crate::{
    models::Emoji,
    notifications::{self, NotificationOptions, NotifyContext},
    realtime_events::RealtimeEvent,
    socket::{self, Socket, SocketMessage},
    state::{
        chat::{Chat, GuildInput, guild_path},
        dms::{Dms, IncomingCall, dm_display, dm_path},
        friends::Friends,
        notification_settings::NotificationSettings,
        router,
        session::Session,
        settings::SettingsStore,
    },
};

/// What a canvas sends over the socket (canvas.svelte.ts's `CanvasMessage`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum CanvasMessage {
    #[serde(rename = "canvas.join")]
    Join { channel_id: String },
    #[serde(rename = "canvas.leave")]
    Leave { channel_id: String },
    #[serde(rename = "canvas.update")]
    Update { channel_id: String, update: String },
    #[serde(rename = "canvas.awareness")]
    Awareness {
        channel_id: String,
        update: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        hello: Option<bool>,
    },
}

/// An open canvas (canvas.rs, later): gets its channel's canvas events, and rejoins after a
/// reconnect. Both run deferred, so it may call back into `Realtime`.
pub trait CanvasHandler {
    fn handle(&self, event: &RealtimeEvent, cx: &mut App);
    fn join(&self, cx: &mut App);
}

/// `openCanvases`: channel id -> the canvas open on it.
#[derive(Default)]
pub struct OpenCanvases(pub HashMap<String, Rc<dyn CanvasHandler>>);
impl Global for OpenCanvases {}

pub struct Realtime {
    pub connected: bool,
    pub emoji_query: String,
    pub emoji_results: Vec<Emoji>,
    /// unicode (uppercase hex) -> image url
    pub emoji_urls: HashMap<String, String>,
    /// whether a Novarum window has focus, for `client.state` and notifications
    pub window_active: bool,
    pending_emoji_unicodes: HashSet<String>,
    missing_emoji_unicodes: HashSet<String>,
    queued_emoji_unicodes: Vec<String>,
    emoji_query_timer: Option<Task<()>>,
    socket: Option<Socket>,
    /// tells sockets apart, like the web's `this.socket !== socket`
    socket_id: usize,
    reader: Option<Task<()>>,
    reconnect_timer: Option<Task<()>>,
    reconnect_attempt: u32,
    active: bool,
    should_recover: bool,
    voice_channel_id: Option<String>,
}

struct GlobalRealtime(Entity<Realtime>);
impl Global for GlobalRealtime {}

pub fn init(cx: &mut App) {
    let realtime = cx.new(|_| Realtime {
        connected: false,
        emoji_query: String::new(),
        emoji_results: vec![],
        emoji_urls: HashMap::new(),
        window_active: true,
        pending_emoji_unicodes: HashSet::new(),
        missing_emoji_unicodes: HashSet::new(),
        queued_emoji_unicodes: vec![],
        emoji_query_timer: None,
        socket: None,
        socket_id: 0,
        reader: None,
        reconnect_timer: None,
        reconnect_attempt: 0,
        active: false,
        should_recover: false,
        voice_channel_id: None,
    });
    cx.set_global(GlobalRealtime(realtime));
    cx.default_global::<OpenCanvases>();
}

/// 1s, 2s, 4s... up to 30s between reconnect attempts.
pub fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_millis((1_000u64 << attempt.min(5)).min(30_000))
}

impl Realtime {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalRealtime>().0.clone()
    }

    pub fn connect(cx: &mut App) {
        Self::global(cx).update(cx, |realtime, cx| {
            realtime.active = true;
            realtime.open_socket(cx);
        });
    }

    pub fn disconnect(cx: &mut App) {
        Self::global(cx).update(cx, |realtime, cx| {
            realtime.active = false;
            realtime.connected = false;
            realtime.reconnect_timer = None;
            realtime.reader = None;
            realtime.socket = None;
            cx.notify();
        });
    }

    /// The shell calls this when a window gains or loses focus. The server skips push for users
    /// with an active window, so it has to hear when this one stops being it.
    pub fn set_window_active(active: bool, cx: &mut App) {
        Self::global(cx).update(cx, |realtime, _| {
            realtime.window_active = active;
            realtime.send_client_state();
        });
    }

    fn send_client_state(&self) {
        if let Some(socket) = &self.socket {
            socket.send(json!({ "type": "client.state", "active": self.window_active }));
        }
    }

    fn send(&self, message: serde_json::Value) {
        if let (Some(socket), true) = (&self.socket, self.connected) {
            socket.send(message);
        }
    }

    fn open_socket(&mut self, cx: &mut Context<Self>) {
        if !self.active || self.socket.is_some() {
            return;
        }
        let (socket, mut incoming) = socket::open();
        self.socket = Some(socket);
        self.socket_id += 1;
        let id = self.socket_id;
        self.reader = Some(cx.spawn(async move |this, cx| {
            while let Some(message) = incoming.next().await {
                let closed = matches!(message, SocketMessage::Closed);
                if this
                    .update(cx, |realtime, cx| realtime.on_message(id, message, cx))
                    .is_err()
                    || closed
                {
                    break;
                }
            }
        }));
    }

    fn on_message(&mut self, id: usize, message: SocketMessage, cx: &mut Context<Self>) {
        if id != self.socket_id {
            return;
        }
        match message {
            SocketMessage::Open => self.on_open(cx),
            SocketMessage::Closed => self.on_close(cx),
            SocketMessage::Event(event) => self.dispatch(event, cx),
        }
    }

    fn on_open(&mut self, cx: &mut Context<Self>) {
        if !self.active {
            return;
        }
        self.connected = true;
        self.reconnect_attempt = 0;
        self.send_client_state();
        cx.notify();

        for server in &Chat::global(cx).read(cx).servers {
            self.subscribe_guild(&server.id);
        }
        // a fresh sync also sends back anything typed while we were disconnected
        let canvases: Vec<_> = cx.global::<OpenCanvases>().0.values().cloned().collect();
        cx.defer(move |cx| canvases.iter().for_each(|canvas| canvas.join(cx)));
        if let Some(channel_id) = &self.voice_channel_id {
            self.send(json!({ "type": "voice.join", "channelId": channel_id }));
        }

        if self.should_recover {
            self.should_recover = false;
            Chat::global(cx)
                .update(cx, |chat, cx| chat.recover_realtime_state(cx))
                .detach();
        }
    }

    fn on_close(&mut self, cx: &mut Context<Self>) {
        self.socket = None;
        self.connected = false;
        self.emoji_query_timer = None;
        self.queued_emoji_unicodes.clear();
        self.pending_emoji_unicodes.clear();
        self.should_recover = true;
        cx.notify();
        self.schedule_reconnect(cx);
    }

    fn schedule_reconnect(&mut self, cx: &mut Context<Self>) {
        if !self.active || self.reconnect_timer.is_some() {
            return;
        }
        let delay = reconnect_delay(self.reconnect_attempt);
        self.reconnect_attempt += 1;
        self.reconnect_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |realtime, cx| {
                realtime.reconnect_timer = None;
                realtime.open_socket(cx);
            });
        }));
    }

    fn dispatch(&mut self, event: RealtimeEvent, cx: &mut Context<Self>) {
        let chat = Chat::global(cx);
        let dms = Dms::global(cx);
        match event {
            RealtimeEvent::EmojiQueryResults(results) => {
                let found: HashSet<&str> = results
                    .emojis
                    .iter()
                    .map(|emoji| emoji.unicode.as_str())
                    .collect();
                for unicode in &results.unicodes {
                    self.pending_emoji_unicodes.remove(unicode);
                    if !found.contains(unicode.as_str()) {
                        self.missing_emoji_unicodes.insert(unicode.clone());
                    }
                }
                for emoji in results.emojis {
                    self.emoji_urls.insert(emoji.unicode, emoji.url);
                }
                cx.notify();
            }
            RealtimeEvent::EmojiSearchResults(results) => {
                self.emoji_query = results.query;
                self.emoji_results = results.emojis;
                cx.notify();
            }
            RealtimeEvent::GuildCreated(guild) => {
                chat.update(cx, |chat, cx| {
                    chat.add_guild(GuildInput::from(&guild), cx);
                    for channel in &guild.channels {
                        chat.add_channel(channel, None, cx);
                    }
                });
                self.subscribe_guild(&guild.id);
                chat.update(cx, |chat, cx| chat.select_server(Some(&guild.id), cx));
            }
            RealtimeEvent::ChannelCreated(channel) => {
                chat.update(cx, |chat, cx| {
                    chat.add_channel(&channel, None, cx);
                });
            }
            RealtimeEvent::ChannelUpdated(channel) => chat.update(cx, |chat, cx| {
                chat.set_channel_owner_only(&channel.guild_id, &channel.id, channel.owner_only, cx)
            }),
            RealtimeEvent::MessageCreated(message) => {
                self.notify_message(&message, cx);
                let is_dm = message.guild_id.is_none();
                let is_active = chat.read(cx).active_channel(cx).as_deref()
                    == Some(message.channel_id.as_str());
                let (channel_id, author_id) =
                    (message.channel_id.clone(), message.author.user_id.clone());
                if is_dm {
                    dms.update(cx, |dms, cx| dms.handle_message(&message, is_active, cx));
                }
                chat.update(cx, |chat, cx| {
                    chat.add_message(message, cx);
                    chat.clear_typing(&channel_id, &author_id, cx);
                });
            }
            RealtimeEvent::MessageUpdated(mut message) => {
                message.edited = true;
                dms.update(cx, |dms, cx| dms.handle_message_edit(&message, cx));
                let channel_id = message.channel_id.clone();
                chat.update(cx, |chat, cx| chat.update_message(&channel_id, message, cx));
            }
            RealtimeEvent::MessageDeleted(deleted) => {
                chat.update(cx, |chat, cx| {
                    chat.remove_message(&deleted.channel_id, &deleted.id, cx)
                });
                dms.update(cx, |dms, cx| dms.handle_message_delete(&deleted.id, cx));
            }
            RealtimeEvent::UserStatusChanged(change) => {
                chat.update(cx, |chat, cx| {
                    chat.update_member_status(&change.user_id, change.status, cx)
                });
                let friends = Friends::global(cx);
                friends.update(cx, |friends, cx| {
                    friends.update_status(&change.user_id, change.status, cx)
                });
            }
            RealtimeEvent::MemberJoined(joined) => chat.update(cx, |chat, cx| {
                chat.add_or_update_member(&joined.guild_id, &joined.user, cx)
            }),
            RealtimeEvent::MemberLeft(left) => {
                chat.update(cx, |chat, cx| chat.remove_member(&left.user_id, cx))
            }
            RealtimeEvent::MessageEphemeral(mut message) => {
                message.ephemeral = true;
                chat.update(cx, |chat, cx| chat.add_ephemeral(message, cx));
            }
            RealtimeEvent::VoiceStatesSnapshot(snapshot) => chat.update(cx, |chat, cx| {
                chat.set_voice_states(&snapshot.guild_ids, &snapshot.states, &snapshot.dm_ids, cx)
            }),
            RealtimeEvent::VoiceStateChanged(change) => {
                chat.update(cx, |chat, cx| chat.update_voice_state(&change, cx))
            }
            RealtimeEvent::CallRinging(ring) => self.on_ring(ring, cx),
            RealtimeEvent::ChannelTyping(typing) => chat.update(cx, |chat, cx| {
                let name = typing.display_name.as_deref().unwrap_or(&typing.username);
                chat.set_typing(
                    &typing.channel_id,
                    &typing.user_id,
                    &typing.username,
                    &typing.homeserver,
                    name,
                    cx,
                )
            }),
            RealtimeEvent::CanvasSync(_)
            | RealtimeEvent::CanvasUpdate(_)
            | RealtimeEvent::CanvasAwareness(_) => {
                let channel_id = match &event {
                    RealtimeEvent::CanvasSync(sync) => &sync.channel_id,
                    RealtimeEvent::CanvasUpdate(update) => &update.channel_id,
                    RealtimeEvent::CanvasAwareness(awareness) => &awareness.channel_id,
                    _ => unreachable!(),
                };
                if let Some(canvas) = cx.global::<OpenCanvases>().0.get(channel_id).cloned() {
                    cx.defer(move |cx| canvas.handle(&event, cx));
                }
            }
            RealtimeEvent::ChannelsReordered(order) => chat.update(cx, |chat, cx| {
                chat.reorder_channels(&order.guild_id, &order.channel_ids, cx)
            }),
            RealtimeEvent::FriendsChanged(_) => Friends::global(cx)
                .update(cx, |friends, cx| friends.load(cx))
                .detach(),
            RealtimeEvent::UserUpdated(updated) => {
                chat.update(cx, |chat, cx| chat.update_user_profile(&updated.user, cx))
            }
            RealtimeEvent::DmCreated(dm) => dms.update(cx, |dms, cx| dms.upsert(dm, cx)),
            RealtimeEvent::DmUpdated(change) => dms.update(cx, |dms, cx| dms.update(change, cx)),
            RealtimeEvent::DmRemoved(removed) => {
                dms.update(cx, |dms, cx| dms.remove(&removed.id, cx));
                if chat.read(cx).active_channel(cx).as_deref() == Some(removed.id.as_str()) {
                    router::goto("/guilds/dms", cx);
                }
            }
        }
    }

    fn notify_message(&self, message: &crate::models::MessageData, cx: &mut Context<Self>) {
        let Some(user) = Session::user(cx) else {
            return;
        };
        let chat = Chat::global(cx).read(cx);
        let active_channel = chat.active_channel(cx);
        let entries = &NotificationSettings::global(cx).read(cx).entries;
        let context = NotifyContext {
            user_id: &user.id,
            handle: &user.handle,
            active_channel_id: active_channel.as_deref(),
            has_focus: self.window_active,
            entries,
        };
        if !notifications::should_notify(message, &context) {
            return;
        }

        let settings = SettingsStore::get(cx);
        // the sound follows its own switch, so it plays even with system notifications off
        if settings.mention_sound {
            notifications::notification_sound(cx);
        }
        if !settings.push_notifications {
            return;
        }
        let is_dm = message.guild_id.is_none();
        let guild_id = message.guild_id.as_deref().unwrap_or_default();
        let guild = chat
            .servers
            .iter()
            .find(|server| server.id == guild_id)
            .map(|server| server.name.as_str());
        let channel = chat
            .channels_by_server
            .get(guild_id)
            .into_iter()
            .flatten()
            .flat_map(|category| &category.channels)
            .find(|channel| channel.id == message.channel_id)
            .map(|channel| channel.name.as_str());
        let author = &message.author;
        let body = if settings.message_preview {
            message
                .content
                .clone()
                .unwrap_or_else(|| "Sent an attachment".into())
        } else if is_dm {
            "Sent you a message".into()
        } else {
            "Mentioned you".into()
        };
        // fed: ids stay as they are, so the link opens the shadow guild or DM
        let path = if is_dm {
            dm_path(&message.channel_id, None)
        } else {
            guild_path(Some(guild_id), Some(&message.channel_id), Some(&message.id))
        };
        let notification = NotificationOptions {
            title: notifications::message_notification_title(
                author.display_name.as_deref(),
                &author.username,
                (!is_dm).then_some((channel, guild)),
            ),
            body: Some(body),
            tag: Some(message.channel_id.clone()),
            on_click: Some(path),
        };
        notifications::send_notification(notification, cx);
    }

    fn on_ring(&mut self, ring: crate::realtime_events::CallRinging, cx: &mut Context<Self>) {
        let dms = Dms::global(cx);
        let user = Session::user(cx);
        let caller = ring.user;
        let channel_id = ring.channel_id;
        let is_self = user.as_ref().is_some_and(|user| {
            caller.username == user.username
                && caller.homeserver.eq_ignore_ascii_case(&user.homeserver)
        });

        if !ring.ringing {
            // declined on another of my devices, the caller hung up, or the other person declined my call.
            dms.update(cx, |dms, cx| {
                let ended = dms.incoming_call.as_ref().is_some_and(|incoming| {
                    incoming.channel_id == channel_id
                        && (is_self
                            || (incoming.user.username == caller.username
                                && incoming
                                    .user
                                    .homeserver
                                    .eq_ignore_ascii_case(&caller.homeserver)))
                });
                if ended {
                    dms.set_incoming_call(None, cx);
                }
                if !is_self && dms.outgoing_call.as_deref() == Some(channel_id.as_str()) {
                    dms.set_outgoing_call(None, cx);
                }
            });
            return;
        }
        if is_self {
            return;
        }

        let call = IncomingCall {
            channel_id: channel_id.clone(),
            user: caller.clone(),
        };
        dms.update(cx, |dms, cx| dms.set_incoming_call(Some(call), cx));
        if !self.window_active && SettingsStore::get(cx).push_notifications {
            notifications::notification_sound(cx);
            let body = match dms.read(cx).get(&channel_id) {
                Some(group) if group.kind == crate::models::DmType::GroupDm => {
                    format!("Is calling {}", dm_display(group).name)
                }
                _ => "Is calling you".into(),
            };
            let notification = NotificationOptions {
                title: caller.name().to_string(),
                body: Some(body),
                tag: Some(format!("call:{channel_id}")),
                on_click: Some(dm_path(&channel_id, None)),
            };
            notifications::send_notification(notification, cx);
        }
    }

    pub fn subscribe_guild(&self, guild_id: &str) {
        self.send(json!({ "type": "subscribe.guild", "guildId": guild_id }));
    }

    pub fn search_emojis(&self, query: &str) {
        self.send(json!({ "type": "emoji.search", "query": query }));
    }

    /// Asks for the images of these emojis, batched into one request per frame.
    pub fn query_emojis(&mut self, unicodes: &[String], cx: &mut Context<Self>) {
        if self.socket.is_none() || !self.connected {
            return;
        }
        for unicode in unicodes.iter().map(|unicode| unicode.to_uppercase()) {
            if !self.emoji_urls.contains_key(&unicode)
                && !self.pending_emoji_unicodes.contains(&unicode)
                && !self.missing_emoji_unicodes.contains(&unicode)
            {
                self.queued_emoji_unicodes.push(unicode.clone());
                self.pending_emoji_unicodes.insert(unicode);
            }
        }
        self.schedule_emoji_flush(cx);
    }

    fn schedule_emoji_flush(&mut self, cx: &mut Context<Self>) {
        if self.queued_emoji_unicodes.is_empty() || self.emoji_query_timer.is_some() {
            return;
        }
        self.emoji_query_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(16))
                .await;
            let _ = this.update(cx, |realtime, cx| realtime.flush_emoji_query(cx));
        }));
    }

    fn flush_emoji_query(&mut self, cx: &mut Context<Self>) {
        self.emoji_query_timer = None;
        let count = self.queued_emoji_unicodes.len().min(100);
        let unicodes: Vec<String> = self.queued_emoji_unicodes.drain(..count).collect();
        if self.socket.is_some() && self.connected {
            self.send(json!({ "type": "emoji.query", "unicodes": unicodes }));
        } else {
            for unicode in &unicodes {
                self.pending_emoji_unicodes.remove(unicode);
            }
        }
        self.schedule_emoji_flush(cx);
    }

    pub fn join_voice(&mut self, channel_id: &str) {
        self.voice_channel_id = Some(channel_id.into());
        self.send(json!({ "type": "voice.join", "channelId": channel_id }));
    }

    pub fn send_canvas(&self, message: &CanvasMessage) {
        self.send(serde_json::to_value(message).unwrap_or_default());
    }

    pub fn ring_call(&self, channel_id: &str, ringing: bool, cx: &mut App) {
        if let Some(socket) = &self.socket {
            socket
                .send(json!({ "type": "call.ring", "channelId": channel_id, "ringing": ringing }));
        }
        if ringing {
            let channel_id = channel_id.to_string();
            Dms::global(cx).update(cx, |dms, cx| dms.set_outgoing_call(Some(channel_id), cx));
        }
    }

    pub fn leave_voice(&mut self) {
        self.voice_channel_id = None;
        self.send(json!({ "type": "voice.leave" }));
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{CanvasMessage, reconnect_delay};

    #[test]
    fn backs_off_up_to_thirty_seconds() {
        let delays: Vec<Duration> = (0..7).map(reconnect_delay).collect();
        let seconds: Vec<u64> = delays.iter().map(Duration::as_secs).collect();
        assert_eq!(seconds, [1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn canvas_messages_match_the_wire_format() {
        let message = CanvasMessage::Awareness {
            channel_id: "c".into(),
            update: "u".into(),
            hello: None,
        };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            serde_json::json!({ "type": "canvas.awareness", "channelId": "c", "update": "u" })
        );
    }
}
