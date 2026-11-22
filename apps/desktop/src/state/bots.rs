// Port of apps/frontend/src/lib/bots.svelte.ts: the developer panel's bots, and using bots
// (slash commands and buttons).
use std::{
    collections::HashMap,
    sync::LazyLock,
    time::{Duration, Instant},
};

use gpui_kit::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    api,
    models::PublicUser,
    state::{
        chat::{Chat, UploadFile},
        dms::Dms,
    },
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OptionValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Choice {
    pub name: String,
    pub value: OptionValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandOptionType {
    String,
    Integer,
    Number,
    Boolean,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOption {
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: CommandOptionType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub choices: Option<Vec<Choice>>,
    #[serde(default)]
    pub autocomplete: Option<bool>,
    #[serde(default)]
    pub min_value: Option<f64>,
    #[serde(default)]
    pub max_value: Option<f64>,
    #[serde(default)]
    pub min_length: Option<u32>,
    #[serde(default)]
    pub max_length: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub options: Vec<CommandOption>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperBot {
    #[serde(flatten)]
    pub user: PublicUser,
    pub handle: String,
    pub public: bool,
    pub created_at: String,
    #[serde(default)]
    pub commands: Vec<Command>,
    #[serde(default)]
    pub guild_count: u32,
}

/// a token is only shown right after it was made
#[derive(Debug, Clone, PartialEq)]
pub struct RevealedToken {
    pub bot_id: String,
    pub token: String,
}

/// `developers.bots({ id }).patch`: only the fields that are set are sent.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public: Option<bool>,
}

#[derive(Deserialize)]
struct BotPayload {
    bot: DeveloperBot,
}

#[derive(Deserialize)]
struct BotWithToken {
    bot: DeveloperBot,
    token: String,
}

#[derive(Deserialize)]
struct BotsPayload {
    bots: Vec<DeveloperBot>,
}

#[derive(Deserialize)]
struct TokenPayload {
    token: String,
}

fn failed(error: api::ApiError, fallback: &str) -> String {
    api::error_message(&error.body, fallback)
}

/// The bots you own, for the developer panel.
pub struct Developers {
    pub bots: Vec<DeveloperBot>,
    pub loading: bool,
    pub loaded: bool,
    pub error: Option<String>,
    pub revealed_token: Option<RevealedToken>,
}

struct GlobalDevelopers(Entity<Developers>);
impl Global for GlobalDevelopers {}

impl Developers {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalDevelopers>().0.clone()
    }

    pub fn find(&self, id: Option<&str>) -> Option<&DeveloperBot> {
        self.bots.iter().find(|bot| Some(bot.user.user_id.as_str()) == id)
    }

    fn put(&mut self, bot: DeveloperBot) {
        match self.bots.iter_mut().find(|item| item.user.user_id == bot.user.user_id) {
            Some(existing) => *existing = bot,
            None => self.bots.push(bot),
        }
    }

    pub fn load(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.loading = true;
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::get::<BotsPayload>("/developers/bots").await;
            let _ = this.update(cx, |developers, cx| {
                developers.loading = false;
                match result {
                    Ok(payload) => {
                        developers.bots = payload.bots;
                        developers.loaded = true;
                    }
                    Err(error) => developers.error = Some(failed(error, "Could not load your bots.")),
                }
                cx.notify();
            });
        })
    }

    pub fn create(
        &mut self,
        username: String,
        display_name: String,
        cx: &mut Context<Self>,
    ) -> Task<Result<DeveloperBot, String>> {
        cx.spawn(async move |this, cx| {
            let display_name = (!display_name.is_empty()).then_some(display_name);
            let body = json!({ "username": username, "displayName": display_name });
            let created = api::post::<BotWithToken>("/developers/bots", body)
                .await
                .map_err(|error| failed(error, "Could not create the bot."))?;
            let bot = created.bot.clone();
            let _ = this.update(cx, |developers, cx| {
                developers.revealed_token =
                    Some(RevealedToken { bot_id: bot.user.user_id.clone(), token: created.token });
                developers.put(created.bot);
                cx.notify();
            });
            Ok(bot)
        })
    }

    pub fn update(&mut self, id: String, patch: BotPatch, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        let request = api::patch::<BotPayload>(format!("/developers/bots/{id}"), patch);
        self.save_bot(request, "Could not save the changes.", cx)
    }

    pub fn upload_avatar(
        &mut self,
        id: String,
        avatar: UploadFile,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        let request = api::post_file::<BotPayload>(format!("/developers/bots/{id}/avatar"), "avatar", avatar);
        self.save_bot(request, "Could not upload the avatar.", cx)
    }

    fn save_bot(
        &mut self,
        request: impl Future<Output = api::ApiResult<BotPayload>> + 'static,
        fallback: &'static str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            let payload = request.await.map_err(|error| failed(error, fallback))?;
            let _ = this.update(cx, |developers, cx| {
                developers.put(payload.bot);
                cx.notify();
            });
            Ok(())
        })
    }

    pub fn regenerate_token(&mut self, id: String, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            let payload = api::post::<TokenPayload>(format!("/developers/bots/{id}/token"), json!({}))
                .await
                .map_err(|error| failed(error, "Could not make a new token."))?;
            let _ = this.update(cx, |developers, cx| {
                developers.revealed_token = Some(RevealedToken { bot_id: id, token: payload.token });
                cx.notify();
            });
            Ok(())
        })
    }

    pub fn remove(&mut self, id: String, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            api::delete::<api::Ignored>(format!("/developers/bots/{id}"))
                .await
                .map_err(|error| failed(error, "Could not delete the bot."))?;
            let _ = this.update(cx, |developers, cx| {
                developers.bots.retain(|bot| bot.user.user_id != id);
                if developers.revealed_token.as_ref().is_some_and(|token| token.bot_id == id) {
                    developers.revealed_token = None;
                }
                cx.notify();
            });
            Ok(())
        })
    }
}

