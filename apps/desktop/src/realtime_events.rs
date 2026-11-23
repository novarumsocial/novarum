// The `realtimeEventSchema` union of apps/frontend/src/lib/realtime.svelte.ts.
use serde::Deserialize;

use crate::models::*;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildCreated {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
    pub channels: Vec<ChannelData>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDeleted {
    pub id: String,
    pub channel_id: String,
    pub guild_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberLeft {
    pub guild_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusChanged {
    pub user_id: String,
    pub status: UserStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemberUser {
    #[serde(flatten)]
    pub user: PublicUser,
    pub status: UserStatus,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberJoined {
    pub guild_id: String,
    pub user: MemberUser,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSnapshot {
    pub guild_ids: Vec<String>,
    #[serde(default)]
    pub dm_ids: Vec<String>,
    pub states: Vec<VoicePresence>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VoiceStateChanged {
    #[serde(flatten)]
    pub presence: VoicePresence,
    pub connected: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRinging {
    pub channel_id: String,
    pub user: PublicUser,
    pub ringing: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Typing {
    pub channel_id: String,
    pub user_id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub homeserver: String,
    pub time: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSync {
    pub channel_id: String,
    pub state: String,
    pub writable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasUpdate {
    pub channel_id: String,
    pub update: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasAwareness {
    pub channel_id: String,
    pub update: String,
    #[serde(default)]
    pub hello: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelsReordered {
    pub guild_id: String,
    pub channel_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserUpdated {
    pub user: PublicUser,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Removed {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmojiSearchResults {
    pub query: String,
    pub emojis: Vec<Emoji>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmojiQueryResults {
    pub unicodes: Vec<String>,
    pub emojis: Vec<Emoji>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum RealtimeEvent {
    #[serde(rename = "guild.created")]
    GuildCreated(GuildCreated),
    #[serde(rename = "channel.created")]
    ChannelCreated(ChannelData),
    #[serde(rename = "channel.updated")]
    ChannelUpdated(ChannelData),
    #[serde(rename = "message.created")]
    MessageCreated(MessageData),
    #[serde(rename = "message.updated")]
    MessageUpdated(MessageData),
    #[serde(rename = "message.deleted")]
    MessageDeleted(MessageDeleted),
    #[serde(rename = "message.ephemeral")]
    MessageEphemeral(MessageData),
    #[serde(rename = "dm.created")]
    DmCreated(DmChannel),
    #[serde(rename = "dm.updated")]
    DmUpdated(DmUpdate),
    #[serde(rename = "dm.removed")]
    DmRemoved(Removed),
    #[serde(rename = "member.left")]
    MemberLeft(MemberLeft),
    #[serde(rename = "user.status.changed")]
    UserStatusChanged(StatusChanged),
    #[serde(rename = "member.joined")]
    MemberJoined(MemberJoined),
    #[serde(rename = "voice.states.snapshot")]
    VoiceStatesSnapshot(VoiceSnapshot),
    #[serde(rename = "voice.state.changed")]
    VoiceStateChanged(VoiceStateChanged),
    #[serde(rename = "call.ringing")]
    CallRinging(CallRinging),
    #[serde(rename = "channel.typing")]
    ChannelTyping(Typing),
    #[serde(rename = "canvas.sync")]
    CanvasSync(CanvasSync),
    #[serde(rename = "canvas.update")]
    CanvasUpdate(CanvasUpdate),
    #[serde(rename = "canvas.awareness")]
    CanvasAwareness(CanvasAwareness),
    #[serde(rename = "guild.channels.reordered")]
    ChannelsReordered(ChannelsReordered),
    #[serde(rename = "friends.changed")]
    FriendsChanged(serde_json::Value),
    #[serde(rename = "user.updated")]
    UserUpdated(UserUpdated),
    #[serde(rename = "emoji.search.results")]
    EmojiSearchResults(EmojiSearchResults),
    #[serde(rename = "emoji.query.results")]
    EmojiQueryResults(EmojiQueryResults),
}

/// The server sometimes wraps the event once more in `{ data: ... }`, as the web parser allows.
pub fn parse(text: &str) -> Option<RealtimeEvent> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    serde_json::from_value(value.clone()).ok().or_else(|| {
        let inner = value.get("data")?;
        match inner {
            serde_json::Value::String(text) => serde_json::from_str(text).ok(),
            other => serde_json::from_value(other.clone()).ok(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_message_created_event() {
        let event = parse(
            r#"{"type":"message.created","data":{"id":"m1","channelId":"c1","guildId":null,"content":"hi","nonce":"n","attachments":[],"createdAt":"2026-01-01T00:00:00.000Z","author":{"userId":"u1","username":"ana","homeserver":"novarum.me","displayName":null,"avatarUrl":null,"avatarColor":null,"speakingRingColor":null,"isBot":false},"system":{"type":"unknown.kind"}}}"#,
        );
        let Some(RealtimeEvent::MessageCreated(message)) = event else {
            panic!("{event:?}")
        };
        assert_eq!(message.content.as_deref(), Some("hi"));
        assert!(message.system.is_none());
    }

    #[test]
    fn parses_a_wrapped_event() {
        let event = parse(r#"{"data":{"type":"friends.changed","data":{}}}"#);
        assert!(matches!(event, Some(RealtimeEvent::FriendsChanged(_))));
    }
}
