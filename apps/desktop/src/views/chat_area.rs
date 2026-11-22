// Port of apps/frontend/src/lib/components/chat-area.svelte: the channel header, the message list
// (a gpui `list`, so only what's on screen is laid out), the typing line and the composer.
//
// Scrolling follows the web's rules through the list's tail-follow mode: while at the bottom the
// view follows new messages and growing content; scrolling up stops that and the message at the
// top keeps its place (older pages are spliced in above it); reaching the bottom follows again.
use std::{collections::HashMap, time::Duration};

use chrono::Local;
use uuid::Uuid;

use crate::prelude::*;

use crate::{
    models::{Channel, ChannelType, Message},
    state::{
        chat::{Chat, UploadFile},
        dms::Dms,
        realtime::Realtime,
        router,
        session::Session,
        settings::SettingsStore,
        voice::Voice,
    },
    ui::avatar::avatar,
    util::format_date::format_date,
    views::{
        message::{MessageEvent, MessageView, attachment_count},
        message_input::{MessageInput, MessageInputEvent},
        shell::{MD, ShellState},
        system_message::system_message,
    },
};

/// Messages within five minutes from the same author, with nothing in between, share a header.
pub fn grouped(previous: Option<&Message>, message: &Message, first_unread: bool) -> bool {
    let Some(previous) = previous else { return false };
    !first_unread
        && message.interaction.is_none()
        && !message.ephemeral
        && message.system.is_none()
        && previous.system.is_none()
        && previous.author.username == message.author.username
        && previous.author.server == message.author.server
        && (message.timestamp - previous.timestamp).num_milliseconds() < 5 * 60 * 1000
}

/// A day divider goes above the first message and above each one sent on a new (local) day.
pub fn starts_day(previous: Option<&Message>, message: &Message) -> bool {
    previous.is_none_or(|previous| {
        previous.timestamp.with_timezone(&Local).date_naive() != message.timestamp.with_timezone(&Local).date_naive()
    })
}

/// Where the "New" marker goes: after the last read message, or at the top when it isn't loaded.
/// `boundary` is `None` when the channel had nothing unread on opening.
pub fn first_unread_index(messages: &[Message], boundary: Option<Option<&str>>) -> Option<usize> {
    let last_read = boundary?;
    let Some(last_read) = last_read else { return Some(0) };
    match messages.iter().position(|message| message.id == last_read) {
        None => Some(0),
        Some(index) if index + 1 < messages.len() => Some(index + 1),
        Some(_) => None,
    }
}

pub fn typing_text(names: &[String]) -> Option<String> {
    match names {
        [] => None,
        [one] => Some(format!("{one} is typing...")),
        [one, two] => Some(format!("{one} and {two} are typing...")),
        _ => Some("Several people are typing...".into()),
    }
}

/// The list's changed span between two key sequences: `(start, removed, inserted)`.
pub fn splice_range(old: &[String], new: &[String]) -> Option<(usize, usize, usize)> {
    if old == new {
        return None;
    }
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..].iter().rev().zip(new[prefix..].iter().rev()).take_while(|(a, b)| a == b).count();
    Some((prefix, old.len() - prefix - suffix, new.len() - prefix - suffix))
}

/// An optimistic message: shown right away, dropped once the server has accepted it, kept for a
/// retry if it failed.
struct Pending {
    id: String,
    channel_id: String,
    content: Option<String>,
    files: Vec<UploadFile>,
    reply_to: Option<String>,
    failed: bool,
}

#[derive(Clone, PartialEq)]
enum Row {
    /// skeletons while an older page loads
    Older,
    Message { index: usize, grouped: bool, day: bool, unread: bool },
    Pending(String),
}

