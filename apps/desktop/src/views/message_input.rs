// Port of apps/frontend/src/lib/components/message-input.svelte: the composer. Enter sends,
// Shift+Enter breaks the line; files come from the picker, drag and drop or pasted images; `@`,
// `:` and `/` open member, emoji and slash command pickers.
use std::{path::PathBuf, sync::{Arc, LazyLock}};

use gpui_kit::component::input::{Enter, Escape, IndentInline, InputEvent, MoveDown, MoveUp, Textarea, TextareaState};
use regex::Regex;

use crate::prelude::*;

use crate::{
    api,
    models::{Author, Emoji, Message},
    state::{
        bots::{Command, GuildBotCommands, Interactions},
        chat::{Chat, MAX_MESSAGE_LENGTH, UploadFile, content_type_for},
        realtime::Realtime,
        router::ChatRoute,
        session::is_self,
    },
    ui::avatar::avatar,
    util::utils::format_bytes,
    views::command_form::{CommandForm, CommandFormEvent},
};

const MAX_FILES: usize = 5;

/// `(?:^|\s)@([a-zA-Z0-9._:-]*)$` on the text before the cursor: the member being typed.
pub fn mention_query(before: &str) -> Option<String> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|\s)@([a-zA-Z0-9._:-]*)$").unwrap());
    PATTERN.captures(before).map(|captures| captures[1].to_string())
}

/// `(?:^|\s):([\w+-]*)$`: the emoji being typed.
pub fn emoji_query(before: &str) -> Option<String> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|\s):([\w+-]*)$").unwrap());
    PATTERN.captures(before).map(|captures| captures[1].to_string())
}

/// "/name" with nothing after it: the person is picking a slash command.
pub fn command_query(content: &str) -> Option<String> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/[\w-]*$").unwrap());
    PATTERN.is_match(content).then(|| content[1..].to_lowercase())
}

pub fn member_handle(member: &Author) -> String {
    format!("{}:{}", member.username, member.server)
}

#[derive(Debug, Clone, PartialEq)]
pub struct MentionResult {
    pub id: String,
    pub name: String,
    pub handle: String,
}

/// "Everyone" (in guilds) and the members matching `query`, at most 8.
pub fn mention_results(members: &[Author], query: &str, in_guild: bool) -> Vec<MentionResult> {
    let query = query.to_lowercase();
    let everyone = (in_guild && "everyone".starts_with(&query))
        .then(|| MentionResult { id: "everyone".into(), name: "Everyone".into(), handle: "everyone".into() });
    let members = members
        .iter()
        .filter(|member| {
            [member.username.clone(), member.display_name.clone().unwrap_or_default(), member_handle(member)]
                .iter()
                .any(|value| value.to_lowercase().contains(&query))
        })
        .map(|member| MentionResult { id: member.user_id.clone(), name: member.name().to_string(), handle: member_handle(member) });
    everyone.into_iter().chain(members).take(8).collect()
}

/// `1F44B-1F3FD` → 👋🏽
pub fn emoji_glyph(unicode: &str) -> String {
    unicode.split('-').filter_map(|part| u32::from_str_radix(part, 16).ok()).filter_map(char::from_u32).collect()
}

/// Puts `insert` and a space over `content[start..cursor]`: the new text and where the cursor goes.
pub fn complete(content: &str, start: usize, cursor: usize, insert: &str) -> (String, usize) {
    let text = format!("{}{insert} {}", &content[..start], &content[cursor.min(content.len())..]);
    (text, start + insert.len() + 1)
}

/// A mention added from elsewhere (a member's "Mention"): appended after what's there.
pub fn append_mention(content: &str, handle: &str) -> String {
    let mention = format!("@{handle} ");
    if content.is_empty() { mention } else { format!("{} {mention}", content.trim_end()) }
}

fn image_format(content_type: &str) -> Option<ImageFormat> {
    Some(match content_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        "image/svg+xml" => ImageFormat::Svg,
        _ => return None,
    })
}

