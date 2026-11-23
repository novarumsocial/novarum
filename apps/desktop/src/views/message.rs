// Port of apps/frontend/src/lib/components/message.svelte: one message, its hover actions and
// right-click menu, inline editing and attachments. The chat area keeps one of these per message.
use std::{rc::Rc, time::Duration};

use chrono::{DateTime, Local};
use gpui_kit::component::{
    input::{InputEvent, Textarea, TextareaState},
    menu::{ContextMenuExt, DropdownMenu, PopupMenu, PopupMenuItem},
    tooltip::Tooltip,
};

use crate::prelude::*;

use crate::{
    models::{Attachment, Message},
    state::{
        chat::{Chat, MAX_MESSAGE_LENGTH},
        router::{self, ChatRoute},
        session::{Session, is_self},
        settings::SettingsStore,
    },
    ui::avatar::avatar,
    util::{
        format_date::{format_date, format_time},
        utils::{format_bytes, mentions_everyone},
    },
    views::{
        animated_image::animated_image,
        attachment_viewer::{AttachmentViewer, ViewerEvent, download, is_viewable},
        audio_player::audio_player,
        bot_badge::bot_badge,
        emoji_text::{TextOptions, handles},
        markdown::{MarkdownOptions, markdown},
        message_components::message_components,
        message_embed::message_embed,
        profile_card::{OnCall, profile_card},
        shell::ShellState,
        video_player::video_player,
    },
};

/// `bg-amber-400`
pub fn amber() -> Hsla {
    crate::theme::oklch(0.828, 0.189, 84.429, 1.0)
}

/// What copying a message link gives: the desktop app's own address for the message.
pub fn message_link(path: &str) -> String {
    format!("app://novarum{path}")
}

/// "1 attachment", "3 attachments"
pub fn attachment_count(count: usize) -> String {
    format!("{count} attachment{}", if count == 1 { "" } else { "s" })
}

/// Whether `message` should be highlighted for the signed-in user: a reply to them, @everyone in a
/// guild, or their handle in the text.
pub fn mentions_me(
    message: &Message,
    replied: Option<&Message>,
    my_handle: &str,
    in_guild: bool,
    is_mine: bool,
) -> bool {
    if is_mine {
        return false;
    }
    let my_handle = my_handle.to_lowercase();
    replied.is_some_and(|replied| replied.author.handle().to_lowercase() == my_handle)
        || (in_guild && mentions_everyone(Some(&message.content)))
        || handles(&message.content)
            .iter()
            .any(|handle| handle.to_lowercase() == my_handle)
}

