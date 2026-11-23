// Port of apps/frontend/src/lib/components/group-settings-dialog.svelte
use std::rc::Rc;

use gpui_kit::component::{
    WindowExt,
    input::{Input, InputEvent, InputState},
};

use crate::{
    prelude::*,
    state::{
        bots::parse_bot_handle,
        chat::UploadFile,
        dms::{DmEntry, Dms, dm_display},
    },
    views::{
        avatar_crop_dialog::{CropOptions, open_avatar_crop},
        profile_card::bot_badge,
    },
};

const ICON_TYPES: [&str; 4] = ["image/gif", "image/jpeg", "image/png", "image/webp"];

/// Only the group's owner opens this; the server checks it again anyway.
pub fn open_group_settings(group_id: String, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| GroupSettingsDialog::new(group_id, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog
            .title("Group Settings")
            .w(px(448.0))
            .child(view.clone())
    });
}

pub struct GroupSettingsDialog {
    group_id: String,
    name: Entity<InputState>,
    bot_handle: Entity<InputState>,
    message: Option<(bool, String)>,
    busy: bool,
    _subscriptions: Vec<Subscription>,
}

impl GroupSettingsDialog {
    fn new(group_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let current = Dms::global(cx)
            .read(cx)
            .get(&group_id)
            .and_then(|group| group.name.clone())
            .unwrap_or_default();
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Members' names")
                .default_value(current)
        });
        let bot_handle = cx.new(|cx| InputState::new(window, cx).placeholder("@bot:homeserver"));
        let _subscriptions = vec![
            cx.observe(&Dms::global(cx), |_, _, cx| cx.notify()),
            cx.subscribe_in(
                &name,
                window,
                |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::PressEnter { .. } => this.save_name(window, cx),
                    _ => cx.notify(),
                },
            ),
            cx.subscribe_in(
                &bot_handle,
                window,
                |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::PressEnter { .. } => this.add_bot(window, cx),
                    _ => cx.notify(),
                },
            ),
        ];
        Self {
            group_id,
            name,
            bot_handle,
            message: None,
            busy: false,
            _subscriptions,
        }
    }

    fn group(&self, cx: &App) -> Option<DmEntry> {
        Dms::global(cx).read(cx).get(&self.group_id).cloned()
    }

    /// `run`: one request at a time, its error or `done` shown under the form.
    fn run(
        &mut self,
        task: Task<Result<(), String>>,
        done: String,
        on_ok: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.busy = true;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.message = Some(match result {
                    Ok(()) => {
                        on_ok(this, window, cx);
                        (true, done)
                    }
                    Err(error) => (false, error),
                });
                cx.notify();
            });
        })
        .detach();
    }

    fn save_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.name.read(cx).value().trim().to_string();
        let task = Dms::global(cx).read(cx).rename(&self.group_id, &name, cx);
        self.run(task, "Saved.".into(), |_, _, _| {}, window, cx);
    }

    fn add_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((username, homeserver)) = parse_bot_handle(&self.bot_handle.read(cx).value())
        else {
            self.message = Some((false, "Use a full handle, like @name:server.".into()));
            cx.notify();
            return;
        };
        let task = Dms::global(cx)
            .read(cx)
            .add_bot(&self.group_id, &username, &homeserver, cx);
        let done = format!("Added @{username}:{homeserver}.");
        self.run(
            task,
            done,
            |this, window, cx| {
                this.bot_handle
                    .update(cx, |input, cx| input.set_value("", window, cx))
            },
            window,
            cx,
        );
    }

    fn kick(&mut self, user_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let task = Dms::global(cx).read(cx).kick(&self.group_id, user_id, cx);
        self.run(task, "Bot removed.".into(), |_, _, _| {}, window, cx);
    }

    fn upload_icon(&mut self, icon: UploadFile, window: &mut Window, cx: &mut Context<Self>) {
        let task = Dms::global(cx)
            .read(cx)
            .upload_icon(&self.group_id, icon, cx);
        self.run(task, "Icon updated.".into(), |_, _, _| {}, window, cx);
    }

    /// `selectPicture`: GIFs go up as they are, everything else through the crop dialog.
    fn select_picture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(file) = paths
                .first()
                .and_then(|path| UploadFile::from_path(path).ok())
            else {
                return;
            };
            let _ = this.update_in(cx, |this, window, cx| {
                if !ICON_TYPES.contains(&file.content_type.as_str()) {
                    this.message = Some((false, "Choose a GIF, JPEG, PNG, or WebP image.".into()));
                    cx.notify();
                    return;
                }
                if file.content_type == "image/gif" {
                    let icon = UploadFile {
                        name: "group-icon.gif".into(),
                        ..file
                    };
                    return this.upload_icon(icon, window, cx);
                }
                let view = cx.entity().downgrade();
                let options = CropOptions {
                    title: "Crop Group Icon".into(),
                    description: "Adjust the image to fit the group icon.".into(),
                    action_label: "Use Icon".into(),
                    ..Default::default()
                };
                let on_crop = Rc::new(move |bytes: Vec<u8>, window: &mut Window, cx: &mut App| {
                    let icon = UploadFile {
                        name: "group-icon.png".into(),
                        content_type: "image/png".into(),
                        bytes,
                    };
                    let _ = view.update(cx, |this, cx| this.upload_icon(icon, window, cx));
                });
                open_avatar_crop(file.bytes, options, on_crop, window, cx);
            });
        })
        .detach();
    }
}