struct Picked {
    file: UploadFile,
    preview: Option<Arc<Image>>,
}

#[derive(Clone)]
struct CommandResult {
    entry: GuildBotCommands,
    command: Command,
}

pub enum MessageInputEvent {
    Send { content: Option<String>, files: Vec<UploadFile> },
    CancelReply,
}

impl EventEmitter<MessageInputEvent> for MessageInput {}

pub struct MessageInput {
    input: Entity<TextareaState>,
    files: Vec<Picked>,
    error: Option<String>,
    /// where the `:` or `@` being completed starts, and the query after it
    emoji: Option<(usize, String)>,
    mention: Option<(usize, String)>,
    selected_emoji: usize,
    selected_mention: usize,
    selected_command: usize,
    active_command: Option<(Entity<CommandForm>, Subscription)>,
    dragging: bool,
    placeholder: String,
    pub reply: Option<Message>,
    _subscriptions: Vec<Subscription>,
}

impl MessageInput {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 9).submit_on_enter(true).placeholder("Send a message"));
        let subscriptions = vec![
            cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => this.send(window, cx),
                InputEvent::Change => this.on_change(window, cx),
                _ => {}
            }),
            cx.observe_in(&Chat::global(cx), window, |this, chat, window, cx| {
                let Some(member) = chat.read(cx).mention_request.clone() else { return };
                chat.update(cx, |chat, _| chat.mention_request = None);
                let next = append_mention(&this.value(cx), &member_handle(&member));
                this.set_text(next.clone(), next.len(), window, cx);
            }),
            cx.observe(&Realtime::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Interactions::global(cx), |_, _, cx| cx.notify()),
        ];
        Self {
            input,
            files: vec![],
            error: None,
            emoji: None,
            mention: None,
            selected_emoji: 0,
            selected_mention: 0,
            selected_command: 0,
            active_command: None,
            dragging: false,
            placeholder: String::new(),
            reply: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn set_placeholder(&mut self, placeholder: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.placeholder != placeholder {
            self.placeholder = placeholder.clone();
            self.input.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    /// Focuses the composer of `this`, for its owner.
    pub fn focus_entity(this: &Entity<Self>, window: &mut Window, cx: &mut App) {
        let input = this.read(cx).input.clone();
        input.update(cx, |input, cx| input.focus(window, cx));
    }

    /// Whether stray typing in the chat should land here (not while a command form is open).
    pub fn takes_typing(&self) -> bool {
        self.active_command.is_none()
    }

    pub fn is_focused(&self, window: &Window, cx: &App) -> bool {
        self.input.read(cx).focus_handle(cx).contains_focused(window, cx)
    }

    fn value(&self, cx: &App) -> String {
        self.input.read(cx).value().to_string()
    }

    fn set_text(&mut self, text: String, cursor: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value(text, window, cx);
            input.set_selected_range(cursor..cursor, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    fn on_change(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.value(cx);
        if value.chars().count() > MAX_MESSAGE_LENGTH {
            let clipped: String = value.chars().take(MAX_MESSAGE_LENGTH).collect();
            self.input.update(cx, |input, cx| input.set_value(clipped, window, cx));
        }
        if !value.trim().is_empty() {
            Chat::global(cx).update(cx, |chat, cx| chat.on_typing(cx)).detach();
        }
        self.update_search(cx);
        if let (Some(scope), Some(_)) = (Chat::global(cx).read(cx).command_scope(cx), command_query(&value)) {
            Interactions::global(cx).update(cx, |interactions, cx| interactions.load_commands(scope, false, cx)).detach();
        }
        self.selected_command = 0;
        cx.notify();
    }

    fn update_search(&mut self, cx: &mut Context<Self>) {
        let value = self.value(cx);
        let cursor = self.input.read(cx).cursor().min(value.len());
        let before = &value[..cursor];
        if let Some(query) = mention_query(before) {
            self.mention = Some((cursor - query.len() - 1, query));
            self.selected_mention = 0;
            self.emoji = None;
            return;
        }
        self.mention = None;
        match emoji_query(before) {
            Some(query) => {
                Realtime::global(cx).read(cx).search_emojis(&query);
                self.emoji = Some((cursor - query.len() - 1, query));
                self.selected_emoji = 0;
            }
            None => self.emoji = None,
        }
    }

    fn emoji_results(&self, cx: &App) -> Vec<Emoji> {
        let Some((_, query)) = &self.emoji else { return vec![] };
        let realtime = Realtime::global(cx).read(cx);
        if realtime.emoji_query.trim() == query.trim() { realtime.emoji_results.clone() } else { vec![] }
    }

    fn mention_results(&self, cx: &App) -> Vec<MentionResult> {
        let Some((_, query)) = &self.mention else { return vec![] };
        let chat = Chat::global(cx).read(cx);
        mention_results(&chat.members, query, matches!(chat.route(cx), ChatRoute::Guild { .. }))
    }

    fn command_results(&self, cx: &App) -> Vec<CommandResult> {
        let chat = Chat::global(cx).read(cx);
        let (Some(scope), Some(query)) = (chat.command_scope(cx), command_query(&self.value(cx))) else { return vec![] };
        Interactions::global(cx)
            .read(cx)
            .commands_for(Some(&scope))
            .iter()
            .flat_map(|entry| entry.commands.iter().map(move |command| CommandResult { entry: entry.clone(), command: command.clone() }))
            .filter(|result| result.command.name.starts_with(&query))
            .take(10)
            .collect()
    }

    fn insert_mention(&mut self, handle: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some((start, _)) = self.mention.take() else { return };
        let value = self.value(cx);
        let cursor = self.input.read(cx).cursor();
        let (text, cursor) = complete(&value, start, cursor, &format!("@{handle}"));
        self.set_text(text, cursor, window, cx);
    }

    fn insert_emoji(&mut self, emoji: &Emoji, window: &mut Window, cx: &mut Context<Self>) {
        let Some((start, _)) = self.emoji.take() else { return };
        let value = self.value(cx);
        let cursor = self.input.read(cx).cursor();
        let (text, cursor) = complete(&value, start, cursor, &emoji_glyph(&emoji.unicode));
        self.set_text(text, cursor, window, cx);
    }

    fn pick_command(&mut self, result: CommandResult, window: &mut Window, cx: &mut Context<Self>) {
        self.set_text(String::new(), 0, window, cx);
        self.selected_command = 0;
        let Some(channel_id) = Chat::global(cx).read(cx).active_channel(cx) else { return };
        // nothing to fill in: run it right away, like sending a message
        if result.command.options.is_empty() {
            self.error = None;
            let run = Interactions::global(cx).update(cx, |interactions, cx| {
                interactions.run_command(channel_id, &result.entry, result.command.name.clone(), vec![], cx)
            });
            cx.spawn(async move |this, cx| {
                let result = run.await;
                let _ = this.update(cx, |this, cx| {
                    this.error = result.err();
                    cx.notify();
                });
            })
            .detach();
            return;
        }
        let form = cx.new(|cx| CommandForm::new(result.entry, result.command, channel_id, window, cx));
        let subscription = cx.subscribe_in(&form, window, |this, _, event: &CommandFormEvent, window, cx| match event {
            CommandFormEvent::Close => {
                this.active_command = None;
                this.focus(window, cx);
                cx.notify();
            }
        });
        self.active_command = Some((form, subscription));
        cx.notify();
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.value(cx);
        let content = Some(value.trim().to_string()).filter(|content| !content.is_empty());
        if content.is_none() && self.files.is_empty() {
            return;
        }
        let files = self.files.drain(..).map(|picked| picked.file).collect();
        self.error = None;
        self.emoji = None;
        self.mention = None;
        cx.emit(MessageInputEvent::Send { content, files });
        self.input.update(cx, |input, cx| input.set_value("", window, cx));
        cx.notify();
    }

    pub fn add_files(&mut self, next: Vec<UploadFile>, cx: &mut Context<Self>) {
        self.error = None;
        let key = |file: &UploadFile| format!("{}:{}", file.name, file.bytes.len());
        let existing: Vec<String> = self.files.iter().map(|picked| key(&picked.file)).collect();
        let unique: Vec<UploadFile> = next.into_iter().filter(|file| !existing.contains(&key(file))).collect();
        let max_mb = api::anchor().max_file_size;
        if let Some(oversized) = unique.iter().find(|file| file.bytes.len() as f64 > max_mb * 1024.0 * 1024.0) {
            self.error = Some(format!("{} exceeds the {max_mb} MB limit.", oversized.name));
        } else if self.files.len() + unique.len() > MAX_FILES {
            self.error = Some(format!("You can attach up to {MAX_FILES} files at once."));
        } else {
            self.files.extend(unique.into_iter().map(|file| {
                let preview = image_format(&file.content_type).map(|format| Arc::new(Image::from_bytes(format, file.bytes.clone())));
                Picked { file, preview }
            }));
        }
        cx.notify();
    }

    fn add_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let read = cx.background_spawn(async move { paths.iter().map(|path| UploadFile::from_path(path)).collect::<Vec<_>>() });
            let files = read.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(failed) = files.iter().find_map(|file| file.as_ref().err()) {
                    this.error = Some(failed.to_string());
                    return cx.notify();
                }
                this.add_files(files.into_iter().flatten().collect(), cx);
            });
        })
        .detach();
    }

    fn pick_files(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else { return };
            let _ = this.update(cx, |this, cx| this.add_paths(paths, cx));
        })
        .detach();
    }

    /// Pasted images (and copied files) become attachments; text pastes as usual.
    fn paste(&mut self, item: &ClipboardItem, cx: &mut Context<Self>) -> bool {
        let mut files = vec![];
        let mut paths = vec![];
        for entry in item.entries() {
            match entry {
                ClipboardEntry::Image(image) => {
                    let content_type = image.format.mime_type();
                    let extension = content_type.rsplit('/').next().unwrap_or("png").replace("svg+xml", "svg");
                    files.push(UploadFile {
                        name: format!("image.{extension}"),
                        content_type: content_type_for(&format!("image.{extension}")).to_string(),
                        bytes: image.bytes.clone(),
                    });
                }
                ClipboardEntry::ExternalPaths(external) => paths.extend(external.paths().iter().cloned()),
                ClipboardEntry::String(_) => {}
            }
        }
        if files.is_empty() && paths.is_empty() {
            return false;
        }
        if !files.is_empty() {
            self.add_files(files, cx);
        }
        if !paths.is_empty() {
            self.add_paths(paths, cx);
        }
        true
    }

    /// Up/Down/Enter/Tab/Escape while a picker is open, and Up on an empty composer.
    fn navigate(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let step = |selected: &mut usize, count: usize| {
            *selected = (*selected + if key == "down" { 1 } else { count - 1 }) % count;
        };
        let commands = self.command_results(cx);
        if !commands.is_empty() {
            match key {
                "up" | "down" => step(&mut self.selected_command, commands.len()),
                "enter" | "tab" => {
                    let result = commands.get(self.selected_command).unwrap_or(&commands[0]).clone();
                    self.pick_command(result, window, cx);
                }
                _ => return false,
            }
            cx.notify();
            return true;
        }
        let mentions = self.mention_results(cx);
        if self.mention.is_some() && !mentions.is_empty() && key != "escape" {
            match key {
                "up" | "down" => step(&mut self.selected_mention, mentions.len()),
                _ => {
                    let handle = mentions[self.selected_mention.min(mentions.len() - 1)].handle.clone();
                    self.insert_mention(&handle, window, cx);
                }
            }
            cx.notify();
            return true;
        }
        let emoji = self.emoji_results(cx);
        if self.emoji.is_some() && !emoji.is_empty() && key != "escape" {
            match key {
                "up" | "down" => step(&mut self.selected_emoji, emoji.len()),
                _ => {
                    let picked = emoji[self.selected_emoji.min(emoji.len() - 1)].clone();
                    self.insert_emoji(&picked, window, cx);
                }
            }
            cx.notify();
            return true;
        }
        if key == "escape" && (self.emoji.is_some() || self.mention.is_some()) {
            self.emoji = None;
            self.mention = None;
            cx.notify();
            return true;
        }
        if key == "up" && self.value(cx).is_empty() && self.files.is_empty() {
            let chat = Chat::global(cx);
            let last_own = chat
                .read(cx)
                .current_messages(cx)
                .iter()
                .rev()
                .find(|message| is_self(&message.author.username, &message.author.server, cx))
                .map(|message| message.id.clone());
            if let Some(id) = last_own {
                chat.update(cx, |chat, cx| chat.set_editing_message(Some(id), cx));
                return true;
            }
        }
        false
    }

    fn key<A: Action>(key: &'static str, cx: &mut Context<Self>) -> impl Fn(&A, &mut Window, &mut App) + 'static {
        cx.listener(move |this: &mut Self, _: &A, window, cx| {
            if this.navigate(key, window, cx) {
                cx.stop_propagation();
            }
        })
    }

    fn popup(&self, id: &'static str, width: f32, max_height: f32, narrow: bool, cx: &App) -> Stateful<Div> {
        let t = theme::tokens(cx);
        div()
            .id(id)
            .absolute()
            .bottom_full()
            .left(if narrow { px(8.0) } else { px(16.0) })
            .when(narrow, |popup| popup.right_2())
            .when(!narrow, |popup| popup.w(px(width)))
            .mb_1p5()
            .max_h(px(max_height))
            .overflow_y_scroll()
            .border_1()
            .border_color(t.border)
            .bg(t.popover)
            .p_1()
            .shadow_2xl()
    }

    fn option_row(id: ElementId, selected: bool, cx: &App) -> Stateful<Div> {
        let t = theme::tokens(cx);
        div()
            .id(id)
            .flex()
            .w_full()
            .min_w_0()
            .items_center()
            .text_xs()
            .cursor_pointer()
            .when(selected, |row| row.bg(t.primary).text_color(t.primary_foreground))
            .when(!selected, |row| row.text_color(t.foreground).hover(|s| s.bg(t.muted)))
    }

    fn render_popups(&mut self, narrow: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = theme::tokens(cx);
        let commands = self.command_results(cx);
        if !commands.is_empty() {
            let mut popup = self.popup("command-results", 512.0, 288.0, narrow, cx);
            for (index, result) in commands.into_iter().enumerate() {
                let bot = result.entry.bot.clone();
                let selected = self.selected_command == index;
                popup = popup.child(
                    Self::option_row(("command-result", index).into(), selected, cx)
                        .gap_2p5()
                        .px_2()
                        .py_1p5()
                        .child(avatar(bot.avatar_url.as_deref(), bot.name(), bot.avatar_color.as_deref(), 20.0, cx))
                        .child(div().flex_shrink_0().font_weight(FontWeight::SEMIBOLD).child(format!("/{}", result.command.name)))
                        .child(div().min_w_0().truncate().opacity(0.75).child(result.command.description.clone()))
                        .child(div().ml_auto().flex_shrink_0().opacity(0.6).child(bot.name().to_string()))
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered {
                                this.selected_command = index;
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| this.pick_command(result.clone(), window, cx))),
                );
            }
            return Some(popup.into_any_element());
        }
        if self.emoji.is_some() {
            let results = self.emoji_results(cx);
            if results.is_empty() {
                return None;
            }
            let mut grid = div().flex().flex_wrap();
            for (index, emoji) in results.into_iter().enumerate() {
                let selected = self.selected_emoji == index;
                let image = crate::ui::image::remote_img(&emoji.url, cx);
                let label = format!(":{}:", emoji.name.to_lowercase().replace(' ', "_"));
                grid = grid.child(
                    Self::option_row(("emoji-result", index).into(), selected, cx)
                        .when(!narrow, |row| row.w(relative(0.5)))
                        .gap_2()
                        .px_1p5()
                        .py_1()
                        .child(div().size_5().flex_shrink_0().children(image.map(|image| image.object_fit(ObjectFit::Contain))))
                        .child(div().truncate().child(label))
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered {
                                this.selected_emoji = index;
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| this.insert_emoji(&emoji, window, cx))),
                );
            }
            return Some(self.popup("emoji-results", 448.0, 224.0, narrow, cx).child(grid).into_any_element());
        }
        if self.mention.is_some() {
            let results = self.mention_results(cx);
            let mut popup = self.popup("mention-results", 448.0, 224.0, narrow, cx);
            if results.is_empty() {
                popup = popup.child(div().px_2().py_3().text_center().text_xs().text_color(t.muted_foreground).child("No members found"));
            }
            for (index, result) in results.into_iter().enumerate() {
                let selected = self.selected_mention == index;
                let handle = result.handle.clone();
                popup = popup.child(
                    Self::option_row(("mention-result", index).into(), selected, cx)
                        .gap_2()
                        .px_2()
                        .py_1p5()
                        .child(div().truncate().font_weight(FontWeight::MEDIUM).child(result.name))
                        .child(div().ml_auto().truncate().opacity(0.7).child(format!("@{}", result.handle)))
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered {
                                this.selected_mention = index;
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| this.insert_mention(&handle, window, cx))),
                );
            }
            return Some(popup.into_any_element());
        }
        None
    }

    fn render_reply(&self, reply: &Message, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let preview = if reply.content.is_empty() {
            crate::views::message::attachment_count(reply.attachments.len())
        } else {
            reply.content.clone()
        };
        div().border_b_1().border_color(t.border.opacity(0.6)).child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .py_1p5()
                .pr_1p5()
                .pl_3()
                .text_xs()
                .child(icon("corner-up-left").size(px(14.0)).flex_shrink_0().text_color(t.primary))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .border_l_2()
                        .border_color(t.primary.opacity(0.5))
                        .pl_2()
                        .child(
                            div()
                                .flex()
                                .gap_1()
                                .truncate()
                                .text_color(t.muted_foreground)
                                .child("Replying to")
                                .child(div().font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(reply.author.name().to_string())),
                        )
                        .child(div().truncate().text_color(t.muted_foreground).child(preview)),
                )
                .child(
                    div()
                        .id("cancel-reply")
                        .flex()
                        .size_6()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .hover(|s| s.bg(t.muted))
                        .child(icon("x").size(px(14.0)))
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(MessageInputEvent::CancelReply))),
                ),
        )
    }

    fn render_files(&self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let mut row = div().flex().gap_2().border_b_1().border_color(t.border.opacity(0.6)).p_2();
        for (index, picked) in self.files.iter().enumerate() {
            let content = match &picked.preview {
                Some(preview) => img(preview.clone()).size_full().object_fit(ObjectFit::Cover).into_any_element(),
                None => div()
                    .flex()
                    .flex_col()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_1p5()
                    .px_2()
                    .pb_4()
                    .child(icon("file-text").size_5().text_color(t.primary))
                    .child(div().w_full().truncate().text_center().text_size(px(11.0)).font_weight(FontWeight::MEDIUM).child(picked.file.name.clone()))
                    .into_any_element(),
            };
            row = row.child(
                div()
                    .id(("file", index))
                    .group("file")
                    .relative()
                    .size_20()
                    .flex_shrink_0()
                    .overflow_hidden()
                    .border_1()
                    .border_color(t.border)
                    .bg(t.background)
                    .child(content)
                    .child(
                        div()
                            .absolute()
                            .bottom_1()
                            .left_1()
                            .bg(t.background.opacity(0.8))
                            .px_1()
                            .text_size(px(10.0))
                            .text_color(t.muted_foreground)
                            .child(format_bytes(picked.file.bytes.len() as f64)),
                    )
                    .child(
                        div()
                            .id(("remove-file", index))
                            .absolute()
                            .top_1()
                            .right_1()
                            .flex()
                            .size_6()
                            .items_center()
                            .justify_center()
                            .bg(t.background.opacity(0.8))
                            .cursor_pointer()
                            .invisible()
                            .group_hover("file", |s| s.visible())
                            .hover(|s| s.bg(t.muted))
                            .child(icon("x").size_3())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if index < this.files.len() {
                                    this.files.remove(index);
                                }
                                cx.notify();
                            })),
                    ),
            );
        }
        row
    }
}