/// The box an image attachment gets: its own size scaled into `max` (keeping at least
/// `min_width`), or `fallback` when the homeserver didn't say.
pub fn image_box(
    width: Option<u32>,
    height: Option<u32>,
    max: Size<f32>,
    min_width: f32,
    fallback: Size<f32>,
) -> Size<f32> {
    match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => {
            let (width, height) = (width as f32, height as f32);
            let scale = (max.width / width).min(max.height / height).min(1.0);
            size(
                (width * scale).max(min_width).min(max.width),
                height * scale,
            )
        }
        _ => fallback,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Deleting {
    Idle,
    /// the first click asked "You sure?"
    Confirm,
    Busy,
}

pub enum MessageEvent {
    Reply,
}

impl EventEmitter<MessageEvent> for MessageView {}

pub struct MessageView {
    pub message: Message,
    replied: Option<Message>,
    grouped: bool,
    hovered: bool,
    menu_open: bool,
    deleting: Deleting,
    delete_reset: Option<Task<()>>,
    edit: Option<(Entity<TextareaState>, Subscription)>,
    saving: bool,
    viewer: Option<(Entity<AttachmentViewer>, Subscription)>,
    components_error: Option<String>,
}

fn icon_button(id: impl Into<ElementId>, name: &str, cx: &App) -> Stateful<Div> {
    let t = theme::tokens(cx);
    div()
        .id(id)
        .flex()
        .size_6()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .rounded(t.radius)
        .cursor_pointer()
        .hover(|s| s.bg(t.muted.opacity(0.5)).text_color(t.foreground))
        .child(icon(name).size_3())
}

impl MessageView {
    pub fn new(message: Message, replied: Option<Message>, grouped: bool) -> Self {
        Self {
            message,
            replied,
            grouped,
            hovered: false,
            menu_open: false,
            deleting: Deleting::Idle,
            delete_reset: None,
            edit: None,
            saving: false,
            viewer: None,
            components_error: None,
        }
    }

    pub fn set(
        &mut self,
        message: &Message,
        replied: Option<&Message>,
        grouped: bool,
        cx: &mut Context<Self>,
    ) {
        if self.message != *message || self.replied.as_ref() != replied || self.grouped != grouped {
            self.message = message.clone();
            self.replied = replied.cloned();
            self.grouped = grouped;
            cx.notify();
        }
    }

    fn local_only(&self) -> bool {
        self.message.ephemeral || self.message.thinking
    }

    fn is_mine(&self, cx: &App) -> bool {
        is_self(
            &self.message.author.username,
            &self.message.author.server,
            cx,
        )
    }

    fn channel_id(cx: &App) -> String {
        let chat = Chat::global(cx);
        chat.read(cx).active_channel(cx).unwrap_or_default()
    }

    fn start_editing(&mut self, cx: &mut Context<Self>) {
        let id = self.message.id.clone();
        Chat::global(cx).update(cx, |chat, cx| chat.set_editing_message(Some(id), cx));
    }

    fn delete(&mut self, shift: bool, cx: &mut Context<Self>) {
        match self.deleting {
            Deleting::Busy => return,
            Deleting::Idle if !shift => {
                self.deleting = Deleting::Confirm;
                self.delete_reset = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(3)).await;
                    let _ = this.update(cx, |this, cx| {
                        if this.deleting == Deleting::Confirm {
                            this.deleting = Deleting::Idle;
                            cx.notify();
                        }
                    });
                }));
                cx.notify();
                return;
            }
            _ => {}
        }
        self.deleting = Deleting::Busy;
        cx.notify();
        let (channel_id, message_id) = (Self::channel_id(cx), self.message.id.clone());
        let task = Chat::global(cx).update(cx, |chat, cx| {
            chat.delete_message(channel_id, message_id, cx)
        });
        cx.spawn(async move |this, cx| {
            let _ = task.await;
            let _ = this.update(cx, |this, cx| {
                this.deleting = Deleting::Idle;
                cx.notify();
            });
        })
        .detach();
    }

    fn delete_label(&self) -> &'static str {
        match self.deleting {
            Deleting::Idle => "Delete",
            Deleting::Confirm => "You sure?",
            Deleting::Busy => "Deleting...",
        }
    }

    fn copy_text(&self, cx: &mut App) {
        cx.write_to_clipboard(ClipboardItem::new_string(self.message.content.clone()));
    }

    fn copy_link(&self, cx: &mut App) {
        let path = Chat::global(cx).read(cx).message_path(&self.message.id, cx);
        cx.write_to_clipboard(ClipboardItem::new_string(message_link(&path)));
    }

    fn save_edit(&mut self, cx: &mut Context<Self>) {
        let Some((input, _)) = &self.edit else { return };
        if self.saving {
            return;
        }
        let next = input.read(cx).value().trim().to_string();
        let chat = Chat::global(cx);
        if next == self.message.content {
            chat.update(cx, |chat, cx| chat.set_editing_message(None, cx));
            return;
        }
        self.saving = true;
        cx.notify();
        let (channel_id, message_id) = (Self::channel_id(cx), self.message.id.clone());
        let content = (!next.is_empty()).then_some(next);
        let task = chat.update(cx, |chat, cx| {
            chat.edit_message(channel_id, message_id, content, cx)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                if result.is_ok() {
                    Chat::global(cx).update(cx, |chat, cx| chat.set_editing_message(None, cx));
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Opens or closes the inline editor to follow `chat.editingMessageId`.
    fn sync_editing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let chat = Chat::global(cx).read(cx);
        let editing = chat.editing_message
            && chat.editing_message_id.as_deref() == Some(self.message.id.as_str());
        match (editing, self.edit.is_some()) {
            (true, false) => {
                let content = self.message.content.clone();
                let input = cx.new(|cx| {
                    TextareaState::new(window, cx)
                        .auto_grow(3, 12)
                        .submit_on_enter(true)
                        .default_value(content)
                });
                input.update(cx, |input, cx| input.focus(window, cx));
                let subscription = cx.subscribe_in(
                    &input,
                    window,
                    |this, input, event: &InputEvent, window, cx| match event {
                        InputEvent::PressEnter { shift: false, .. } => this.save_edit(cx),
                        InputEvent::Change => {
                            let value = input.read(cx).value();
                            if value.chars().count() > MAX_MESSAGE_LENGTH {
                                let clipped: String =
                                    value.chars().take(MAX_MESSAGE_LENGTH).collect();
                                input.update(cx, |input, cx| input.set_value(clipped, window, cx));
                            }
                        }
                        _ => {}
                    },
                );
                self.edit = Some((input, subscription));
            }
            (false, true) => self.edit = None,
            _ => {}
        }
        editing
    }

    fn view(&mut self, attachment: &Attachment, window: &mut Window, cx: &mut Context<Self>) {
        let viewable: Vec<Attachment> = self
            .message
            .attachments
            .iter()
            .filter(|a| is_viewable(a))
            .cloned()
            .collect();
        let index = viewable
            .iter()
            .position(|item| item.id == attachment.id)
            .unwrap_or(0);
        let (author, timestamp) = (self.message.author.clone(), self.message.timestamp);
        let viewer =
            cx.new(|cx| AttachmentViewer::new(viewable, index, author, timestamp, window, cx));
        let subscription = cx.subscribe(&viewer, |this, _, event: &ViewerEvent, cx| match event {
            ViewerEvent::Close => {
                this.viewer = None;
                cx.notify();
            }
        });
        self.viewer = Some((viewer, subscription));
        cx.notify();
    }

    /// The menu's items, as the dropdown and the right-click menu both show them.
    fn menu(this: WeakEntity<Self>, menu: PopupMenu, cx: &App) -> PopupMenu {
        let Some(view) = this.upgrade() else {
            return menu;
        };
        let view = view.read(cx);
        let t = theme::tokens(cx);
        let item = |label: &'static str,
                    name: &'static str,
                    action: fn(&mut MessageView, &mut Context<MessageView>)| {
            let this = this.clone();
            PopupMenuItem::new(label)
                .icon(icon(name))
                .on_click(move |_, _, cx| {
                    let _ = this.update(cx, action);
                })
        };
        let copy_text = item("Copy Text", "copy", |view, cx| view.copy_text(cx));
        if view.local_only() {
            return menu.item(copy_text);
        }
        let mine = view.is_mine(cx);
        let mut menu = menu.item(item("Reply", "reply", |_, cx| cx.emit(MessageEvent::Reply)));
        if mine {
            menu = menu.item(item("Edit Message", "pencil", |view, cx| {
                view.start_editing(cx)
            }));
        }
        menu = menu
            .item(copy_text)
            .item(item("Copy Message Link", "link", |view, cx| {
                view.copy_link(cx)
            }));
        if mine {
            let busy = view.deleting == Deleting::Busy;
            let label_source = this.clone();
            let click = this.clone();
            // the web keeps the menu open for the "You sure?" step, so the label is drawn live
            // and a click on it doesn't reach the menu (which would close it)
            menu = menu.item(
                PopupMenuItem::element(move |_, cx| {
                    let label = label_source
                        .upgrade()
                        .map_or("Delete", |view| view.read(cx).delete_label());
                    let this = label_source.clone();
                    div()
                        .id("delete-message")
                        .w_full()
                        .flex()
                        .items_center()
                        .gap_2()
                        .text_color(t.destructive)
                        .child(icon("trash").size_3())
                        .child(label)
                        .on_click(move |_, window, cx| {
                            cx.stop_propagation();
                            let shift = window.modifiers().shift;
                            let _ = this.update(cx, |view, cx| view.delete(shift, cx));
                            window.refresh();
                        })
                })
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    let shift = window.modifiers().shift;
                    let _ = click.update(cx, |view, cx| view.delete(shift, cx));
                }),
            );
        }
        let this = this.clone();
        menu.item(
            PopupMenuItem::new("Copy Message ID")
                .icon(icon("id-card-lanyard"))
                .on_click(move |_, _, cx| {
                    if let Some(view) = this.upgrade() {
                        let id = view.read(cx).message.id.clone();
                        cx.write_to_clipboard(ClipboardItem::new_string(id));
                    }
                }),
        )
    }

    fn render_toolbar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let mine = self.is_mine(cx);
        let shift = window.modifiers().shift && !Chat::global(cx).read(cx).editing_message;
        let this = cx.entity().downgrade();
        let mut toolbar = div()
            .absolute()
            .top_0()
            .right_0()
            .flex()
            .text_color(t.foreground)
            .child(
                icon_button("reply", "reply", cx)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(MessageEvent::Reply))),
            );
        if mine {
            toolbar = toolbar.child(
                icon_button("edit", "pencil", cx)
                    .on_click(cx.listener(|this, _, _, cx| this.start_editing(cx))),
            );
        }
        if shift {
            // shift shows the menu's other actions as buttons, and deletes without asking
            toolbar = toolbar
                .child(
                    icon_button("copy", "copy", cx)
                        .on_click(cx.listener(|this, _, _, cx| this.copy_text(cx))),
                )
                .child(
                    icon_button("link", "link", cx)
                        .on_click(cx.listener(|this, _, _, cx| this.copy_link(cx))),
                );
            if mine {
                toolbar = toolbar.child(
                    icon_button("delete", "trash", cx)
                        .bg(t.destructive.opacity(0.2))
                        .text_color(t.destructive)
                        .when(self.deleting == Deleting::Busy, |button| {
                            button.opacity(0.5)
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.delete(true, cx))),
                );
            }
            let id = self.message.id.clone();
            toolbar = toolbar.child(icon_button("copy-id", "id-card-lanyard", cx).on_click(
                move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(id.clone()));
                },
            ));
        } else {
            let open_change = this.clone();
            toolbar = toolbar.child(
                Button::new("actions")
                    .ghost()
                    .with_size(px(24.0))
                    .icon(icon("ellipsis"))
                    .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, cx| {
                        Self::menu(this.clone(), menu, cx)
                    })
                    .on_open_change(move |open, _, cx| {
                        let _ = open_change.update(cx, |view, cx| {
                            view.menu_open = *open;
                            cx.notify();
                        });
                    }),
            );
        }
        toolbar
    }

    fn render_attachments(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Div> {
        let attachments = self.message.attachments.clone();
        if attachments.is_empty() {
            return None;
        }
        let t = theme::tokens(cx);
        let kind =
            |attachment: &Attachment, prefix: &str| attachment.content_type.starts_with(prefix);
        let mut column = div().flex().flex_col();
        for attachment in attachments.iter().filter(|a| kind(a, "video/")) {
            let id = SharedString::from(format!("video-{}", attachment.id));
            column = column.child(
                div()
                    .mt_2()
                    .max_w(px(448.0))
                    .child(video_player(id, attachment, cx)),
            );
        }
        for attachment in attachments.iter().filter(|a| kind(a, "audio/")) {
            let id = SharedString::from(format!("audio-{}", attachment.id));
            column = column.child(div().mt_2().max_w(px(448.0)).child(audio_player(
                id,
                attachment,
                self.hovered,
                cx,
            )));
        }
        let grid: Vec<&Attachment> = attachments
            .iter()
            .filter(|a| !kind(a, "video/") && !kind(a, "audio/"))
            .collect();
        if grid.is_empty() {
            return Some(column);
        }
        let single_image = grid.len() == 1 && kind(grid[0], "image/");
        let columns = if window.viewport_size().width >= px(640.0) {
            3.0
        } else {
            2.0
        };
        let cell = (320.0 - 4.0 * (columns - 1.0)) / columns;
        let mut cells = div()
            .mt_2()
            .flex()
            .flex_wrap()
            .gap_1()
            .when(!single_image, |grid| grid.max_w(px(320.0)));
        for attachment in grid {
            let attachment = attachment.clone();
            let id = SharedString::from(format!("attachment-{}", attachment.id));
            let element = if kind(&attachment, "image/") {
                let frame = if single_image {
                    let max_width = if window.viewport_size().width >= px(640.0) {
                        320.0
                    } else {
                        280.0
                    };
                    image_box(
                        attachment.width,
                        attachment.height,
                        size(max_width, 256.0),
                        128.0,
                        size(max_width, 192.0),
                    )
                } else {
                    size(cell, cell)
                };
                let fit = if single_image {
                    ObjectFit::Contain
                } else {
                    ObjectFit::Cover
                };
                let clicked = attachment.clone();
                div()
                    .id(id)
                    .overflow_hidden()
                    .border_1()
                    .border_color(t.border)
                    .bg(t.muted.opacity(0.3))
                    .cursor_pointer()
                    .hover(|s| s.border_color(t.primary.opacity(0.5)))
                    .w(px(frame.width))
                    .h(px(frame.height))
                    .children(animated_image(&attachment.preview_url, fit, cx))
                    .tooltip({
                        let label = format!("View {}", attachment.filename);
                        move |window, cx| Tooltip::new(label.clone()).build(window, cx)
                    })
                    .on_click(
                        cx.listener(move |this, _, window, cx| this.view(&clicked, window, cx)),
                    )
                    .into_any_element()
            } else {
                let pdf = attachment.content_type == "application/pdf";
                let clicked = attachment.clone();
                let file = div()
                    .id(id)
                    .w(px(cell))
                    .flex()
                    .items_center()
                    .gap_2()
                    .p_2()
                    .border_1()
                    .border_color(t.input)
                    .bg(t.input.opacity(0.3))
                    .cursor_pointer()
                    .hover(|s| s.bg(t.input.opacity(0.5)))
                    .child(
                        div()
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .bg(t.muted)
                            .size(px(if pdf { 32.0 } else { 36.0 }))
                            .child(icon("file-text").size_4().text_color(t.primary)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(if pdf { 11.0 } else { 12.0 }))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(attachment.filename.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(if pdf { 9.0 } else { 10.0 }))
                                    .text_color(t.muted_foreground)
                                    .child(if pdf {
                                        "VIEW".to_string()
                                    } else {
                                        format_bytes(attachment.size).to_uppercase()
                                    }),
                            ),
                    );
                if pdf {
                    file.on_click(
                        cx.listener(move |this, _, window, cx| this.view(&clicked, window, cx)),
                    )
                    .into_any_element()
                } else {
                    file.child(
                        icon("download")
                            .size(px(14.0))
                            .flex_shrink_0()
                            .text_color(t.muted_foreground),
                    )
                    .on_click(move |_, _, cx| download(&clicked.url, &clicked.filename, cx))
                    .into_any_element()
                }
            };
            cells = cells.child(element);
        }
        Some(column.child(cells))
    }

    fn render_reply(
        &self,
        reply_to: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let t = theme::tokens(cx);
        let path = Chat::global(cx).read(cx).message_path(reply_to, cx);
        let preview: AnyElement = match &self.replied {
            Some(replied) => div()
                .flex()
                .min_w_0()
                .gap_1()
                .child(
                    div()
                        .flex_shrink_0()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(t.foreground.opacity(0.75))
                        .child(replied.author.name().to_string()),
                )
                .child(div().text_color(t.muted_foreground.opacity(0.4)).child("·"))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_color(t.muted_foreground)
                        .child(if replied.content.is_empty() {
                            div()
                                .truncate()
                                .child(attachment_count(replied.attachments.len()))
                                .into_any_element()
                        } else {
                            markdown(
                                SharedString::from(format!("reply-{}", self.message.id)),
                                &replied.content,
                                MarkdownOptions {
                                    inline: true,
                                    ..Default::default()
                                },
                                TextOptions::new(px(11.0), t.muted_foreground),
                                window,
                                cx,
                            )
                        }),
                )
                .into_any_element(),
            None => div()
                .italic()
                .text_color(t.muted_foreground.opacity(0.7))
                .child("Original message unavailable")
                .into_any_element(),
        };
        div()
            .id("reply")
            .mt_0p5()
            .max_w(px(672.0))
            .min_w_0()
            .flex()
            .items_start()
            .gap_1()
            .border_l_2()
            .border_color(t.primary.opacity(0.4))
            .pl_1p5()
            .text_size(px(11.0))
            .line_height(px(16.0))
            .cursor_pointer()
            .hover(|s| s.border_color(t.primary).bg(t.muted.opacity(0.4)))
            .child(
                div().mt(px(2.0)).child(
                    icon("reply")
                        .size_3()
                        .flex_shrink_0()
                        .text_color(t.primary.opacity(0.6)),
                ),
            )
            .child(preview)
            .on_click(move |_, _, cx| router::goto(&path, cx))
    }
}