pub struct ChatArea {
    list: ListState,
    rows: Vec<Row>,
    keys: Vec<String>,
    messages: Vec<Message>,
    views: HashMap<String, (Entity<MessageView>, Subscription)>,
    channel_id: Option<String>,
    /// `(channel, last read message)` from when the channel opened with unread messages
    unread_boundary: Option<(String, Option<String>)>,
    replying_to: Option<Message>,
    pending: Vec<Pending>,
    input: Entity<MessageInput>,
    /// the channel the view already landed in, and the linked message it jumped to
    settled: Option<String>,
    jumped: Option<String>,
    flash: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl ChatArea {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| MessageInput::new(window, cx));
        let subscriptions = vec![
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Dms::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Voice::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Realtime::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&ShellState::global(cx), |_, _, cx| cx.notify()),
            cx.subscribe(&input, |this, _, event: &MessageInputEvent, cx| match event {
                MessageInputEvent::Send { content, files } => this.send(content.clone(), files.clone(), cx),
                MessageInputEvent::CancelReply => this.set_reply(None, cx),
            }),
        ];
        let list = ListState::new(0, ListAlignment::Bottom, px(800.0));
        list.set_follow_mode(FollowMode::Tail);
        let this = cx.entity().downgrade();
        list.set_scroll_handler(move |event, _, cx| {
            let _ = this.update(cx, |this, cx| this.on_scroll(event, cx));
        });
        Self {
            list,
            rows: vec![],
            keys: vec![],
            messages: vec![],
            views: HashMap::new(),
            channel_id: None,
            unread_boundary: None,
            replying_to: None,
            pending: vec![],
            input,
            settled: None,
            jumped: None,
            flash: None,
            _subscriptions: subscriptions,
        }
    }

    fn set_reply(&mut self, message: Option<Message>, cx: &mut Context<Self>) {
        self.replying_to = message.clone();
        self.input.update(cx, |input, cx| {
            input.reply = message;
            cx.notify();
        });
        cx.notify();
    }

    fn on_scroll(&mut self, event: &ListScrollEvent, cx: &mut Context<Self>) {
        let Some(channel_id) = self.channel_id.clone() else { return };
        if event.visible_range.start > 1 {
            return;
        }
        let chat = Chat::global(cx);
        let read = chat.read(cx);
        if read.current_messages_loading(cx)
            || read.loading_older_by_channel.get(&channel_id).copied().unwrap_or(false)
            || !read.has_more_messages(&channel_id)
        {
            return;
        }
        chat.update(cx, |chat, cx| chat.load_older_messages(channel_id, cx)).detach();
    }

    fn send(&mut self, content: Option<String>, files: Vec<UploadFile>, cx: &mut Context<Self>) {
        let Some(channel_id) = self.channel_id.clone() else { return };
        let id = Uuid::new_v4().to_string();
        self.pending.push(Pending {
            id: id.clone(),
            channel_id,
            content,
            files,
            reply_to: self.replying_to.as_ref().map(|message| message.id.clone()),
            failed: false,
        });
        self.unread_boundary = None;
        self.set_reply(None, cx);
        self.retry(&id, cx);
        // sending always brings you back down to your message
        self.list.set_follow_mode(FollowMode::Tail);
        cx.notify();
    }

    fn retry(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(item) = self.pending.iter_mut().find(|item| item.id == id) else { return };
        item.failed = false;
        let (channel_id, content, files, reply_to) =
            (item.channel_id.clone(), item.content.clone(), item.files.clone(), item.reply_to.clone());
        let task = Chat::global(cx).update(cx, |chat, cx| chat.send_message(channel_id, content, files, reply_to, cx));
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(()) => this.pending.retain(|item| item.id != id),
                    Err(_) => {
                        if let Some(item) = this.pending.iter_mut().find(|item| item.id == id) {
                            item.failed = true;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Follows the store: rebuilds the rows, keeps a view per message and tells the list what
    /// changed, so it keeps the scroll position on the same message.
    fn sync(&mut self, channel: &Channel, cx: &mut Context<Self>) {
        let chat = Chat::global(cx).read(cx);
        let messages = chat.current_messages(cx).to_vec();
        let older_loading = chat.loading_older_by_channel.get(&channel.id).copied().unwrap_or(false);

        if self.channel_id.as_deref() != Some(channel.id.as_str()) {
            self.channel_id = Some(channel.id.clone());
            self.unread_boundary = channel.unread.then(|| (channel.id.clone(), channel.last_read_message_id.clone()));
            self.set_reply(None, cx);
            self.views.clear();
            self.keys.clear();
            self.rows.clear();
            self.list.reset(0);
            self.list.set_follow_mode(FollowMode::Tail);
        }

        let boundary = self
            .unread_boundary
            .as_ref()
            .filter(|(channel_id, _)| *channel_id == channel.id)
            .map(|(_, last_read)| last_read.as_deref());
        let first_unread = first_unread_index(&messages, boundary);
        let by_id: HashMap<&str, &Message> = messages.iter().map(|message| (message.id.as_str(), message)).collect();

        let mut rows = Vec::with_capacity(messages.len() + 2);
        let mut keys = Vec::with_capacity(messages.len() + 2);
        if older_loading {
            rows.push(Row::Older);
            keys.push("older".to_string());
        }
        let mut live = HashMap::new();
        for (index, message) in messages.iter().enumerate() {
            let previous = index.checked_sub(1).map(|previous| &messages[previous]);
            let unread = first_unread == Some(index);
            let row = Row::Message { index, grouped: grouped(previous, message, unread), day: starts_day(previous, message), unread };
            let Row::Message { grouped, .. } = row else { unreachable!() };
            if message.system.is_none() {
                let replied = message.reply_to.as_deref().and_then(|id| by_id.get(id).copied());
                let view = match self.views.remove(&message.id) {
                    Some((view, subscription)) => {
                        view.update(cx, |view, cx| view.set(message, replied, grouped, cx));
                        (view, subscription)
                    }
                    None => {
                        let view = cx.new(|_| MessageView::new(message.clone(), replied.cloned(), grouped));
                        let subscription = cx.subscribe(&view, |this, view, event: &MessageEvent, cx| match event {
                            MessageEvent::Reply => {
                                let message = view.read(cx).message.clone();
                                this.set_reply(Some(message), cx);
                                let input = this.input.clone();
                                cx.defer(move |cx| {
                                    if let Some(window) = cx.active_window() {
                                        let _ = window.update(cx, |_, window, cx| MessageInput::focus_entity(&input, window, cx));
                                    }
                                });
                            }
                        });
                        (view, subscription)
                    }
                };
                live.insert(message.id.clone(), view);
            }
            keys.push(message.id.clone());
            rows.push(row);
        }
        for item in self.pending.iter().filter(|item| item.channel_id == channel.id) {
            keys.push(format!("pending:{}", item.id));
            rows.push(Row::Pending(item.id.clone()));
        }
        self.views = live;

        // edited messages and rows whose decorations moved (grouping, dividers) are measured again
        let old: HashMap<&str, (&Row, Option<&Message>)> = self
            .keys
            .iter()
            .zip(&self.rows)
            .map(|(key, row)| {
                let message = match row {
                    Row::Message { index, .. } => self.messages.get(*index),
                    _ => None,
                };
                (key.as_str(), (row, message))
            })
            .collect();
        let changed: Vec<usize> = keys
            .iter()
            .zip(&rows)
            .enumerate()
            .filter(|(_, (key, row))| {
                old.get(key.as_str()).is_some_and(|(old_row, old_message)| {
                    let message = match row {
                        Row::Message { index, .. } => messages.get(*index),
                        _ => None,
                    };
                    let moved = |row: &Row| match row {
                        Row::Message { grouped, day, unread, .. } => Some((*grouped, *day, *unread)),
                        _ => None,
                    };
                    moved(old_row) != moved(row) || *old_message != message
                })
            })
            .map(|(index, _)| index)
            .collect();
        drop(old);
        if let Some((start, removed, inserted)) = splice_range(&self.keys, &keys) {
            self.list.splice(start..start + removed, inserted);
        }
        for index in changed {
            self.list.remeasure_items(index..index + 1);
        }
        self.keys = keys;
        self.rows = rows;
        self.messages = messages;
    }

    /// Opening a channel lands at the bottom; a linked message (search, reply, notification) is
    /// brought into view and flashes, then leaves the url.
    fn settle(&mut self, channel: &Channel, cx: &mut Context<Self>) {
        let chat = Chat::global(cx).read(cx);
        if chat.current_messages_loading(cx) {
            return;
        }
        let active = chat.active_message(cx);
        let changed = self.settled.as_deref() != Some(channel.id.as_str());
        if !changed && (active.is_none() || active == self.jumped) {
            self.jumped = active;
            return;
        }
        self.settled = Some(channel.id.clone());
        self.jumped = active.clone();
        let target = active.as_ref().and_then(|id| {
            self.rows.iter().position(|row| matches!(row, Row::Message { index, .. } if self.messages[*index].id == *id))
        });
        match (target, active) {
            (Some(row), Some(id)) => {
                self.list.scroll_to(ListOffset { item_ix: row.saturating_sub(2), offset_in_item: px(0.0) });
                self.flash = Some(cx.spawn(async move |_, cx| {
                    cx.background_executor().timer(Duration::from_millis(1500)).await;
                    cx.update(|cx| {
                        let chat = Chat::global(cx).read(cx);
                        if chat.active_message(cx).as_deref() == Some(id.as_str()) {
                            let path = chat.existing_channel_path(cx);
                            router::goto(path, cx);
                        }
                    });
                }));
            }
            _ => self.list.set_follow_mode(FollowMode::Tail),
        }
    }

    fn render_row(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let narrow = window.viewport_size().width < px(640.0);
        let gutter = if narrow { px(12.0) } else { px(16.0) };
        match self.rows.get(ix).cloned() {
            None => div().into_any_element(),
            Some(Row::Older) => div().px(gutter).pt_4().child(skeleton_rows(2, cx)).into_any_element(),
            Some(Row::Pending(id)) => match self.pending.iter().find(|item| item.id == id) {
                Some(item) => self.render_pending(item, gutter, cx).into_any_element(),
                None => div().into_any_element(),
            },
            Some(Row::Message { index, grouped, day, unread }) => {
                let message = &self.messages[index];
                let marker = |label: String, color: Hsla, line: Hsla| {
                    div()
                        .px(gutter)
                        .my_3()
                        .flex()
                        .items_center()
                        .gap_2()
                        .text_size(px(10.0))
                        .font_weight(FontWeight::BOLD)
                        .text_color(color)
                        .child(div().h_px().flex_1().bg(line))
                        .child(label.to_uppercase())
                };
                let body: AnyElement = match &message.system {
                    Some(system) => system_message(message, system, cx).px(gutter).into_any_element(),
                    None => match self.views.get(&message.id) {
                        Some((view, _)) => view.clone().into_any_element(),
                        None => div().into_any_element(),
                    },
                };
                let first = index == 0;
                div()
                    .when(day, |row| {
                        row.child(marker(format_date(&message.timestamp.with_timezone(&Local), &Local::now()), t.muted_foreground.opacity(0.2), t.muted_foreground.opacity(0.2)))
                    })
                    .when(unread, |row| row.child(marker("New".into(), t.destructive, t.destructive)))
                    .child(div().when(!first, |row| if grouped { row.mt_0p5() } else { row.mt_4() }).child(body))
                    .into_any_element()
            }
        }
    }

    fn render_pending(&self, item: &Pending, gutter: Pixels, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let user = Session::user(cx);
        let name = user.as_ref().map(|user| user.name().to_string()).unwrap_or_else(|| "You".into());
        let progress = {
            let values: Vec<f32> = Chat::global(cx).read(cx).upload_progress.values().copied().collect();
            (!values.is_empty()).then(|| values.iter().sum::<f32>() / values.len() as f32)
        };
        let id = item.id.clone();
        let discard = item.id.clone();
        div()
            .mt_4()
            .px(gutter)
            .py_0p5()
            .flex()
            .gap_3()
            .child(
                avatar(
                    user.as_ref().and_then(|user| user.avatar_url.as_deref()),
                    &name,
                    user.as_ref().and_then(|user| user.avatar_color.as_deref()),
                    36.0,
                    cx,
                )
                .mt_0p5(),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(t.foreground).child(name))
                    .child(
                        div()
                            .when(!item.failed, |body| body.opacity(0.6))
                            .when_some(item.content.clone(), |body, content| {
                                body.child(div().text_sm().line_height(relative(1.625)).text_color(t.foreground.opacity(0.9)).child(content))
                            })
                            .when(!item.files.is_empty(), |body| {
                                body.child(div().text_xs().text_color(t.muted_foreground).child(attachment_count(item.files.len())))
                                    .when_some(progress.filter(|_| !item.failed), |body, progress| {
                                        body.child(
                                            div()
                                                .mt_1()
                                                .h_0p5()
                                                .max_w(px(320.0))
                                                .bg(t.muted)
                                                .child(div().h_full().w(relative(progress.clamp(0.0, 1.0))).bg(t.primary)),
                                        )
                                    })
                            }),
                    )
                    .when(item.failed, |body| {
                        body.child(
                            div()
                                .flex()
                                .items_center()
                                .gap_1()
                                .text_xs()
                                .text_color(t.destructive)
                                .child(
                                    div()
                                        .id(SharedString::from(format!("retry-{id}")))
                                        .flex()
                                        .items_center()
                                        .gap_1p5()
                                        .cursor_pointer()
                                        .hover(|s| s.underline())
                                        .child(icon("rotate-cw").size(px(14.0)))
                                        .child("Failed to send. Click to retry")
                                        .on_click(cx.listener(move |this, _, _, cx| this.retry(&id, cx))),
                                )
                                .child(
                                    div()
                                        .id(SharedString::from(format!("discard-{discard}")))
                                        .flex()
                                        .size_6()
                                        .items_center()
                                        .justify_center()
                                        .cursor_pointer()
                                        .hover(|s| s.bg(t.muted))
                                        .child(icon("x").size(px(14.0)).text_color(t.muted_foreground))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.pending.retain(|item| item.id != discard);
                                            cx.notify();
                                        })),
                                ),
                        )
                    }),
            )
    }

    fn header_button(id: &'static str, name: &str, cx: &App) -> Stateful<Div> {
        let t = theme::tokens(cx);
        div()
            .id(id)
            .flex()
            .size_9()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .rounded(t.radius)
            .cursor_pointer()
            .hover(|s| s.bg(t.muted.opacity(0.5)))
            .child(icon(name).size_5())
    }

    fn render_header(&self, channel: &Channel, in_call: bool, callers: usize, ringing: bool, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let width = ShellState::global(cx).read(cx).width;
        let channel_icon: AnyElement = match channel.kind {
            ChannelType::Voice => icon("volume-2").size_5().text_color(t.muted_foreground).into_any_element(),
            ChannelType::Dm => {
                avatar(channel.avatar_url.as_deref(), &channel.name, channel.avatar_color.as_deref(), 24.0, cx).into_any_element()
            }
            ChannelType::Text => icon("hash").size_5().text_color(t.muted_foreground).into_any_element(),
        };
        let id = channel.id.clone();
        let ring_id = channel.id.clone();
        div()
            .flex()
            .h_12()
            .flex_shrink_0()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(t.border)
            .px(if width < 640.0 { px(8.0) } else { px(16.0) })
            .when(width < MD, |header| {
                header.child(Self::header_button("open-navigation", "menu", cx).on_click(|_, _, cx| ShellState::open_navigation(cx)))
            })
            .child(channel_icon)
            .child(div().flex_shrink_0().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(t.foreground).child(channel.name.clone()))
            .when_some(channel.topic.clone(), |header, topic| {
                header
                    .child(div().mx_1p5().text_color(t.muted_foreground.opacity(0.3)).child("|"))
                    .child(div().min_w_0().truncate().text_xs().text_color(t.muted_foreground.opacity(0.7)).child(topic))
            })
            .child(div().flex_1())
            .when(channel.kind == ChannelType::Dm && !in_call, |header| {
                header.child(Self::header_button("start-call", "phone", cx).on_click(move |_, _, cx| ShellState::start_call(&id, cx)))
            })
            .when(channel.kind == ChannelType::Dm && in_call && callers <= 1 && !ringing, |header| {
                header.child(Self::header_button("ring", "bell-ring", cx).on_click(move |_, _, cx| {
                    Realtime::global(cx).update(cx, |realtime, cx| realtime.ring_call(&ring_id, true, cx));
                }))
            })
            .when(channel.kind != ChannelType::Dm || channel.group, |header| {
                header.child(Self::header_button("toggle-members", "users", cx).on_click(|_, _, cx| ShellState::toggle_members(cx)))
            })
    }

    /// Where the DM call (voice_area, embedded) goes once voice is ported: above the messages,
    /// resizable, or over them when expanded. Nothing yet, so the messages stay in place.
    fn dm_call_slot(&self, _channel: &Channel, _cx: &mut Context<Self>) -> Option<AnyElement> {
        None
    }

    fn render_empty(&self, channel: &Channel, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let title = if channel.group {
            format!("This is the beginning of the {} group.", channel.name)
        } else if channel.kind == ChannelType::Dm {
            format!("This is the beginning of your conversation with {}.", channel.name)
        } else {
            "No messages yet".into()
        };
        div()
            .mb_4()
            .max_w(px(448.0))
            .flex()
            .flex_col()
            .items_start()
            .gap_3()
            .when(channel.kind == ChannelType::Dm, |empty| {
                empty.child(avatar(channel.avatar_url.as_deref(), &channel.name, channel.avatar_color.as_deref(), 56.0, cx))
            })
            .child(
                div()
                    .border_1()
                    .border_dashed()
                    .border_color(t.border)
                    .p_4()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(title))
                    .when(channel.kind != ChannelType::Dm, |card| {
                        card.child(div().mt_1().text_sm().text_color(t.muted_foreground).child(format!("Start the conversation in #{}.", channel.name)))
                    }),
            )
    }
}