impl Render for MessageInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let narrow = window.viewport_size().width < px(640.0);
        let value = self.value(cx);
        let can_send = !value.trim().is_empty() || !self.files.is_empty();
        let remaining = MAX_MESSAGE_LENGTH as i64 - value.chars().count() as i64;
        let focused = self.is_focused(window, cx);
        let popups = self.render_popups(narrow, cx);
        let this = cx.entity().downgrade();

        let enter = cx.listener(|this: &mut Self, action: &Enter, window, cx| {
            if !action.shift && !action.secondary && this.navigate("enter", window, cx) {
                cx.stop_propagation();
            }
        });

        let input_row = div()
            .flex()
            .items_end()
            .gap_1()
            .p_1p5()
            .child(
                div()
                    .id("attach")
                    .flex()
                    .size_10()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .rounded(t.radius)
                    .cursor_pointer()
                    .text_color(t.muted_foreground)
                    .hover(|s| s.bg(t.muted).text_color(t.foreground))
                    .child(icon("paperclip").size_4())
                    .on_click(cx.listener(|this, _, _, cx| this.pick_files(cx))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .min_h_10()
                    .px_1()
                    .py(px(10.0))
                    .text_sm()
                    .line_height(px(20.0))
                    .capture_action(Self::key::<MoveUp>("up", cx))
                    .capture_action(Self::key::<MoveDown>("down", cx))
                    .capture_action(Self::key::<IndentInline>("tab", cx))
                    .capture_action(Self::key::<Escape>("escape", cx))
                    .capture_action(enter)
                    .on_key_up(cx.listener(|this, event: &KeyUpEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "left" | "right" | "home" | "end") {
                            this.update_search(cx);
                            cx.notify();
                        }
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            this.update_search(cx);
                            cx.notify();
                        }),
                    )
                    .child(
                        Textarea::new(&self.input)
                            .appearance(false)
                            .text_sm()
                            .on_paste(move |item, _, cx| this.update(cx, |this, cx| this.paste(item, cx)).unwrap_or(false)),
                    ),
            )
            .when(remaining <= 200, |row| {
                let color = if remaining <= 0 {
                    t.destructive
                } else if remaining <= 50 {
                    rgb(0xf59e0b).into()
                } else {
                    t.muted_foreground
                };
                row.child(div().flex().h_10().flex_shrink_0().items_center().px_1().text_xs().text_color(color).child(remaining.to_string()))
            })
            .child(
                div()
                    .id("send")
                    .flex()
                    .size_10()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .rounded(t.radius)
                    .when(can_send, |button| {
                        button
                            .bg(t.primary)
                            .text_color(t.primary_foreground)
                            .cursor_pointer()
                            .hover(|s| s.bg(t.primary.opacity(0.85)))
                            .on_click(cx.listener(|this, _, window, cx| this.send(window, cx)))
                    })
                    .when(!can_send, |button| button.text_color(t.muted_foreground).opacity(0.5))
                    .child(icon("send-horizontal").size_4()),
            );

        let composer = div()
            .relative()
            .flex()
            .flex_col()
            .border_1()
            .border_color(if self.dragging {
                t.primary
            } else if focused {
                t.primary.opacity(0.6)
            } else {
                t.border
            })
            .bg(t.card)
            .when_some(self.reply.clone(), |composer, reply| composer.child(self.render_reply(&reply, cx)))
            .when(!self.files.is_empty(), |composer| composer.child(self.render_files(cx)))
            .when_some(self.error.clone(), |composer, error| {
                composer.child(
                    div()
                        .border_b_1()
                        .border_color(t.border.opacity(0.6))
                        .bg(t.destructive.opacity(0.1))
                        .px_3()
                        .py_2()
                        .text_xs()
                        .text_color(t.destructive)
                        .child(error),
                )
            })
            .when_some(self.active_command.as_ref().map(|(form, _)| form.clone()), |composer, form| composer.child(form))
            .when(self.active_command.is_none(), |composer| composer.child(input_row))
            .when(self.dragging, |composer| {
                composer.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap_2()
                        .border_1()
                        .border_color(t.primary)
                        .bg(t.card.opacity(0.9))
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(t.primary)
                        .child(icon("paperclip").size_4())
                        .child("Drop to attach"),
                )
            });

        div()
            .relative()
            .flex_shrink_0()
            .px(if narrow { px(8.0) } else { px(16.0) })
            .pb(if narrow { px(8.0) } else { px(16.0) })
            .on_drag_move(cx.listener(|this, event: &DragMoveEvent<ExternalPaths>, _, cx| {
                let inside = event.bounds.contains(&event.event.position);
                if this.dragging != inside {
                    this.dragging = inside;
                    cx.notify();
                }
            }))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                this.dragging = false;
                this.add_paths(paths.paths().to_vec(), cx);
            }))
            .children(popups)
            .child(composer)
    }
}