impl Render for MessageView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let message = self.message.clone();
        let editing = self.sync_editing(window, cx);
        let chat = Chat::global(cx).read(cx);
        let flashing = chat.active_message(cx).as_deref() == Some(message.id.as_str());
        let in_guild = matches!(chat.route(cx), ChatRoute::Guild { .. });
        let channel_id = chat.active_channel(cx).unwrap_or_default();
        let mine = self.is_mine(cx);
        let my_handle = Session::user(cx)
            .map(|user| user.handle)
            .unwrap_or_default();
        let mentioned = mentions_me(&message, self.replied.as_ref(), &my_handle, in_guild, mine);
        let time_format = SettingsStore::get(cx).time_format;
        let author_name = message.author.name().to_string();
        let on_call: OnCall = Rc::new(|id, _, cx| ShellState::start_call(id, cx));
        let narrow = window.viewport_size().width < px(640.0);
        let amber = amber();

        let avatar_column = if self.grouped {
            div().w_9().flex_shrink_0().into_any_element()
        } else {
            let picture = avatar(
                message.author.avatar_url.as_deref(),
                &author_name,
                message.author.avatar_color.as_deref(),
                36.0,
                cx,
            )
            .when(message.interaction.is_some(), |avatar| avatar.mt_5())
            .when(message.interaction.is_none(), |avatar| avatar.mt_0p5());
            div()
                .flex_shrink_0()
                .child(profile_card(
                    SharedString::from(format!("avatar-{}", message.id)),
                    message.author.clone(),
                    Some(on_call.clone()),
                    picture,
                ))
                .into_any_element()
        };

        let mut content = div().flex().flex_col().flex_1().min_w_0();
        if let Some(interaction) = &message.interaction {
            content = content.child(
                div()
                    .mb_0p5()
                    .flex()
                    .min_w_0()
                    .items_center()
                    .gap_1()
                    .text_size(px(11.0))
                    .line_height(px(16.0))
                    .text_color(t.muted_foreground)
                    .child(
                        icon("square-slash")
                            .size_3()
                            .flex_shrink_0()
                            .text_color(t.primary.opacity(0.7)),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .truncate()
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(t.foreground.opacity(0.75))
                                    .child(interaction.user.name().to_string()),
                            )
                            .child("used")
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(t.foreground.opacity(0.75))
                                    .child(format!("/{}", interaction.name)),
                            ),
                    ),
            );
        }
        if !self.grouped {
            let time = format_time(&message.timestamp.with_timezone(&Local), time_format);
            content = content.child(
                div()
                    .flex()
                    .items_baseline()
                    .gap_2()
                    .child(profile_card(
                        SharedString::from(format!("name-{}", message.id)),
                        message.author.clone(),
                        Some(on_call),
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(t.foreground)
                            .cursor_pointer()
                            .hover(|s| s.underline())
                            .child(author_name.clone()),
                    ))
                    .when(message.author.is_bot, |row| {
                        row.child(bot_badge("bot", cx).self_center())
                    })
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(t.muted_foreground)
                            .child(time),
                    ),
            );
        }
        if let Some(reply_to) = &message.reply_to {
            content = content.child(self.render_reply(reply_to, window, cx));
        }

        if editing {
            if let Some((input, _)) = &self.edit {
                let saving = self.saving;
                content = content.child(
                    div()
                        .mt_1()
                        .max_w(px(672.0))
                        .flex()
                        .flex_col()
                        .gap_1p5()
                        .child(Textarea::new(input).text_sm())
                        .child(
                            div()
                                .flex()
                                .gap_1p5()
                                .child(
                                    Button::new("save-edit")
                                        .primary()
                                        .xsmall()
                                        .disabled(saving)
                                        .label(if saving { "Saving..." } else { "Save" })
                                        .on_click(cx.listener(|this, _, _, cx| this.save_edit(cx))),
                                )
                                .child(
                                    Button::new("cancel-edit")
                                        .ghost()
                                        .xsmall()
                                        .label("Cancel")
                                        .on_click(|_, _, cx| {
                                            Chat::global(cx).update(cx, |chat, cx| {
                                                chat.set_editing_message(None, cx)
                                            });
                                        }),
                                ),
                        ),
                );
            }
        } else if !message.content.trim().is_empty()
            || (message.edited && message.embeds.is_empty())
        {
            let trailing = message.edited.then(|| {
                let when = message
                    .edited_time
                    .as_deref()
                    .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
                    .map(|time| {
                        let time = time.with_timezone(&Local);
                        format!(
                            "{} at {}",
                            format_date(&time, &Local::now()).to_lowercase(),
                            format_time(&time, time_format)
                        )
                    })
                    .unwrap_or_default();
                ("(edited)".to_string(), when)
            });
            let body = if message.content.trim().is_empty() {
                String::new()
            } else {
                message.content.clone()
            };
            content = content.child(div().line_height(relative(1.625)).child(markdown(
                SharedString::from(format!("content-{}", message.id)),
                &body,
                MarkdownOptions {
                    links: true,
                    trailing,
                    ..Default::default()
                },
                TextOptions::new(px(14.0), t.foreground.opacity(0.9)),
                window,
                cx,
            )));
        }
        if message.thinking {
            content = content.child(
                div()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .text_sm()
                    .text_color(t.muted_foreground)
                    .child(crate::ui::spinner("thinking"))
                    .child(format!("{author_name} is thinking…")),
            );
        }
        for (index, embed) in message.embeds.iter().enumerate() {
            content = content.child(message_embed(
                SharedString::from(format!("embed-{}-{index}", message.id)),
                embed,
                window,
                cx,
            ));
        }
        if !message.components.is_empty() {
            let this = cx.entity().downgrade();
            content = content.child(message_components(
                SharedString::from(format!("components-{}", message.id)),
                &message.components,
                &channel_id,
                &message.id,
                self.components_error.as_deref(),
                Rc::new(move |error, cx| {
                    let _ = this.update(cx, |view, cx| {
                        view.components_error = error;
                        cx.notify();
                    });
                }),
                cx,
            ));
        }
        if message.ephemeral && !message.thinking {
            let (channel_id, message_id) = (channel_id.clone(), message.id.clone());
            content = content.child(
                div()
                    .mt_1()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .text_size(px(11.0))
                    .text_color(t.muted_foreground)
                    .child(icon("eye-off").size_3())
                    .child("Only you can see this")
                    .child(
                        div()
                            .id("dismiss")
                            .text_color(t.link)
                            .cursor_pointer()
                            .hover(|s| s.underline())
                            .child("Dismiss")
                            .on_click(move |_, _, cx| {
                                Chat::global(cx).update(cx, |chat, cx| {
                                    chat.remove_message(&channel_id, &message_id, cx)
                                });
                            }),
                    ),
            );
        }
        if let Some(attachments) = self.render_attachments(window, cx) {
            content = content.child(attachments);
        }

        let show_toolbar = (self.hovered || self.menu_open) && !self.local_only();
        let toolbar = show_toolbar.then(|| self.render_toolbar(window, cx));
        let this = cx.entity().downgrade();
        let row = div()
            .id(SharedString::from(message.id.clone()))
            .relative()
            .flex()
            .gap_3()
            .px(if narrow { px(12.0) } else { px(16.0) })
            .py_0p5()
            .when(mentioned, |row| {
                row.bg(amber.opacity(0.1))
                    .hover(|s| s.bg(amber.opacity(0.15)))
            })
            .when(!mentioned, |row| row.hover(|s| s.bg(t.muted.opacity(0.3))))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.hovered = *hovered;
                cx.notify();
            }))
            .when(flashing, |row| {
                let primary = t.primary;
                row.child(div().absolute().inset_0().with_animation(
                    SharedString::from(format!("flash-{}", message.id)),
                    Animation::new(Duration::from_millis(1500)),
                    move |overlay, delta| {
                        let strength = if delta < 0.2 {
                            1.0
                        } else {
                            1.0 - ease_out_quad((delta - 0.2) / 0.8)
                        };
                        overlay.bg(primary.opacity(0.18 * strength))
                    },
                ))
            })
            .when(mentioned, |row| {
                row.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .w_0p5()
                        .bg(amber),
                )
            })
            .child(avatar_column)
            .child(content)
            .children(toolbar)
            .context_menu(move |menu, _, cx| Self::menu(this.clone(), menu, cx));

        div()
            .child(row)
            .children(self.viewer.as_ref().map(|(viewer, _)| viewer.clone()))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use gpui_kit::size;

    use super::{attachment_count, image_box, mentions_me, message_link};
    use crate::models::{Author, Message};

    fn author(username: &str) -> Author {
        Author {
            user_id: username.into(),
            username: username.into(),
            server: "x.com".into(),
            display_name: None,
            avatar_url: None,
            avatar_color: None,
            speaking_ring_color: None,
            banner_url: None,
            about: None,
            is_bot: false,
            status: None,
        }
    }

    fn message(from: &str, content: &str) -> Message {
        Message {
            id: "m".into(),
            author: author(from),
            content: content.into(),
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

    #[test]
    fn highlights_messages_that_mention_me() {
        let me = "@me:x.com";
        assert!(mentions_me(
            &message("ana", "hey @ME:x.com"),
            None,
            me,
            false,
            false
        ));
        assert!(mentions_me(
            &message("ana", "@everyone"),
            None,
            me,
            true,
            false
        ));
        assert!(!mentions_me(
            &message("ana", "@everyone"),
            None,
            me,
            false,
            false
        ));
        assert!(mentions_me(
            &message("ana", "sure"),
            Some(&message("me", "q?")),
            me,
            false,
            false
        ));
        assert!(!mentions_me(
            &message("me", "@me:x.com"),
            None,
            me,
            true,
            true
        ));
        assert!(!mentions_me(
            &message("ana", "hello"),
            None,
            me,
            true,
            false
        ));
    }

    #[test]
    fn sizes_single_images_into_their_box() {
        let max = size(320.0, 256.0);
        assert_eq!(
            image_box(Some(640), Some(256), max, 128.0, max),
            size(320.0, 128.0)
        );
        assert_eq!(
            image_box(Some(100), Some(100), max, 128.0, max),
            size(128.0, 100.0)
        );
        assert_eq!(
            image_box(None, Some(5), max, 128.0, size(1.0, 1.0)),
            size(1.0, 1.0)
        );
    }

    #[test]
    fn labels_and_links() {
        assert_eq!(attachment_count(1), "1 attachment");
        assert_eq!(attachment_count(3), "3 attachments");
        assert_eq!(message_link("/guilds/g/c/m"), "app://novarum/guilds/g/c/m");
    }
}

fn ease_out_quad(t: f32) -> f32 {
    1.0 - (1.0 - t) * (1.0 - t)
}
