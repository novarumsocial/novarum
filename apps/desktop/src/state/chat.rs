// Port of apps/frontend/src/lib/chat-state.svelte.ts. Route-derived getters read the router and
// take `cx`; methods that talk to Anchor return a `Task` the caller awaits or detaches.
use std::{
    collections::HashMap,
    io::Cursor,
    path::Path,
    time::{Duration, Instant},
};

use base64::Engine;
use chrono::{DateTime, SecondsFormat, Utc};
use futures::{StreamExt, channel::mpsc};
use gpui_kit::*;
use serde::Deserialize;
use serde_json::json;

use crate::{
    api,
    models::*,
    realtime_events::{GuildCreated, MemberUser, VoiceStateChanged},
    runtime,
    state::{
        dms::{DmEntry, Dms, dm_display, dm_path},
        router::{self, ChatRoute, Router, encode},
        session::Session,
    },
    util::utils::mentions_everyone,
};

const TYPING_REQUEST_INTERVAL: Duration = Duration::from_secs(5);
const TYPING_EXPIRY: Duration = Duration::from_secs(6);
const MESSAGES_PAGE_SIZE: usize = 50;
pub const MAX_MESSAGE_LENGTH: usize = 4000;

fn initials_for(name: &str) -> String {
    let initials: String =
        name.split_whitespace().take(2).filter_map(|part| part.chars().next()).flat_map(char::to_uppercase).collect();
    if initials.is_empty() { name.chars().take(1).flat_map(char::to_uppercase).collect() } else { initials }
}

/// A file picked for upload: a message attachment, a group icon or an avatar.
#[derive(Debug, Clone)]
pub struct UploadFile {
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl UploadFile {
    pub fn from_path(path: &Path) -> std::io::Result<Self> {
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        Ok(Self { content_type: content_type_for(&name).into(), bytes: std::fs::read(path)?, name })
    }
}

/// What a browser would put in `File.type` for these names.
pub fn content_type_for(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, extension)| extension.to_lowercase()).unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "json" => "application/json",
        "txt" | "md" | "log" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Re-encodes jpeg/png/webp so EXIF (location, camera...) never leaves the computer.
pub fn strip_image_metadata(file: UploadFile) -> Result<UploadFile, String> {
    use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};

    let format = match file.content_type.as_str() {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/webp" => ImageFormat::WebP,
        _ => return Ok(file),
    };
    let failed = |_| format!("Could not process {}", file.name);
    let mut decoder = ImageReader::with_format(Cursor::new(&file.bytes), format).into_decoder().map_err(failed)?;
    // browsers apply the EXIF rotation when drawing, so the picture keeps its orientation
    let orientation = decoder.orientation().ok();
    let mut image = DynamicImage::from_decoder(decoder).map_err(failed)?;
    if let Some(orientation) = orientation {
        image.apply_orientation(orientation);
    }

    let mut bytes = Cursor::new(Vec::new());
    let written = if format == ImageFormat::Jpeg {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 92);
        DynamicImage::ImageRgb8(image.to_rgb8()).write_with_encoder(encoder)
    } else {
        image.write_to(&mut bytes, format)
    };
    written.map_err(failed)?;
    Ok(UploadFile { bytes: bytes.into_inner(), ..file })
}

fn message_from_input(message: MessageData, thinking: bool) -> Message {
    Message {
        timestamp: DateTime::parse_from_rfc3339(&message.created_at)
            .map(|date| date.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
        author: Author::from(&message.author),
        content: message.content.unwrap_or_default(),
        id: message.id,
        edited: message.edited,
        edited_time: message.edited_time,
        attachments: message.attachments,
        reply_to: message.reply_to,
        pinged_handles: message.pinged_handles,
        embeds: message.embeds,
        components: message.components,
        interaction: message.interaction.map(|interaction| Interaction {
            id: interaction.id,
            name: interaction.name,
            user: Author::from(&interaction.user),
        }),
        system: message.system,
        ephemeral: message.ephemeral,
        thinking,
    }
}

fn member_from_input(member: &MemberUser) -> Author {
    Author { status: Some(member.status), ..Author::from(&member.user) }
}

/// builds the synthetic Channel the UI expects out of a DM's participants.
fn dm_channel(entry: &DmEntry) -> Channel {
    let display = dm_display(entry);
    Channel {
        id: entry.id.clone(),
        name: display.name,
        label: None,
        topic: None,
        unread: entry.unread,
        last_read_message_id: None,
        mention: 0,
        kind: ChannelType::Dm,
        group: entry.kind == DmType::GroupDm,
        owner_only: false,
        avatar_url: display.avatar_url,
        avatar_color: display.avatar_color,
    }
}

pub fn guild_path(server_id: Option<&str>, channel_id: Option<&str>, message_id: Option<&str>) -> String {
    let Some(server_id) = server_id.filter(|id| !id.is_empty()) else { return "/guilds".into() };
    let parts: Vec<String> = [Some(server_id), channel_id, message_id]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .map(encode)
        .collect();
    format!("/guilds/{}", parts.join("/"))
}

/// Older messages go first; ones already on screen aren't repeated. `None` when nothing is new.
pub fn merge_older(existing: &[Message], loaded: Vec<Message>) -> Option<Vec<Message>> {
    let older: Vec<Message> =
        loaded.into_iter().filter(|message| !existing.iter().any(|item| item.id == message.id)).collect();
    (!older.is_empty()).then(|| older.into_iter().chain(existing.iter().cloned()).collect())
}

/// A snapshot replaces what's known about its guilds and DMs and keeps every other channel.
pub fn merge_voice_states(
    current: &HashMap<String, Vec<VoicePresence>>,
    guild_ids: &[String],
    states: &[VoicePresence],
    dm_ids: &[String],
) -> HashMap<String, Vec<VoicePresence>> {
    let mut next: HashMap<String, Vec<VoicePresence>> = current
        .iter()
        .filter(|(channel_id, channel_states)| {
            !dm_ids.contains(channel_id)
                && channel_states
                    .iter()
                    .any(|state| state.guild_id.as_ref().is_none_or(|guild| !guild_ids.contains(guild)))
        })
        .map(|(channel_id, states)| (channel_id.clone(), states.clone()))
        .collect();
    for state in states {
        next.entry(state.channel_id.clone()).or_default().retain(|item| item.user_id != state.user_id);
    }
    for state in states {
        next.entry(state.channel_id.clone()).or_default().push(state.clone());
    }
    next
}

fn message_nonce() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
}