#[cfg(test)]
mod tests {
    use super::{append_mention, command_query, complete, emoji_glyph, emoji_query, mention_query, mention_results};
    use crate::models::Author;

    fn member(username: &str, display_name: Option<&str>) -> Author {
        Author {
            user_id: username.into(),
            username: username.into(),
            server: "x.com".into(),
            display_name: display_name.map(Into::into),
            avatar_url: None,
            avatar_color: None,
            speaking_ring_color: None,
            banner_url: None,
            about: None,
            is_bot: false,
            status: None,
        }
    }

    #[test]
    fn finds_what_is_being_completed() {
        assert_eq!(mention_query("hi @an").as_deref(), Some("an"));
        assert_eq!(mention_query("@").as_deref(), Some(""));
        assert_eq!(mention_query("mail@an"), None);
        assert_eq!(emoji_query("so :smi").as_deref(), Some("smi"));
        assert_eq!(emoji_query("12:30"), None);
        assert_eq!(command_query("/Ro-ll").as_deref(), Some("ro-ll"));
        assert_eq!(command_query("/roll 6"), None);
        assert_eq!(command_query("hi"), None);
    }

    #[test]
    fn matches_members_and_everyone() {
        let members = vec![member("ana", Some("Ana Lima")), member("leo", None)];
        let results = mention_results(&members, "LI", true);
        assert_eq!(results.iter().map(|r| r.handle.as_str()).collect::<Vec<_>>(), ["ana:x.com"]);
        let all = mention_results(&members, "", true);
        assert_eq!(all.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["Everyone", "Ana Lima", "leo"]);
        assert_eq!(mention_results(&members, "ev", false).len(), 0);
        let many: Vec<Author> = (0..20).map(|i| member(&format!("u{i}"), None)).collect();
        assert_eq!(mention_results(&many, "u", false).len(), 8);
    }

    #[test]
    fn inserts_completions() {
        assert_eq!(complete("hi @an there", 3, 6, "@ana:x.com"), ("hi @ana:x.com  there".to_string(), 14));
        assert_eq!(emoji_glyph("1F44B-1F3FD"), "👋🏽");
        assert_eq!(append_mention("", "ana:x.com"), "@ana:x.com ");
        assert_eq!(append_mention("hey  ", "ana:x.com"), "hey @ana:x.com ");
    }
}