fn skeleton_rows(count: usize, cx: &App) -> AnyElement {
    let t = theme::tokens(cx);
    let bar = |width: DefiniteLength, height: Pixels, faded: bool| {
        div().w(width).h(height).bg(if faded { t.muted.opacity(0.7) } else { t.muted })
    };
    let mut rows = div().flex().flex_col().gap_5();
    for index in 0..count {
        rows = rows.child(
            div()
                .flex()
                .gap_3()
                .when(index > 2, |row| row.opacity(0.6))
                .child(div().mt_0p5().size_9().flex_shrink_0().bg(t.muted))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap_2()
                        .child(div().flex().items_center().gap_2().child(bar(px(96.0).into(), px(12.0), false)).child(bar(px(40.0).into(), px(8.0), true)))
                        .child(bar(relative(0.75), px(12.0), false))
                        .child(bar(relative(0.5), px(12.0), true)),
                ),
        );
    }
    rows.with_animation(
        ("skeleton", count),
        Animation::new(Duration::from_secs(2)).repeat(),
        |rows, delta| rows.opacity(1.0 - 0.5 * (delta * std::f32::consts::PI).sin()),
    )
    .into_any_element()
}

fn typing_dots(cx: &App) -> Div {
    let t = theme::tokens(cx);
    let mut dots = div().mr_2p5().flex().items_center().gap_0p5();
    for (index, delay) in [0.3f32, 0.15, 0.0].into_iter().enumerate() {
        dots = dots.child(
            div().relative().size_1().rounded_full().bg(t.muted_foreground).with_animation(
                ("typing-dot", index),
                Animation::new(Duration::from_secs(1)).repeat(),
                move |dot, delta| {
                    // animate-bounce: up a quarter of its size at the ends, resting in the middle
                    let phase = (delta + delay).fract();
                    dot.top(px(-((2.0 * phase - 1.0).powi(2))))
                },
            ),
        );
    }
    dots
}