/// `guilds.list`'s read state for a channel.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRead {
    pub unread: bool,
    pub last_read_message_id: Option<String>,
    pub mention: u32,
}

#[derive(Debug, Clone, Default)]
pub struct GuildInput {
    pub id: String,
    pub name: String,
    pub down: bool,
    pub owner_id: Option<String>,
    pub can_manage_channels: Option<bool>,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
}

impl From<&GuildCreated> for GuildInput {
    fn from(guild: &GuildCreated) -> Self {
        Self {
            id: guild.id.clone(),
            name: guild.name.clone(),
            owner_id: Some(guild.owner_id.clone()),
            avatar_url: guild.avatar_url.clone(),
            description: guild.description.clone(),
            ..Default::default()
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuildListChannel {
    #[serde(flatten)]
    channel: ChannelData,
    #[serde(flatten)]
    read: ChannelRead,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuildListEntry {
    id: String,
    name: String,
    #[serde(default)]
    down: bool,
    can_manage_channels: bool,
    avatar_url: Option<String>,
    description: Option<String>,
    channels: Vec<GuildListChannel>,
}

#[derive(Deserialize)]
struct GuildList {
    guilds: Vec<GuildListEntry>,
}

#[derive(Deserialize)]
struct MessageList {
    messages: Vec<MessageData>,
}

#[derive(Deserialize)]
struct MessagePayload {
    message: MessageData,
}

#[derive(Deserialize)]
struct Users {
    users: Vec<MemberUser>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Presign {
    attachment_id: String,
    upload_url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildInvite {
    pub id: String,
    pub guild_id: String,
    pub code: String,
    #[serde(default)]
    pub creator_id: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

#[derive(Deserialize)]
struct InvitePayload {
    invite: GuildInvite,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TypingEntry {
    pub user_id: String,
    pub name: String,
    pub expires_at: Instant,
}

/// The presigned PUT, reporting how much of the body went out.
async fn put_with_progress(
    url: String,
    headers: HashMap<String, String>,
    file: UploadFile,
    progress: mpsc::UnboundedSender<f32>,
) -> Result<(), String> {
    runtime::io(async move {
        let total = file.bytes.len().max(1);
        let chunks: Vec<Vec<u8>> = file.bytes.chunks(64 * 1024).map(<[u8]>::to_vec).collect();
        let mut sent = 0;
        let body = futures::stream::iter(chunks).map(move |chunk| {
            sent += chunk.len();
            let _ = progress.unbounded_send(sent as f32 / total as f32);
            Ok::<_, std::io::Error>(chunk)
        });
        let mut request = api::http()
            .put(&url)
            .header("content-type", &file.content_type)
            .header("content-length", file.bytes.len())
            .body(reqwest::Body::wrap_stream(body));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|_| "Upload failed".to_string())?;
        if response.status().is_success() { Ok(()) } else { Err("Upload failed".into()) }
    })
    .await
}

/// A federated guild's homeserver is down: back to the guild list instead of an error.
fn send_to_guilds_if_federated_server_down(error: &api::ApiError, cx: &mut App) -> bool {
    if error.status != 502 {
        return false;
    }
    router::goto("/guilds", cx);
    true
}

pub struct Chat {
    pub servers: Vec<Server>,
    pub channels_by_server: HashMap<String, Vec<ChannelCategory>>,
    pub messages_by_channel: HashMap<String, Vec<Message>>,
    pub messages_loading_by_channel: HashMap<String, bool>,
    pub members: Vec<Author>,
    pub mention_request: Option<Author>,
    pub voice_states: HashMap<String, Vec<VoicePresence>>,
    pub typing_by_channel: HashMap<String, Vec<TypingEntry>>,
    pub loading_older_by_channel: HashMap<String, bool>,
    pub editing_message: bool,
    pub editing_message_id: Option<String>,
    /// attachment index -> 0..1, while a send uploads its files
    pub upload_progress: HashMap<usize, f32>,
    loaded_channel: Option<String>,
    last_typing_by_channel: HashMap<String, Instant>,
    next_cursor_by_channel: HashMap<String, usize>,
    has_more_by_channel: HashMap<String, bool>,
    /// set once `load_initial_data` ran; route changes before that don't load channels
    initialized: bool,
    _router: Subscription,
}

struct GlobalChat(Entity<Chat>);
impl Global for GlobalChat {}

pub fn init(cx: &mut App) {
    let router = Router::global(cx);
    let chat = cx.new(|cx| Chat {
        servers: vec![],
        channels_by_server: HashMap::new(),
        messages_by_channel: HashMap::new(),
        messages_loading_by_channel: HashMap::new(),
        members: vec![],
        mention_request: None,
        voice_states: HashMap::new(),
        typing_by_channel: HashMap::new(),
        loading_older_by_channel: HashMap::new(),
        editing_message: false,
        editing_message_id: None,
        upload_progress: HashMap::new(),
        loaded_channel: None,
        last_typing_by_channel: HashMap::new(),
        next_cursor_by_channel: HashMap::new(),
        has_more_by_channel: HashMap::new(),
        initialized: false,
        // the web app's `$effect(() => chat.syncActiveChannel())`
        _router: cx.observe(&router, |chat: &mut Chat, _, cx| chat.sync_active_channel(cx)),
    });
    cx.set_global(GlobalChat(chat));
}

impl Chat {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalChat>().0.clone()
    }

    pub fn route(&self, cx: &App) -> ChatRoute {
        Router::route(cx)
    }

    pub fn active_server(&self, cx: &App) -> Option<String> {
        match Router::route(cx) {
            ChatRoute::Guild { server_id, .. } => server_id,
            _ => None,
        }
    }

    pub fn active_channel(&self, cx: &App) -> Option<String> {
        match Router::route(cx) {
            ChatRoute::Guild { channel_id, .. } | ChatRoute::Dms { channel_id, .. } => channel_id,
            _ => None,
        }
    }

    pub fn active_message(&self, cx: &App) -> Option<String> {
        match Router::route(cx) {
            ChatRoute::Guild { message_id, .. } | ChatRoute::Dms { message_id, .. } => message_id,
            _ => None,
        }
    }

    /// where slash commands come from: the guild, or the group DM (1:1 DMs have no bots)
    pub fn command_scope(&self, cx: &App) -> Option<String> {
        self.active_server(cx).or_else(|| match Router::route(cx) {
            ChatRoute::Dms { channel_id: Some(channel_id), .. } => Dms::global(cx)
                .read(cx)
                .get(&channel_id)
                .is_some_and(|dm| dm.kind == DmType::GroupDm)
                .then_some(channel_id),
            _ => None,
        })
    }

    /// Who is in the current channel: the guild's members, or everyone in the group DM.
    pub fn channel_members(&self, cx: &App) -> Vec<Author> {
        let ChatRoute::Dms { channel_id, .. } = Router::route(cx) else { return self.members.clone() };
        let dms = Dms::global(cx);
        let Some(group) = channel_id.and_then(|id| dms.read(cx).get(&id).cloned()) else { return vec![] };
        if group.kind != DmType::GroupDm {
            return vec![];
        }
        Session::user(cx)
            .map(|me| Author::from(&me.as_public()))
            .into_iter()
            .chain(group.participants.iter().map(Author::from))
            .collect()
    }

    pub fn current_server(&self, cx: &App) -> Option<&Server> {
        let active = self.active_server(cx)?;
        self.servers.iter().find(|server| server.id == active)
    }

    pub fn current_categories(&self, cx: &App) -> &[ChannelCategory] {
        self.active_server(cx)
            .and_then(|server| self.channels_by_server.get(&server))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    pub fn current_channel(&self, cx: &App) -> Option<Channel> {
        let active = self.active_channel(cx)?;
        if matches!(Router::route(cx), ChatRoute::Dms { .. }) {
            return Dms::global(cx).read(cx).get(&active).map(dm_channel);
        }
        self.current_categories(cx)
            .iter()
            .flat_map(|category| &category.channels)
            .find(|channel| channel.id == active)
            .cloned()
    }

    /// owner-only channels only take messages from the guild owner, the one who can manage channels
    pub fn can_send_in_current_channel(&self, cx: &App) -> bool {
        !self.current_channel(cx).is_some_and(|channel| channel.owner_only)
            || self.current_server(cx).is_some_and(|server| server.can_manage_channels)
    }

    pub fn current_messages(&self, cx: &App) -> &[Message] {
        self.current_channel(cx)
            .and_then(|channel| self.messages_by_channel.get(&channel.id))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    pub fn current_messages_loading(&self, cx: &App) -> bool {
        self.current_channel(cx).is_some_and(|channel| {
            self.messages_loading_by_channel.get(&channel.id).copied().unwrap_or(false)
                || self.loaded_channel.as_deref() != Some(channel.id.as_str())
        })
    }

    pub fn current_typing(&self, cx: &App) -> &[TypingEntry] {
        self.current_channel(cx)
            .and_then(|channel| self.typing_by_channel.get(&channel.id))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    pub fn select_server(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        let channel = self.first_channel_for_server(id).map(|channel| channel.id.clone());
        router::goto(guild_path(id, channel.as_deref(), None), cx);
    }

    pub fn select_channel(&mut self, id: &str, cx: &mut Context<Self>) {
        if Dms::global(cx).read(cx).get(id).is_some() {
            return router::goto(dm_path(id, None), cx);
        }
        let server = self
            .channels_by_server
            .iter()
            .find(|(_, categories)| categories.iter().any(|category| category.channels.iter().any(|c| c.id == id)))
            .map(|(server, _)| server.clone())
            .or_else(|| self.active_server(cx));
        if let Some(server) = server {
            router::goto(guild_path(Some(&server), Some(id), None), cx);
        }
    }

    pub fn message_path(&self, id: &str, cx: &App) -> String {
        let channel = self.active_channel(cx);
        if let (ChatRoute::Dms { .. }, Some(channel)) = (Router::route(cx), &channel) {
            return dm_path(channel, Some(id));
        }
        guild_path(self.active_server(cx).as_deref(), channel.as_deref(), Some(id))
    }

    pub fn existing_channel_path(&self, cx: &App) -> String {
        let channel = self.active_channel(cx);
        if let (ChatRoute::Dms { .. }, Some(channel)) = (Router::route(cx), &channel) {
            return dm_path(channel, None);
        }
        guild_path(self.active_server(cx).as_deref(), channel.as_deref(), None)
    }

    pub fn sync_active_channel(&mut self, cx: &mut Context<Self>) {
        if !self.initialized {
            return;
        }
        let channel = self.current_channel(cx).map(|channel| channel.id);
        if channel != self.loaded_channel {
            self.load_current_channel(cx).detach();
        }
    }

    pub fn add_guild(&mut self, guild: GuildInput, cx: &mut Context<Self>) {
        let me = Session::user(cx).map(|user| user.id);
        let can_manage_channels =
            guild.can_manage_channels.unwrap_or_else(|| guild.owner_id.is_some() && guild.owner_id == me);
        match self.servers.iter_mut().find(|server| server.id == guild.id) {
            Some(server) => {
                server.initials = initials_for(&guild.name);
                server.name = guild.name;
                server.down = guild.down;
                server.can_manage_channels = can_manage_channels;
                server.avatar_url = guild.avatar_url;
                server.description = guild.description;
            }
            None => self.servers.push(Server {
                initials: initials_for(&guild.name),
                id: guild.id,
                name: guild.name,
                down: guild.down,
                can_manage_channels,
                avatar_url: guild.avatar_url,
                description: guild.description,
                color: None,
                owner_id: guild.owner_id,
            }),
        }
        cx.notify();
    }

    pub fn set_guild_categories(&mut self, guild_id: &str, categories: Vec<ChannelCategory>, cx: &mut Context<Self>) {
        self.channels_by_server.insert(guild_id.into(), categories);
        cx.notify();
    }

    pub fn add_channel(&mut self, channel: &ChannelData, read: Option<ChannelRead>, cx: &mut Context<Self>) -> Channel {
        let existing = self
            .channels_by_server
            .get(&channel.guild_id)
            .into_iter()
            .flatten()
            .flat_map(|category| &category.channels)
            .find(|item| item.id == channel.id)
            .cloned();
        if let Some(existing) = existing {
            self.set_channel_unread(
                &channel.id,
                read.as_ref().map_or(existing.unread, |read| read.unread),
                read.as_ref().map(|read| read.last_read_message_id.clone()),
                read.as_ref().map(|read| read.mention),
                cx,
            );
            self.set_channel_owner_only(&channel.guild_id, &channel.id, channel.owner_only, cx);
            return existing;
        }

        let next = Channel {
            id: channel.id.clone(),
            name: channel.name.clone(),
            label: None,
            topic: None,
            unread: read.as_ref().is_some_and(|read| read.unread),
            last_read_message_id: read.as_ref().and_then(|read| read.last_read_message_id.clone()),
            mention: read.as_ref().map_or(0, |read| read.mention),
            kind: if channel.kind == ChannelType::Voice { ChannelType::Voice } else { ChannelType::Text },
            group: false,
            owner_only: channel.owner_only,
            avatar_url: None,
            avatar_color: None,
        };
        let categories = self.channels_by_server.entry(channel.guild_id.clone()).or_default();
        match categories.iter_mut().find(|category| category.id == "text") {
            Some(text) => {
                let position = (channel.position.max(0) as usize).min(text.channels.len());
                text.channels.insert(position, next.clone());
            }
            None => categories.push(ChannelCategory {
                id: "text".into(),
                label: "Text Channels".into(),
                channels: vec![next.clone()],
            }),
        }
        cx.notify();
        next
    }

    pub fn set_messages(&mut self, channel_id: &str, messages: Vec<MessageData>, cx: &mut Context<Self>) {
        let messages = messages.into_iter().map(|message| message_from_input(message, false)).collect();
        self.messages_by_channel.insert(channel_id.into(), messages);
        cx.notify();
    }

    pub fn add_message(&mut self, message: MessageData, cx: &mut Context<Self>) {
        let pinged = self.pings_me(&message, cx);
        let (channel_id, created_at) = (message.channel_id.clone(), message.created_at.clone());
        let interaction = message.interaction.as_ref().map(|interaction| interaction.id.clone());
        self.push_message(&channel_id, message_from_input(message, false), interaction, pinged, created_at, cx);
    }

    /// A bot's "thinking…" until its answer to interaction `interaction_id` arrives.
    pub fn add_thinking(
        &mut self,
        channel_id: &str,
        interaction_id: &str,
        bot: &PublicUser,
        ephemeral: bool,
        cx: &mut Context<Self>,
    ) {
        let message = Message {
            id: format!("thinking:{interaction_id}"),
            author: Author::from(bot),
            content: String::new(),
            timestamp: Utc::now(),
            edited: false,
            edited_time: None,
            reply_to: None,
            pinged_handles: vec![],
            attachments: vec![],
            embeds: vec![],
            components: vec![],
            interaction: None,
            system: None,
            ephemeral,
            thinking: true,
        };
        self.push_message(channel_id, message, None, false, String::new(), cx);
    }

    fn pings_me(&self, message: &MessageData, cx: &App) -> bool {
        let handle = Session::user(cx).map(|user| user.handle.to_lowercase());
        (message.guild_id.is_some() && mentions_everyone(message.content.as_deref()))
            || handle.is_some_and(|handle| message.pinged_handles.iter().any(|pinged| pinged.to_lowercase() == handle))
    }

    fn push_message(
        &mut self,
        channel_id: &str,
        message: Message,
        interaction_id: Option<String>,
        pinged: bool,
        created_at: String,
        cx: &mut Context<Self>,
    ) {
        // a bot's answer takes the place of its "thinking…"
        let thinking_id = interaction_id.map(|id| format!("thinking:{id}"));
        let messages = self.messages_by_channel.entry(channel_id.into()).or_default();
        messages.retain(|item| Some(&item.id) != thinking_id.as_ref());
        cx.notify();
        if messages.iter().any(|item| item.id == message.id) {
            return;
        }
        let (id, local_only) = (message.id.clone(), message.ephemeral || message.thinking);
        messages.push(message);
        // these only live on this screen, the server has never heard of their ids
        if local_only {
            return;
        }

        if self.active_channel(cx).as_deref() != Some(channel_id) {
            self.set_channel_unread(channel_id, true, None, None, cx);
            if pinged {
                self.increment_channel_mention(channel_id, cx);
            }
        } else {
            self.mark_read(channel_id.into(), id, created_at, cx).detach();
        }
    }

    /// a bot's answer only this person sees; the same id again replaces it (an edit)
    pub fn add_ephemeral(&mut self, message: MessageData, cx: &mut Context<Self>) {
        let messages = self.messages_by_channel.get_mut(&message.channel_id);
        match messages.and_then(|messages| messages.iter_mut().find(|item| item.id == message.id)) {
            Some(existing) => {
                *existing = message_from_input(message, false);
                cx.notify();
            }
            None => self.add_message(message, cx),
        }
    }

    pub fn remove_member(&mut self, user_id: &str, cx: &mut Context<Self>) {
        self.members.retain(|member| member.user_id != user_id);
        cx.notify();
    }

    pub fn remove_message(&mut self, channel_id: &str, message_id: &str, cx: &mut Context<Self>) {
        if let Some(messages) = self.messages_by_channel.get_mut(channel_id) {
            messages.retain(|message| message.id != message_id);
            cx.notify();
        }
    }

    pub fn update_message(&mut self, channel_id: &str, message: MessageData, cx: &mut Context<Self>) {
        let messages = self.messages_by_channel.get_mut(channel_id);
        if let Some(existing) = messages.and_then(|messages| messages.iter_mut().find(|item| item.id == message.id)) {
            *existing = message_from_input(message, false);
            cx.notify();
        }
    }

    pub fn update_member_status(&mut self, user_id: &str, status: UserStatus, cx: &mut Context<Self>) {
        for member in self.members.iter_mut().filter(|member| member.user_id == user_id) {
            member.status = Some(status);
        }
        cx.notify();
    }

    /// A profile change (`user.updated`) reaches the member list and every message they wrote.
    pub fn update_user_profile(&mut self, profile: &PublicUser, cx: &mut Context<Self>) {
        let apply = |author: &mut Author| {
            if author.user_id == profile.user_id {
                author.display_name = profile.display_name.clone();
                author.avatar_url = profile.avatar_url.clone();
                author.avatar_color = profile.avatar_color.clone();
                author.speaking_ring_color = profile.speaking_ring_color.clone();
                author.banner_url = profile.banner_url.clone();
                author.about = profile.about.clone();
            }
        };
        self.members.iter_mut().for_each(apply);
        self.messages_by_channel.values_mut().flatten().for_each(|message| apply(&mut message.author));
        cx.notify();
    }

    pub fn add_or_update_member(&mut self, guild_id: &str, member: &MemberUser, cx: &mut Context<Self>) {
        if self.active_server(cx).as_deref() != Some(guild_id) {
            return;
        }
        let next = member_from_input(member);
        match self.members.iter_mut().find(|item| item.user_id == next.user_id) {
            Some(existing) => *existing = next,
            None => self.members.push(next),
        }
        cx.notify();
    }

    pub fn set_voice_states(
        &mut self,
        guild_ids: &[String],
        states: &[VoicePresence],
        dm_ids: &[String],
        cx: &mut Context<Self>,
    ) {
        self.voice_states = merge_voice_states(&self.voice_states, guild_ids, states, dm_ids);
        cx.notify();
    }

    pub fn update_voice_state(&mut self, state: &VoiceStateChanged, cx: &mut Context<Self>) {
        let user_id = &state.presence.user_id;
        self.voice_states.retain(|_, states| {
            let before = states.len();
            states.retain(|item| item.user_id != *user_id);
            states.len() == before || !states.is_empty()
        });
        if state.connected {
            self.voice_states.entry(state.presence.channel_id.clone()).or_default().push(state.presence.clone());
        }
        cx.notify();
    }

    pub fn send_message(
        &mut self,
        channel_id: String,
        content: Option<String>,
        files: Vec<UploadFile>,
        reply_to: Option<String>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            let nonce = message_nonce();
            let mut attachment_ids = vec![];
            for (index, file) in files.into_iter().enumerate() {
                let file = cx.background_spawn(async move { strip_image_metadata(file) }).await?;
                let uploaded = Self::upload_attachment(&this, &channel_id, file, index, cx).await;
                let _ = this.update(cx, |chat, cx| {
                    chat.upload_progress.remove(&index);
                    cx.notify();
                });
                attachment_ids.push(uploaded?);
            }

            let mut body = json!({
                "channelId": channel_id,
                "content": content,
                "nonce": nonce,
                "attachmentIds": attachment_ids,
            });
            if let Some(reply_to) = reply_to {
                body["replyTo"] = reply_to.into();
            }
            match api::post::<api::Ignored>("/message/send", body).await {
                Ok(_) => Ok(()),
                Err(error) if cx.update(|cx| send_to_guilds_if_federated_server_down(&error, cx)) => Ok(()),
                Err(_) => Err("Failed to send message".into()),
            }
        })
    }

    async fn upload_attachment(
        this: &WeakEntity<Self>,
        channel_id: &str,
        file: UploadFile,
        index: usize,
        cx: &mut AsyncApp,
    ) -> Result<String, String> {
        let body = json!({
            "channelId": channel_id,
            "filename": file.name,
            "contentType": if file.content_type.is_empty() { "application/octet-stream" } else { &file.content_type },
            "size": file.bytes.len(),
        });
        let presign = api::post::<Presign>("/upload/presign", body)
            .await
            .map_err(|_| format!("Could not prepare {} for upload", file.name))?;

        let (sender, mut receiver) = mpsc::unbounded::<f32>();
        let progress = cx.spawn({
            let this = this.clone();
            async move |cx| {
                while let Some(progress) = receiver.next().await {
                    let _ = this.update(cx, |chat, cx| {
                        chat.upload_progress.insert(index, progress);
                        cx.notify();
                    });
                }
            }
        });
        let uploaded = put_with_progress(presign.upload_url, presign.headers, file, sender).await;
        progress.await;
        uploaded.map(|_| presign.attachment_id)
    }

    pub fn delete_message(
        &mut self,
        channel_id: String,
        message_id: String,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            let body = json!({ "channelId": channel_id, "messageId": message_id });
            match api::post::<api::Ignored>("/message/delete", body).await {
                Ok(_) => {
                    let _ = this.update(cx, |chat, cx| chat.remove_message(&channel_id, &message_id, cx));
                    Ok(())
                }
                Err(error) if cx.update(|cx| send_to_guilds_if_federated_server_down(&error, cx)) => Ok(()),
                Err(_) => Err("Failed to delete message".into()),
            }
        })
    }

    pub fn edit_message(
        &mut self,
        channel_id: String,
        message_id: String,
        content: Option<String>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            let body = json!({ "channelId": channel_id, "messageId": message_id, "content": content });
            match api::post::<MessagePayload>("/message/edit", body).await {
                Ok(payload) => {
                    let _ = this.update(cx, |chat, cx| chat.update_message(&channel_id, payload.message, cx));
                    Ok(())
                }
                Err(error) if cx.update(|cx| send_to_guilds_if_federated_server_down(&error, cx)) => Ok(()),
                Err(_) => Err("Failed to edit message".into()),
            }
        })
    }

    fn list_messages(channel_id: &str, cursor: usize) -> impl Future<Output = api::ApiResult<MessageList>> + use<> {
        let query = [
            ("channelId", channel_id.to_string()),
            ("cursor", cursor.to_string()),
            ("amount", MESSAGES_PAGE_SIZE.to_string()),
        ];
        async move { api::get_query::<MessageList>("/message/list", &query).await }
    }

    /// The newest page of `channel_id`. Resolves to its newest message.
    pub fn load_messages(&mut self, channel_id: String, cx: &mut Context<Self>) -> Task<Option<MessageData>> {
        self.messages_loading_by_channel.insert(channel_id.clone(), true);
        self.next_cursor_by_channel.insert(channel_id.clone(), 0);
        cx.notify();
        let request = Self::list_messages(&channel_id, 0);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |chat, cx| {
                chat.messages_loading_by_channel.insert(channel_id.clone(), false);
                cx.notify();
                match result {
                    Ok(MessageList { messages }) => {
                        chat.has_more_by_channel.insert(channel_id.clone(), messages.len() == MESSAGES_PAGE_SIZE);
                        let last = messages.last().cloned();
                        chat.set_messages(&channel_id, messages, cx);
                        last
                    }
                    Err(error) => {
                        send_to_guilds_if_federated_server_down(&error, cx);
                        None
                    }
                }
            })
            .ok()
            .flatten()
        })
    }

