// Wire types shared with Anchor: utils/publicUser.ts, utils/botSchemas.ts, utils/systemMessage.ts,
// and the realtime payloads validated in apps/frontend/src/lib/realtime.svelte.ts.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub user_id: String,
    pub username: String,
    pub homeserver: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_color: Option<String>,
    #[serde(default)]
    pub speaking_ring_color: Option<String>,
    #[serde(default)]
    pub banner_url: Option<String>,
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default)]
    pub is_bot: bool,
}

impl PublicUser {
    pub fn name(&self) -> &str {
        self.display_name.as_deref().filter(|name| !name.is_empty()).unwrap_or(&self.username)
    }

    pub fn handle(&self) -> String {
        format!("@{}:{}", self.username, self.homeserver)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum UserStatus {
    Online,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: f64,
    pub url: String,
    pub preview_url: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmbedAuthor {
    pub name: String,
    pub url: Option<String>,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmbedFooter {
    pub text: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmbedImage {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmbedField {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub inline: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Embed {
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub color: Option<u32>,
    pub timestamp: Option<String>,
    pub author: Option<EmbedAuthor>,
    pub footer: Option<EmbedFooter>,
    pub image: Option<EmbedImage>,
    pub thumbnail: Option<EmbedImage>,
    #[serde(default)]
    pub fields: Vec<EmbedField>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Button {
    pub style: String,
    pub label: String,
    pub custom_id: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionRow {
    pub components: Vec<Button>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageInteraction {
    pub id: String,
    pub name: String,
    pub user: PublicUser,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTarget {
    pub username: String,
    pub homeserver: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SystemMessage {
    #[serde(rename = "member.added")]
    MemberAdded { targets: Vec<SystemTarget> },
    #[serde(rename = "member.removed")]
    MemberRemoved { targets: Vec<SystemTarget> },
    #[serde(rename = "bot.added")]
    BotAdded { targets: Vec<SystemTarget> },
    #[serde(rename = "bot.removed")]
    BotRemoved { targets: Vec<SystemTarget> },
    #[serde(rename = "owner.changed")]
    OwnerChanged { targets: Vec<SystemTarget> },
    #[serde(rename = "group.created")]
    GroupCreated,
    #[serde(rename = "member.left")]
    MemberLeft,
    #[serde(rename = "group.icon")]
    GroupIcon,
    #[serde(rename = "group.renamed")]
    GroupRenamed { name: String },
    #[serde(rename = "call", rename_all = "camelCase")]
    Call { duration_seconds: Option<u64>, missed: bool },
}

/// Lenient: an unknown system message from a newer homeserver is dropped, not fatal.
pub fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// A message as realtime events and `message/list` send it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageData {
    pub id: String,
    pub channel_id: String,
    #[serde(default)]
    pub guild_id: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub edited: bool,
    #[serde(default)]
    pub edited_time: Option<String>,
    #[serde(default)]
    pub pinged_handles: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub created_at: String,
    pub author: PublicUser,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub embeds: Vec<Embed>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub components: Vec<ActionRow>,
    #[serde(default, deserialize_with = "lenient")]
    pub interaction: Option<MessageInteraction>,
    #[serde(default, deserialize_with = "lenient")]
    pub system: Option<SystemMessage>,
    #[serde(default)]
    pub ephemeral: bool,
}

fn lenient_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(lenient(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ChannelType {
    Text,
    Voice,
    Dm,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelData {
    pub id: String,
    pub name: String,
    pub position: i64,
    #[serde(rename = "type")]
    pub kind: ChannelType,
    pub guild_id: String,
    #[serde(default)]
    pub owner_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmLastMessageAuthor {
    pub username: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmLastMessage {
    pub id: String,
    pub author_id: String,
    pub content: Option<String>,
    pub attachment_count: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub system: Option<SystemMessage>,
    #[serde(default)]
    pub author: Option<DmLastMessageAuthor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DmType {
    Dm,
    GroupDm,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmChannel {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: DmType,
    pub participants: Vec<PublicUser>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub owner_id: Option<String>,
    pub last_message_at: Option<String>,
    #[serde(default)]
    pub last_message: Option<DmLastMessage>,
    pub unread: bool,
    pub joined_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmUpdate {
    pub id: String,
    pub name: Option<String>,
    pub icon_url: Option<String>,
    pub owner_id: Option<String>,
    pub participants: Vec<PublicUser>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePresence {
    pub guild_id: Option<String>,
    pub channel_id: String,
    pub user_id: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Emoji {
    pub name: String,
    pub unicode: String,
    pub url: String,
}

// apps/frontend/src/lib/types/chat.ts: what the stores keep and the views render.

#[derive(Debug, Clone, PartialEq)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub initials: String,
    pub down: bool,
    pub can_manage_channels: bool,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChannelCategory {
    pub id: String,
    pub label: String,
    pub channels: Vec<Channel>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub label: Option<String>,
    pub topic: Option<String>,
    pub unread: bool,
    pub last_read_message_id: Option<String>,
    pub mention: u32,
    /// group DMs are DMs too (calls, ringing), with `group` set
    pub kind: ChannelType,
    pub group: bool,
    pub owner_only: bool,
    pub avatar_url: Option<String>,
    pub avatar_color: Option<String>,
}

/// A `PublicUser` whose homeserver is called `server`, plus a guild member's status.
#[derive(Debug, Clone, PartialEq)]
pub struct Author {
    pub user_id: String,
    pub username: String,
    pub server: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_color: Option<String>,
    pub speaking_ring_color: Option<String>,
    pub banner_url: Option<String>,
    pub about: Option<String>,
    pub is_bot: bool,
    pub status: Option<UserStatus>,
}

#[allow(dead_code)]
impl Author {
    pub fn name(&self) -> &str {
        self.display_name.as_deref().filter(|name| !name.is_empty()).unwrap_or(&self.username)
    }

    pub fn handle(&self) -> String {
        format!("@{}:{}", self.username, self.server)
    }
}

impl From<&PublicUser> for Author {
    fn from(user: &PublicUser) -> Self {
        Self {
            user_id: user.user_id.clone(),
            username: user.username.clone(),
            server: user.homeserver.clone(),
            display_name: user.display_name.clone(),
            avatar_url: user.avatar_url.clone(),
            avatar_color: user.avatar_color.clone(),
            speaking_ring_color: user.speaking_ring_color.clone(),
            banner_url: user.banner_url.clone(),
            about: user.about.clone(),
            is_bot: user.is_bot,
            status: None,
        }
    }
}

/// "<someone> used /command", on a bot's answer to a slash command
#[derive(Debug, Clone, PartialEq)]
pub struct Interaction {
    pub id: String,
    pub name: String,
    pub user: Author,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: String,
    pub author: Author,
    pub content: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub edited: bool,
    pub edited_time: Option<String>,
    pub reply_to: Option<String>,
    pub pinged_handles: Vec<String>,
    pub attachments: Vec<Attachment>,
    pub embeds: Vec<Embed>,
    pub components: Vec<ActionRow>,
    pub interaction: Option<Interaction>,
    /// written by the homeserver: "Ana added Leo", a call...
    pub system: Option<SystemMessage>,
    /// only on this screen: a bot's answer only you can see, or a bot still thinking about it
    pub ephemeral: bool,
    pub thinking: bool,
}