impl Render for GroupSettingsDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let Some(group) = self.group(cx) else {
            return div();
        };
        let name = self.name.read(cx).value().trim().to_string();
        let unchanged = name == group.name.clone().unwrap_or_default();
        let bot_empty = self.bot_handle.read(cx).value().trim().is_empty();
        let busy = self.busy;

        let icon_picker = div()
            .id("group-icon")
            .group("group-icon")
            .relative()
            .size_16()
            .flex_shrink_0()
            .overflow_hidden()
            .rounded_full()
            .child(
                ui::avatar::avatar(
                    group.icon_url.as_deref(),
                    &dm_display(&group).name,
                    None,
                    64.0,
                    cx,
                )
                .rounded_full(),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(white())
                    .hover(|s| s.bg(black().opacity(0.55)))
                    .child(
                        div()
                            .opacity(0.0)
                            .group_hover("group-icon", |s| s.opacity(1.0))
                            .child(icon("camera").size_4()),
                    ),
            )
            .when(!busy, |picker| {
                picker
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, window, cx| this.select_picture(window, cx)))
            });

        let bots: Vec<_> = group
            .participants
            .iter()
            .filter(|user| user.is_bot)
            .map(|bot| {
                let user_id = bot.user_id.clone();
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_sm()
                    .child(ui::avatar::avatar(
                        bot.avatar_url.as_deref(),
                        bot.name(),
                        bot.avatar_color.as_deref(),
                        24.0,
                        cx,
                    ))
                    .child(div().truncate().child(bot.name().to_string()))
                    .child(bot_badge(cx))
                    .child(div().flex_1())
                    .child(
                        Button::new(SharedString::from(format!("kick-{user_id}")))
                            .ghost()
                            .icon(icon("trash"))
                            .tooltip(format!("Remove {}", bot.username))
                            .disabled(busy)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.kick(&user_id, window, cx)
                            })),
                    )
            })
            .collect();

        div()
            .flex()
            .flex_col()
            .gap_5()
            .child(ui::muted("Everyone in the group sees these changes.", cx))
            .child(
                div().flex().items_end().gap_4().child(icon_picker).child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(6.0))
                        .child(ui::label("Group name"))
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .child(div().flex_1().child(Input::new(&self.name).text_xs()))
                                .child(
                                    Button::new("save")
                                        .primary()
                                        .label("Save")
                                        .disabled(busy || unchanged)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.save_name(window, cx)
                                        })),
                                ),
                        ),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(ui::label("Bots"))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(div().flex_1().child(Input::new(&self.bot_handle).text_xs()))
                            .child(
                                Button::new("add-bot")
                                    .primary()
                                    .label("Add")
                                    .disabled(busy || bot_empty)
                                    .on_click(
                                        cx.listener(|this, _, window, cx| this.add_bot(window, cx)),
                                    ),
                            ),
                    )
                    .children(bots),
            )
            .children(self.message.clone().map(|(ok, text)| {
                div()
                    .text_xs()
                    .text_color(if ok {
                        t.muted_foreground
                    } else {
                        t.destructive
                    })
                    .child(text)
            }))
    }
}