impl Render for ChatArea {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let chat = Chat::global(cx).read(cx);
        let Some(channel) = chat.current_channel(cx) else { return div().flex_1().bg(t.background).into_any_element() };
        let loading = chat.current_messages_loading(cx);
        let can_send = chat.can_send_in_current_channel(cx);
        let typing: Vec<String> = chat.current_typing(cx).iter().map(|entry| entry.name.clone()).collect();
        let callers: Vec<String> = if channel.kind == ChannelType::Dm {
            chat.voice_states.get(&channel.id).into_iter().flatten().map(|state| state.name.clone().unwrap_or_else(|| "Someone".into())).collect()
        } else {
            vec![]
        };
        let in_call = channel.kind == ChannelType::Dm && Voice::global(cx).read(cx).channel_id.as_deref() == Some(channel.id.as_str());
        let ringing = in_call && Dms::global(cx).read(cx).outgoing_call.as_deref() == Some(channel.id.as_str());

        self.sync(&channel, cx);
        self.settle(&channel, cx);

        let placeholder = if channel.group {
            format!("Message {}", channel.name)
        } else if channel.kind == ChannelType::Dm {
            format!("Message @{}", channel.name)
        } else {
            format!("Message #{}", channel.name)
        };
        self.input.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));

        let narrow = window.viewport_size().width < px(640.0);
        let gutter = if narrow { px(12.0) } else { px(16.0) };
        let has_rows = !self.rows.is_empty();
        let messages: AnyElement = if loading {
            div().flex().flex_col().flex_1().justify_end().px(gutter).py_4().child(skeleton_rows(5, cx)).into_any_element()
        } else if !has_rows {
            div().flex().flex_col().flex_1().justify_end().px(gutter).py_4().child(self.render_empty(&channel, cx)).into_any_element()
        } else {
            list(self.list.clone(), cx.processor(|this, ix, window, cx| this.render_row(ix, window, cx)))
                .flex_1()
                .min_h_0()
                .pt_4()
                .pb_4()
                .into_any_element()
        };

        let start_call = channel.id.clone();
        let banner = (!in_call && !callers.is_empty()).then(|| {
            let verb = if callers.len() == 1 { "is" } else { "are" };
            div()
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap_2()
                .border_b_1()
                .border_color(t.border)
                .bg(t.primary.opacity(0.05))
                .px_4()
                .py_2()
                .child(icon("phone").size_4().flex_shrink_0().text_color(rgb(0x22c55e)).with_animation(
                    "callers-pulse",
                    Animation::new(Duration::from_secs(2)).repeat(),
                    |icon, delta| icon.opacity(1.0 - 0.5 * (delta * std::f32::consts::PI).sin()),
                ))
                .child(div().flex_1().truncate().text_sm().text_color(t.foreground).child(format!("{} {verb} in the call", callers.join(", "))))
                .child(
                    div()
                        .id("join-call")
                        .flex()
                        .h_7()
                        .items_center()
                        .px_2p5()
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .bg(rgb(0x16a34a))
                        .text_color(white())
                        .cursor_pointer()
                        .hover(|s| s.bg(rgb(0x15803d)))
                        .child("Join")
                        .on_click(move |_, _, cx| ShellState::start_call(&start_call, cx)),
                )
        });

        let bottom = if can_send {
            self.input.clone().into_any_element()
        } else {
            div()
                .flex()
                .min_h_12()
                .flex_shrink_0()
                .items_center()
                .justify_center()
                .gap_2()
                .border_t_1()
                .border_color(t.border)
                .px_3()
                .text_sm()
                .text_color(t.muted_foreground)
                .child(icon("megaphone").size_4())
                .child("Only the server owner can send messages in this channel.")
                .into_any_element()
        };

        let input = self.input.clone();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .bg(t.background)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && this.unread_boundary.is_some() {
                    this.unread_boundary = None;
                    cx.notify();
                }
            }))
            .on_key_down(move |event: &KeyDownEvent, window, cx| {
                // typing anywhere in the chat goes to the composer
                let modifiers = event.keystroke.modifiers;
                let typed = event.keystroke.key_char.is_some() && !modifiers.control && !modifiers.platform;
                if typed
                    && !Chat::global(cx).read(cx).editing_message
                    && input.read(cx).takes_typing()
                    && !input.read(cx).is_focused(window, cx)
                {
                    MessageInput::focus_entity(&input, window, cx);
                }
            })
            .on_modifiers_changed(cx.listener(|_, _, _, cx| cx.notify()))
            .child(self.render_header(&channel, in_call, callers.len(), ringing, cx))
            .children(banner)
            .children(self.dm_call_slot(&channel, cx))
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .child(messages)
                    .when_some(typing_text(&typing), |column, text| {
                        column.child(
                            div()
                                .flex()
                                .h_6()
                                .flex_shrink_0()
                                .items_center()
                                .px(gutter)
                                .text_xs()
                                .text_color(t.muted_foreground)
                                .child(typing_dots(cx))
                                .child(text),
                        )
                    })
                    .child(bottom),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone, Utc};

    use super::{first_unread_index, grouped, splice_range, starts_day, typing_text};
    use crate::models::{Author, Message, SystemMessage};

    fn message(id: &str, from: &str, minute: i64) -> Message {
        Message {
            id: id.into(),
            author: Author {
                user_id: from.into(),
                username: from.into(),
                server: "x.com".into(),
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
            timestamp: Utc.with_ymd_and_hms(2026, 11, 22, 12, 0, 0).unwrap() + Duration::minutes(minute),
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

    #[test]
    fn groups_close_messages_from_the_same_author() {
        let first = message("1", "ana", 0);
        assert!(!grouped(None, &first, false));
        assert!(grouped(Some(&first), &message("2", "ana", 4), false));
        assert!(!grouped(Some(&first), &message("2", "ana", 6), false));
        assert!(!grouped(Some(&first), &message("2", "leo", 1), false));
        assert!(!grouped(Some(&first), &message("2", "ana", 1), true));
        let mut system = message("2", "ana", 1);
        system.system = Some(SystemMessage::GroupCreated);
        assert!(!grouped(Some(&system), &message("3", "ana", 2), false));
        let mut ephemeral = message("2", "ana", 1);
        ephemeral.ephemeral = true;
        assert!(!grouped(Some(&first), &ephemeral, false));
    }

    #[test]
    fn divides_days() {
        let first = message("1", "ana", 0);
        assert!(starts_day(None, &first));
        assert!(!starts_day(Some(&first), &message("2", "ana", 1)));
        assert!(starts_day(Some(&first), &message("2", "ana", 60 * 24)));
    }

    #[test]
    fn places_the_unread_marker() {
        let messages = vec![message("1", "a", 0), message("2", "a", 1), message("3", "a", 2)];
        assert_eq!(first_unread_index(&messages, None), None);
        assert_eq!(first_unread_index(&messages, Some(None)), Some(0));
        assert_eq!(first_unread_index(&messages, Some(Some("1"))), Some(1));
        assert_eq!(first_unread_index(&messages, Some(Some("3"))), None);
        assert_eq!(first_unread_index(&messages, Some(Some("gone"))), Some(0));
    }

    #[test]
    fn describes_who_is_typing() {
        assert_eq!(typing_text(&[]), None);
        assert_eq!(typing_text(&["Ana".into()]).unwrap(), "Ana is typing...");
        assert_eq!(typing_text(&["Ana".into(), "Leo".into()]).unwrap(), "Ana and Leo are typing...");
        assert_eq!(typing_text(&["a".into(), "b".into(), "c".into()]).unwrap(), "Several people are typing...");
    }

    #[test]
    fn finds_the_changed_span() {
        let keys = |list: &[&str]| list.iter().map(|key| key.to_string()).collect::<Vec<_>>();
        assert_eq!(splice_range(&keys(&["a", "b"]), &keys(&["a", "b"])), None);
        // an older page goes in above
        assert_eq!(splice_range(&keys(&["older", "c", "d"]), &keys(&["a", "b", "c", "d"])), Some((0, 1, 2)));
        // a new message at the bottom
        assert_eq!(splice_range(&keys(&["a", "b"]), &keys(&["a", "b", "c"])), Some((2, 0, 1)));
        // a deleted one in the middle
        assert_eq!(splice_range(&keys(&["a", "b", "c"]), &keys(&["a", "c"])), Some((1, 1, 0)));
    }
}