    pub fn load_older_messages(&mut self, channel_id: String, cx: &mut Context<Self>) -> Task<()> {
        let busy = |map: &HashMap<String, bool>| map.get(&channel_id).copied().unwrap_or(false);
        if busy(&self.messages_loading_by_channel)
            || busy(&self.loading_older_by_channel)
            || !self.has_more_messages(&channel_id)
        {
            return Task::ready(());
        }
        self.loading_older_by_channel.insert(channel_id.clone(), true);
        cx.notify();
        let cursor = self.next_cursor_by_channel.get(&channel_id).copied().unwrap_or(0);
        let request = Self::list_messages(&channel_id, cursor);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |chat, cx| {
                chat.loading_older_by_channel.insert(channel_id.clone(), false);
                cx.notify();
                let messages = match result {
                    Ok(MessageList { messages }) => messages,
                    Err(error) => {
                        send_to_guilds_if_federated_server_down(&error, cx);
                        return;
                    }
                };
                let count = messages.len();
                let loaded = messages.into_iter().map(|message| message_from_input(message, false)).collect();
                let existing = chat.messages_by_channel.get(&channel_id).map(Vec::as_slice).unwrap_or_default();
                if let Some(merged) = merge_older(existing, loaded) {
                    chat.messages_by_channel.insert(channel_id.clone(), merged);
                }
                chat.next_cursor_by_channel.insert(channel_id.clone(), cursor + count);
                chat.has_more_by_channel.insert(channel_id, count == MESSAGES_PAGE_SIZE);
            });
        })
    }

    pub fn has_more_messages(&self, channel_id: &str) -> bool {
        self.has_more_by_channel.get(channel_id).copied().unwrap_or(false)
    }

    /// Tells the channel we're typing, at most every few seconds.
    pub fn on_typing(&mut self, cx: &mut Context<Self>) -> Task<()> {
        let Some(channel_id) = self.active_channel(cx) else { return Task::ready(()) };
        let now = Instant::now();
        if self.last_typing_by_channel.get(&channel_id).is_some_and(|last| now - *last < TYPING_REQUEST_INTERVAL) {
            return Task::ready(());
        }
        self.last_typing_by_channel.insert(channel_id.clone(), now);
        cx.spawn(async move |_, _| {
            let _ = api::post::<api::Ignored>(format!("/channel/{channel_id}/typing"), json!({})).await;
        })
    }

    pub fn set_typing(
        &mut self,
        channel_id: &str,
        user_id: &str,
        username: &str,
        homeserver: &str,
        name: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(me) = Session::user(cx) else { return };
        if user_id == me.id || (username == me.username && homeserver.eq_ignore_ascii_case(&me.homeserver)) {
            return;
        }

        let expires_at = Instant::now() + TYPING_EXPIRY;
        let typing = self.typing_by_channel.entry(channel_id.into()).or_default();
        typing.retain(|item| item.user_id != user_id);
        typing.push(TypingEntry { user_id: user_id.into(), name: name.into(), expires_at });
        cx.notify();

        let (channel_id, user_id) = (channel_id.to_string(), user_id.to_string());
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TYPING_EXPIRY).await;
            let _ = this.update(cx, |chat, cx| {
                if let Some(typing) = chat.typing_by_channel.get_mut(&channel_id) {
                    typing.retain(|item| item.user_id != user_id || item.expires_at != expires_at);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn clear_typing(&mut self, channel_id: &str, user_id: &str, cx: &mut Context<Self>) {
        if let Some(typing) = self.typing_by_channel.get_mut(channel_id) {
            typing.retain(|item| item.user_id != user_id);
            cx.notify();
        }
    }

    pub fn load_members(&mut self, channel_id: String, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let result = api::get::<Users>(format!("/channel/{channel_id}/users")).await;
            let _ = this.update(cx, |chat, cx| {
                chat.members =
                    result.map(|users| users.users.iter().map(member_from_input).collect()).unwrap_or_default();
                cx.notify();
            });
        })
    }

    /// `last_read`: `None` keeps it, `Some(id)` replaces it. `mention`: `None` keeps it.
    fn set_channel_unread(
        &mut self,
        channel_id: &str,
        unread: bool,
        last_read: Option<Option<String>>,
        mention: Option<u32>,
        cx: &mut Context<Self>,
    ) {
        let channels = self.channels_by_server.values_mut().flatten().flat_map(|category| &mut category.channels);
        for channel in channels.filter(|channel| channel.id == channel_id) {
            channel.unread = unread;
            if let Some(mention) = mention {
                channel.mention = mention;
            }
            if let Some(last_read) = &last_read {
                channel.last_read_message_id = last_read.clone();
            }
        }
        cx.notify();
    }

    fn increment_channel_mention(&mut self, channel_id: &str, cx: &mut Context<Self>) {
        let mention = self
            .channels_by_server
            .values()
            .flatten()
            .flat_map(|category| &category.channels)
            .find(|channel| channel.id == channel_id)
            .map(|channel| channel.mention);
        if let Some(mention) = mention {
            self.set_channel_unread(channel_id, true, None, Some(mention + 1), cx);
        }
    }

    fn mark_read(
        &mut self,
        channel_id: String,
        message_id: String,
        created_at: String,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let created_at = DateTime::parse_from_rfc3339(&created_at)
            .map(|date| date.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or(created_at);
        cx.spawn(async move |this, cx| {
            let body = json!({ "messageId": message_id, "createdAt": created_at });
            if api::post::<api::Ignored>(format!("/channel/{channel_id}/read"), body).await.is_err() {
                return;
            }
            let _ = this.update(cx, |chat, cx| {
                let latest = chat.messages_by_channel.get(&channel_id).and_then(|messages| messages.last());
                if latest.is_none_or(|latest| latest.id != message_id) {
                    return;
                }
                let dms = Dms::global(cx);
                if dms.read(cx).get(&channel_id).is_some() {
                    dms.update(cx, |dms, cx| dms.mark_read(&channel_id, cx));
                } else {
                    chat.set_channel_unread(&channel_id, false, Some(Some(message_id)), Some(0), cx);
                }
            });
        })
    }

    pub fn create_server(&mut self, name: String, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |_, _| {
            let _ = api::post::<api::Ignored>("/guilds/create", json!({ "name": name })).await;
        })
    }

    pub fn update_guild_avatar(&mut self, guild_id: &str, avatar_url: String, cx: &mut Context<Self>) {
        if let Some(server) = self.servers.iter_mut().find(|server| server.id == guild_id) {
            server.avatar_url = Some(avatar_url);
            cx.notify();
        }
    }

    pub fn create_local_channel(&mut self, category_id: &str, channel: Channel, cx: &mut Context<Self>) {
        let Some(server) = self.active_server(cx) else { return };
        let categories = self.channels_by_server.entry(server).or_default();
        let Some(category) = categories.iter_mut().find(|category| category.id == category_id) else { return };
        let id = channel.id.clone();
        category.channels.push(channel);
        cx.notify();
        self.select_channel(&id, cx);
    }

    pub fn create_channel(
        &mut self,
        guild_id: String,
        name: String,
        kind: ChannelType,
        cx: &mut Context<Self>,
    ) -> Task<Option<Channel>> {
        cx.spawn(async move |this, cx| {
            let body = json!({ "name": name, "type": kind, "guildId": guild_id });
            let created = api::post::<ChannelData>("/channel/create", body).await.ok()?;
            this.update(cx, |chat, cx| {
                let channel = chat.add_channel(&created, None, cx);
                chat.select_channel(&channel.id, cx);
                channel
            })
            .ok()
        })
    }

    pub fn create_guild_invite(&mut self, guild_id: String, cx: &mut Context<Self>) -> Task<Option<GuildInvite>> {
        cx.spawn(async move |_, _| {
            let payload = api::post::<InvitePayload>(format!("/guilds/{guild_id}/invites"), json!({})).await;
            payload.ok().map(|payload| payload.invite)
        })
    }

    pub fn get_guild_invite(&mut self, guild_id: String, cx: &mut Context<Self>) -> Task<Option<GuildInvite>> {
        cx.spawn(async move |_, _| {
            let payload = api::get::<InvitePayload>(format!("/guilds/{guild_id}/invites")).await;
            payload.ok().map(|payload| payload.invite)
        })
    }

    pub fn load_initial_data(&mut self, cx: &mut Context<Self>) -> Task<()> {
        let guilds = self.load_guilds(cx);
        let dms = Dms::global(cx).update(cx, |dms, cx| dms.load(cx));
        cx.spawn(async move |this, cx| {
            futures::join!(guilds, dms);
            let load = this.update(cx, |chat, cx| {
                chat.select_initial_channel(cx);
                chat.initialized = true;
                chat.load_current_channel(cx)
            });
            if let Ok(load) = load {
                load.await;
            }
        })
    }

    /// After the realtime socket reconnects: whatever happened while it was down.
    pub fn recover_realtime_state(&mut self, cx: &mut Context<Self>) -> Task<()> {
        let guilds = self.load_guilds(cx);
        let dms = Dms::global(cx).update(cx, |dms, cx| dms.load(cx));
        cx.spawn(async move |this, cx| {
            futures::join!(guilds, dms);
            if let Ok(load) = this.update(cx, |chat, cx| chat.load_current_channel(cx)) {
                load.await;
            }
        })
    }

    fn load_guilds(&mut self, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let Ok(list) = api::get::<GuildList>("/guilds/list").await else { return };
            let _ = this.update(cx, |chat, cx| {
                for guild in list.guilds {
                    let input = GuildInput {
                        id: guild.id,
                        name: guild.name,
                        down: guild.down,
                        owner_id: None,
                        can_manage_channels: Some(guild.can_manage_channels),
                        avatar_url: guild.avatar_url,
                        description: guild.description,
                    };
                    chat.add_guild(input, cx);
                    for GuildListChannel { channel, read } in guild.channels {
                        chat.add_channel(&channel, Some(read), cx);
                    }
                }
            });
        })
    }

    /// The `syncActiveChannel` load: messages, members and the read marker of the open channel.
    pub fn load_current_channel(&mut self, cx: &mut Context<Self>) -> Task<()> {
        let channel_id = self.current_channel(cx).map(|channel| channel.id);
        self.loaded_channel = channel_id.clone();
        let Some(channel_id) = channel_id else {
            self.members.clear();
            cx.notify();
            return Task::ready(());
        };

        let is_dm = matches!(Router::route(cx), ChatRoute::Dms { .. });
        let messages = self.load_messages(channel_id.clone(), cx);
        let members = (!is_dm).then(|| self.load_members(channel_id.clone(), cx));
        cx.spawn(async move |this, cx| {
            let (last, _) = futures::join!(messages, async {
                if let Some(members) = members {
                    members.await;
                }
            });
            let _ = this.update(cx, |chat, cx| match last {
                Some(last) => chat.mark_read(channel_id, last.id, last.created_at, cx).detach(),
                None if is_dm => Dms::global(cx).update(cx, |dms, cx| dms.mark_read(&channel_id, cx)),
                None => chat.set_channel_unread(&channel_id, false, None, Some(0), cx),
            });
        })
    }

    fn first_channel_for_server(&self, server_id: Option<&str>) -> Option<&Channel> {
        self.channels_by_server
            .get(server_id?)?
            .first()?
            .channels
            .iter()
            .find(|channel| channel.kind == ChannelType::Text)
    }

    fn select_initial_channel(&mut self, cx: &mut Context<Self>) {
        let Some(active) = self.active_server(cx) else { return };
        if self.current_server(cx).is_some_and(|server| server.down) {
            return router::goto("/guilds", cx);
        }
        let server_id = self.current_server(cx).map(|server| server.id.clone());
        let channel_id = self
            .current_channel(cx)
            .map(|channel| channel.id)
            .or_else(|| self.first_channel_for_server(server_id.as_deref()).map(|channel| channel.id.clone()));
        if server_id.as_deref() != Some(active.as_str()) || channel_id != self.active_channel(cx) {
            router::goto(guild_path(server_id.as_deref(), channel_id.as_deref(), None), cx);
        }
    }

    pub fn reorder_guilds(&mut self, guild_ids: Vec<String>, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |_, _| {
            let _ = api::patch::<api::Ignored>("/guilds/order", json!({ "guildIds": guild_ids })).await;
        })
    }

    pub fn reorder_channels(&mut self, guild_id: &str, channel_ids: &[String], cx: &mut Context<Self>) {
        let position = |id: &str| channel_ids.iter().position(|item| item == id).unwrap_or(usize::MAX);
        for category in self.channels_by_server.get_mut(guild_id).into_iter().flatten() {
            category.channels.sort_by_key(|channel| position(&channel.id));
        }
        cx.notify();
    }

    pub fn set_channel_owner_only(
        &mut self,
        guild_id: &str,
        channel_id: &str,
        owner_only: bool,
        cx: &mut Context<Self>,
    ) {
        let categories = self.channels_by_server.entry(guild_id.into()).or_default();
        for channel in categories.iter_mut().flat_map(|category| &mut category.channels) {
            if channel.id == channel_id {
                channel.owner_only = owner_only;
            }
        }
        cx.notify();
    }

    pub fn set_owner_only(
        &mut self,
        guild_id: String,
        channel_id: String,
        owner_only: bool,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let body = json!({ "ownerOnly": owner_only });
            let Ok(channel) = api::patch::<ChannelData>(format!("/channel/{channel_id}"), body).await else { return };
            let _ =
                this.update(cx, |chat, cx| chat.set_channel_owner_only(&guild_id, &channel_id, channel.owner_only, cx));
        })
    }

    pub fn save_channel_order(
        &mut self,
        guild_id: String,
        channel_ids: Vec<String>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |_, _| {
            let body = json!({ "guildId": guild_id, "channelIds": channel_ids });
            let _ = api::patch::<api::Ignored>("/channel/order", body).await;
        })
    }

    pub fn request_mention(&mut self, member: Author, cx: &mut Context<Self>) {
        self.mention_request = Some(member);
        cx.notify();
    }

    /// `editingMessageId = id` (and `editingMessage` along with it)
    pub fn set_editing_message(&mut self, message_id: Option<String>, cx: &mut Context<Self>) {
        self.editing_message = message_id.is_some();
        self.editing_message_id = message_id;
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::Utc;

    use super::{content_type_for, guild_path, initials_for, merge_older, merge_voice_states, strip_image_metadata};
    use crate::{
        models::{Author, Message, VoicePresence},
        state::chat::UploadFile,
    };

    fn message(id: &str) -> Message {
        Message {
            id: id.into(),
            author: Author {
                user_id: "u".into(),
                username: "u".into(),
                server: "x".into(),
                display_name: None,
                avatar_url: None,
                avatar_color: None,
                speaking_ring_color: None,
                banner_url: None,
                about: None,
                is_bot: false,
                status: None,
            },
            content: String::new(),
            timestamp: Utc::now(),
            edited: false,
            edited_time: None,
            reply_to: None,
            pinged_handles: vec![],
            attachments: vec![],
            embeds: vec![],
            components: vec![],
            interaction: None,
            system: None,
            ephemeral: false,
            thinking: false,
        }
    }

    fn ids(messages: &[Message]) -> Vec<&str> {
        messages.iter().map(|message| message.id.as_str()).collect()
    }

    #[test]
    fn older_pages_go_first_without_repeats() {
        let existing = vec![message("3"), message("4")];
        let merged = merge_older(&existing, vec![message("1"), message("2"), message("3")]).unwrap();
        assert_eq!(ids(&merged), ["1", "2", "3", "4"]);
        assert!(merge_older(&existing, vec![message("4")]).is_none());
    }

    #[test]
    fn builds_guild_paths() {
        assert_eq!(guild_path(None, Some("c"), None), "/guilds");
        assert_eq!(guild_path(Some("g"), None, None), "/guilds/g");
        assert_eq!(guild_path(Some("fed:guild:a:1"), Some("c"), Some("m")), "/guilds/fed%3Aguild%3Aa%3A1/c/m");
    }

    #[test]
    fn makes_initials() {
        assert_eq!(initials_for("rust lang club"), "RL");
        assert_eq!(initials_for("novarum"), "N");
        assert_eq!(initials_for("   "), " ");
    }

    fn presence(guild: Option<&str>, channel: &str, user: &str) -> VoicePresence {
        VoicePresence {
            guild_id: guild.map(str::to_string),
            channel_id: channel.into(),
            user_id: user.into(),
            name: None,
        }
    }

    #[test]
    fn voice_snapshots_replace_their_guilds_only() {
        let current = HashMap::from([
            ("a".to_string(), vec![presence(Some("g1"), "a", "u1")]),
            ("b".to_string(), vec![presence(Some("g2"), "b", "u2")]),
            ("d".to_string(), vec![presence(None, "d", "u3")]),
        ]);
        let next = merge_voice_states(&current, &["g1".into()], &[presence(Some("g1"), "c", "u1")], &["d".into()]);
        assert!(!next.contains_key("a") && !next.contains_key("d"));
        assert_eq!(next["b"].len(), 1);
        assert_eq!(next["c"][0].user_id, "u1");
    }

    #[test]
    fn strips_image_metadata_by_re_encoding() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let file = UploadFile {
            name: "a.png".into(),
            content_type: content_type_for("a.png").into(),
            bytes: png.into_inner(),
        };
        let stripped = strip_image_metadata(file).unwrap();
        assert!(image::load_from_memory(&stripped.bytes).is_ok());
        let text = UploadFile { name: "a.txt".into(), content_type: "text/plain".into(), bytes: b"hi".to_vec() };
        assert_eq!(strip_image_metadata(text).unwrap().bytes, b"hi");
    }
}