/// `@name:homeserver` or `name:homeserver`: the username and homeserver.
pub fn parse_bot_handle(handle: &str) -> Option<(String, String)> {
    static HANDLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@?([a-zA-Z0-9._]{2,32}):(\S+)$").unwrap());
    let captures = HANDLE.captures(handle.trim())?;
    Some((captures[1].to_string(), captures[2].to_string()))
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BotLookup {
    pub user: PublicUser,
    pub public: bool,
}

pub async fn lookup_bot(username: String, homeserver: String) -> Option<BotLookup> {
    api::get_query("/bots/lookup", &[("username", username), ("homeserver", homeserver)]).await.ok()
}

/// `role` is `"MEMBER"` or `"ADMIN"`.
pub async fn add_bot_to_guild(guild_id: &str, username: &str, homeserver: &str, role: &str) -> Result<(), String> {
    let body = json!({ "username": username, "homeserver": homeserver, "role": role });
    api::post::<api::Ignored>(format!("/guilds/{guild_id}/bots"), body)
        .await
        .map(|_| ())
        .map_err(|error| failed(error, "Could not add the bot."))
}

pub async fn remove_bot_from_guild(guild_id: &str, user_id: &str) -> Result<(), String> {
    api::delete::<api::Ignored>(format!("/guilds/{guild_id}/bots/{user_id}"))
        .await
        .map(|_| ())
        .map_err(|error| failed(error, "Could not remove the bot."))
}

// ---- using bots: slash commands and buttons ----

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct GuildBotCommands {
    pub bot: PublicUser,
    pub commands: Vec<Command>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandOptionInput {
    pub name: String,
    pub value: OptionValue,
}

#[derive(Deserialize)]
struct CommandsPayload {
    #[serde(default)]
    bots: Vec<GuildBotCommands>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InteractionResult {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    ephemeral: bool,
    #[serde(default)]
    choices: Vec<Choice>,
}

const COMMAND_CACHE: Duration = Duration::from_secs(30);
/// the bot has 15 minutes to answer; after that nothing will replace its "thinking…"
const THINKING_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct Interactions {
    commands_by_guild: HashMap<String, (Vec<GuildBotCommands>, Instant)>,
    /// `"<messageId>:<customId>"` of the button being pressed
    pub pressing: Option<String>,
}

struct GlobalInteractions(Entity<Interactions>);
impl Global for GlobalInteractions {}

pub fn init(cx: &mut App) {
    let developers =
        cx.new(|_| Developers { bots: vec![], loading: false, loaded: false, error: None, revealed_token: None });
    cx.set_global(GlobalDevelopers(developers));
    let interactions = cx.new(|_| Interactions { commands_by_guild: HashMap::new(), pressing: None });
    cx.set_global(GlobalInteractions(interactions));
}

impl Interactions {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalInteractions>().0.clone()
    }

    pub fn commands_for(&self, guild_id: Option<&str>) -> &[GuildBotCommands] {
        guild_id
            .and_then(|guild_id| self.commands_by_guild.get(guild_id))
            .map(|(bots, _)| bots.as_slice())
            .unwrap_or_default()
    }

    /// `guild_id` is a group DM's id in group DMs
    pub fn load_commands(
        &mut self,
        guild_id: String,
        force: bool,
        cx: &mut Context<Self>,
    ) -> Task<Vec<GuildBotCommands>> {
        if let Some((bots, at)) = self.commands_by_guild.get(&guild_id)
            && !force
            && at.elapsed() < COMMAND_CACHE
        {
            return Task::ready(bots.clone());
        }
        let is_dm = Dms::global(cx).read(cx).get(&guild_id).is_some();
        let path = if is_dm { format!("/dm/{guild_id}/commands") } else { format!("/guilds/{guild_id}/commands") };
        cx.spawn(async move |this, cx| {
            let bots = api::get::<CommandsPayload>(path).await.map(|payload| payload.bots).unwrap_or_default();
            let _ = this.update(cx, |interactions, cx| {
                interactions.commands_by_guild.insert(guild_id, (bots.clone(), Instant::now()));
                cx.notify();
            });
            bots
        })
    }

    pub fn run_command(
        &mut self,
        channel_id: String,
        entry: &GuildBotCommands,
        name: String,
        options: Vec<CommandOptionInput>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        let bot = entry.bot.clone();
        cx.spawn(async move |_, cx| {
            let body = json!({
                "channelId": channel_id,
                "type": "command",
                "botId": bot.user_id,
                "name": name,
                "options": options,
            });
            let result = api::post::<InteractionResult>("/interactions", body)
                .await
                .map_err(|error| failed(error, "The command could not be used."))?;
            if result.kind != "deferred" {
                return Ok(());
            }
            let chat = cx.update(|cx| Chat::global(cx));
            // a deferred answer shows the bot thinking until its reply arrives. A fast bot's reply
            // can come over the socket before this answer does, and then there is nothing to wait for.
            let replied = cx.update(|cx| {
                chat.read(cx).messages_by_channel.get(&channel_id).is_some_and(|messages| {
                    messages.iter().any(|message| message.interaction.as_ref().is_some_and(|i| i.id == result.id))
                })
            });
            if replied {
                return Ok(());
            }
            chat.update(cx, |chat, cx| chat.add_thinking(&channel_id, &result.id, &bot, result.ephemeral, cx));
            let thinking_id = format!("thinking:{}", result.id);
            cx.spawn(async move |cx| {
                cx.background_executor().timer(THINKING_TIMEOUT).await;
                chat.update(cx, |chat, cx| chat.remove_message(&channel_id, &thinking_id, cx));
            })
            .detach();
            Ok(())
        })
    }

    pub fn autocomplete(
        &mut self,
        channel_id: String,
        bot_id: String,
        name: String,
        options: Vec<CommandOptionInput>,
        focused: String,
        cx: &mut Context<Self>,
    ) -> Task<Vec<Choice>> {
        cx.spawn(async move |_, _| {
            let body = json!({
                "channelId": channel_id,
                "type": "autocomplete",
                "botId": bot_id,
                "name": name,
                "options": options,
                "focused": focused,
            });
            api::post::<InteractionResult>("/interactions", body).await.map(|result| result.choices).unwrap_or_default()
        })
    }

    pub fn press_button(
        &mut self,
        channel_id: String,
        message_id: String,
        custom_id: String,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        self.pressing = Some(format!("{message_id}:{custom_id}"));
        cx.notify();
        cx.spawn(async move |this, cx| {
            let body = json!({
                "channelId": channel_id,
                "type": "button",
                "messageId": message_id,
                "customId": custom_id,
            });
            let result = api::post::<api::Ignored>("/interactions", body).await;
            let _ = this.update(cx, |interactions, cx| {
                interactions.pressing = None;
                cx.notify();
            });
            result.map(|_| ()).map_err(|error| failed(error, "Nothing happened. Try again."))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Command, parse_bot_handle};

    #[test]
    fn parses_bot_handles() {
        assert_eq!(parse_bot_handle(" @helper:novarum.me "), Some(("helper".into(), "novarum.me".into())));
        assert_eq!(parse_bot_handle("helper:localhost:5049"), Some(("helper".into(), "localhost:5049".into())));
        assert_eq!(parse_bot_handle("@h:x"), None);
        assert_eq!(parse_bot_handle("helper"), None);
    }

    #[test]
    fn reads_commands_leniently() {
        let command: Command = serde_json::from_str(
            r#"{"name":"roll","description":"Rolls","options":[{"name":"sides","description":"d","type":"integer","choices":[{"name":"six","value":6}]}]}"#,
        )
        .unwrap();
        assert!(!command.options[0].required);
        assert_eq!(command.options[0].choices.as_ref().unwrap()[0].name, "six");
    }
}
