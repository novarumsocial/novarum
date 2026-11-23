// Port of apps/frontend/src/lib/components/attachment-viewer.svelte: a message's attachments full
// window, one at a time. Images zoom (click, wheel, ctrl+wheel pinch) and pan by dragging, through
// util::zoom_pan (the web scrolled a wider <img> instead; the feel is the same). Videos show their
// poster and open externally, PDFs open externally (no iframe in gpui), audio plays inline.
use std::{cell::Cell, rc::Rc};

use chrono::{DateTime, Local, Utc};
use gpui_kit::component::{TITLE_BAR_HEIGHT, tooltip::Tooltip};

use crate::prelude::*;

use crate::{
    api, desktop,
    models::{Attachment, Author},
    state::settings::SettingsStore,
    ui::avatar::avatar,
    util::{
        format_date::{format_date, format_time},
        utils::format_bytes,
        zoom_pan::ZoomPan,
    },
    views::{audio_player::audio_player, video_player::video_player},
};

/// Saves `url` where the person picks, starting in their downloads folder.
pub fn download(url: &str, filename: &str, cx: &mut App) {
    let directory = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_default();
    let path = cx.prompt_for_new_path(&directory, Some(filename));
    let url = url.to_string();
    cx.spawn(async move |_| {
        let Ok(Ok(Some(path))) = path.await else {
            return;
        };
        if let Ok(bytes) = api::fetch_bytes(url).await {
            let _ = std::fs::write(path, bytes);
        }
    })
    .detach();
}

pub fn is_viewable(attachment: &Attachment) -> bool {
    let kind = attachment.content_type.as_str();
    kind.starts_with("image/")
        || kind.starts_with("video/")
        || kind.starts_with("audio/")
        || kind == "application/pdf"
}

/// Where an image of `natural` size sits when fitted (`object-contain`) in `area`.
pub fn fitted(area: Size<f32>, natural: Size<f32>) -> Bounds<f32> {
    if natural.width <= 0.0 || natural.height <= 0.0 {
        return Bounds {
            origin: point(0.0, 0.0),
            size: area,
        };
    }
    let scale = (area.width / natural.width).min(area.height / natural.height);
    let size = size(natural.width * scale, natural.height * scale);
    Bounds {
        origin: point(
            (area.width - size.width) / 2.0,
            (area.height - size.height) / 2.0,
        ),
        size,
    }
}

pub enum ViewerEvent {
    Close,
}

impl EventEmitter<ViewerEvent> for AttachmentViewer {}

pub struct AttachmentViewer {
    attachments: Vec<Attachment>,
    index: usize,
    author: Author,
    timestamp: DateTime<Utc>,
    plain: bool,
    zoom: ZoomPan,
    /// the stage's bounds as last painted, for turning window positions into stage ones
    stage: Rc<Cell<Bounds<Pixels>>>,
    pointer: Option<Point<Pixels>>,
    focus: FocusHandle,
}

impl AttachmentViewer {
    pub fn new(
        attachments: Vec<Attachment>,
        index: usize,
        author: Author,
        timestamp: DateTime<Utc>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            attachments,
            index,
            author,
            timestamp,
            plain: false,
            zoom: ZoomPan::new(8.0),
            stage: Rc::default(),
            pointer: None,
            focus,
        }
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(ViewerEvent::Close);
    }

    fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        self.index = index % self.attachments.len().max(1);
        self.zoom.reset();
        cx.notify();
    }

    fn step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let count = self.attachments.len();
        if count > 1 {
            self.select(
                if forward {
                    self.index + 1
                } else {
                    self.index + count - 1
                },
                cx,
            );
        }
    }

    fn current(&self) -> Option<&Attachment> {
        self.attachments.get(self.index)
    }

    fn is_image(&self) -> bool {
        self.current()
            .is_some_and(|attachment| attachment.content_type.starts_with("image/"))
    }

    fn local(&self, position: Point<Pixels>) -> (f32, f32) {
        let origin = self.stage.get().origin;
        (
            f32::from(position.x - origin.x),
            f32::from(position.y - origin.y),
        )
    }

    fn on_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "escape" if self.zoom.zoomed() => {
                self.zoom.reset();
                cx.notify();
            }
            "escape" => self.close(cx),
            "left" if !self.zoom.zoomed() => self.step(false, cx),
            "right" if !self.zoom.zoomed() => self.step(true, cx),
            _ => {}
        }
        // the viewer is modal: keys don't reach the chat behind it
        cx.stop_propagation();
    }

    fn on_wheel(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        if !self.is_image() {
            return;
        }
        let (x, y) = self.local(event.position);
        let delta = f32::from(event.delta.pixel_delta(px(16.0)).y);
        // gpui's wheel deltas point the other way from the DOM's deltaY
        self.zoom.wheel(x, y, -delta, event.modifiers.control);
        cx.notify();
    }

    fn on_down(&mut self, event: &MouseDownEvent, _: &mut Context<Self>) {
        self.pointer = Some(event.position);
        self.zoom.moved = false;
    }

    fn on_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(last) = self.pointer else { return };
        if event.pressed_button != Some(MouseButton::Left) || !self.zoom.zoomed() {
            return;
        }
        let delta = event.position - last;
        self.pointer = Some(event.position);
        if delta.x.abs() + delta.y.abs() > px(0.0) {
            self.zoom.moved = true;
            self.zoom.pan(f32::from(delta.x), f32::from(delta.y));
            cx.notify();
        }
    }

    /// A click (no drag): zooms into the image, out of it, or closes from the backdrop.
    fn on_up(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) {
        if self.pointer.take().is_none() || self.zoom.moved {
            return;
        }
        if self.zoom.zoomed() {
            self.zoom.reset();
            return cx.notify();
        }
        let Some(attachment) = self.current().filter(|_| self.is_image()) else {
            return;
        };
        let (x, y) = self.local(event.position);
        let natural = size(
            attachment.width.unwrap_or(0) as f32,
            attachment.height.unwrap_or(0) as f32,
        );
        if fitted(size(self.zoom.width, self.zoom.height), natural).contains(&point(x, y)) {
            self.zoom.zoom_at(x, y, 2.0);
            cx.notify();
        } else {
            self.close(cx);
        }
    }

    fn action(
        &self,
        id: &'static str,
        label: &'static str,
        name: &'static str,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let t = theme::tokens(cx);
        div()
            .id(id)
            .flex()
            .size_8()
            .items_center()
            .justify_center()
            .rounded(t.radius)
            .cursor_pointer()
            .hover(|s| s.bg(t.muted))
            .child(icon(name).size_4())
            .tooltip(move |window, cx| Tooltip::new(label).build(window, cx))
    }

    fn render_header(&self, attachment: &Attachment, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let name = self.author.name().to_string();
        let local = self.timestamp.with_timezone(&Local);
        let when = format!(
            "{} at {}",
            format_date(&local, &Local::now()),
            format_time(&local, SettingsStore::get(cx).time_format)
        );
        let (open_url, download_url, filename) = (
            attachment.url.clone(),
            attachment.url.clone(),
            attachment.filename.clone(),
        );
        div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap_3()
            .p_3()
            .px_4()
            .when(!self.plain, |header| {
                header
                    .child(avatar(
                        self.author.avatar_url.as_deref(),
                        &name,
                        self.author.avatar_color.as_deref(),
                        36.0,
                        cx,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap_2()
                                    .child(
                                        div()
                                            .truncate()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(name),
                                    )
                                    .child(
                                        div()
                                            .flex_shrink_0()
                                            .text_size(px(11.0))
                                            .text_color(t.muted_foreground)
                                            .child(when),
                                    ),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(11.0))
                                    .text_color(t.muted_foreground)
                                    .child(format!(
                                        "{}, {}",
                                        attachment.filename,
                                        format_bytes(attachment.size)
                                    )),
                            ),
                    )
            })
            .child(
                div()
                    .ml_auto()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .child(
                        self.action("viewer-open", "Open in browser", "external-link", cx)
                            .on_click(move |_, _, cx| desktop::open_url(&open_url, cx)),
                    )
                    .child(
                        self.action("viewer-download", "Download", "download", cx)
                            .on_click(move |_, _, cx| download(&download_url, &filename, cx)),
                    )
                    .child(
                        self.action("viewer-close", "Close", "x", cx)
                            .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                    ),
            )
    }

    fn render_item(&self, attachment: &Attachment, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let kind = attachment.content_type.as_str();
        if kind.starts_with("image/") {
            let image = crate::ui::image::remote(&attachment.url, cx).ok().flatten();
            let Some(image) = image else {
                return div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(crate::ui::spinner("viewer-loading"))
                    .into_any_element();
            };
            let zoom = self.zoom;
            return div()
                .size_full()
                .relative()
                .when(zoom.zoomed(), |stage| stage.bg(t.background.opacity(0.8)))
                .child(
                    div()
                        .absolute()
                        .left(px(zoom.x))
                        .top(px(zoom.y))
                        .w(px(zoom.width * zoom.scale))
                        .h(px(zoom.height * zoom.scale))
                        .child(img(image).size_full().object_fit(ObjectFit::Contain)),
                )
                .into_any_element();
        }
        let centered = div().size_full().flex().items_center().justify_center();
        if kind.starts_with("video/") {
            return centered
                .child(div().w_full().max_w(px(896.0)).child(video_player(
                    "viewer-video",
                    attachment,
                    cx,
                )))
                .into_any_element();
        }
        if kind.starts_with("audio/") {
            return centered
                .child(div().w_full().max_w(px(576.0)).child(audio_player(
                    "viewer-audio",
                    attachment,
                    false,
                    cx,
                )))
                .into_any_element();
        }
        let url = attachment.url.clone();
        centered
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_3()
                    .p_6()
                    .border_1()
                    .border_color(t.border)
                    .bg(t.card)
                    .rounded(t.radius)
                    .child(icon("file-text").size_8().text_color(t.primary))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(attachment.filename.clone()),
                    )
                    .child(
                        Button::new("viewer-open-pdf")
                            .primary()
                            .label("Open")
                            .on_click(move |_, _, cx| desktop::open_url(&url, cx)),
                    ),
            )
            .into_any_element()
    }

    fn render_thumbnails(&self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let mut nav = div()
            .flex()
            .flex_shrink_0()
            .justify_center()
            .gap_1p5()
            .px_3()
            .pb_3();
        for (index, item) in self.attachments.iter().enumerate() {
            let kind = item.content_type.as_str();
            let content = if kind.starts_with("image/") {
                crate::ui::image::remote_img(&item.preview_url, cx)
                    .map(|image| image.object_fit(ObjectFit::Cover).into_any_element())
                    .unwrap_or_else(|| div().into_any_element())
            } else {
                let name = if kind.starts_with("video/") {
                    "video"
                } else if kind.starts_with("audio/") {
                    "music"
                } else {
                    "file-text"
                };
                icon(name)
                    .size_4()
                    .text_color(t.muted_foreground)
                    .into_any_element()
            };
            let selected = index == self.index;
            nav = nav.child(
                div()
                    .id(("viewer-thumb", index))
                    .flex()
                    .size_11()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .bg(t.muted)
                    .cursor_pointer()
                    .when(!selected, |thumb| {
                        thumb.opacity(0.4).hover(|s| s.opacity(0.8))
                    })
                    .when(selected, |thumb| thumb.border_2().border_color(t.primary))
                    .child(content)
                    .on_click(cx.listener(move |this, _, _, cx| this.select(index, cx))),
            );
        }
        nav
    }
}

impl Render for AttachmentViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let viewport = window.viewport_size();
        let Some(attachment) = self.current().cloned() else {
            return div().into_any_element();
        };
        let stage = self.stage.get();
        self.zoom.width = f32::from(stage.size.width);
        self.zoom.height = f32::from(stage.size.height);
        let several = self.attachments.len() > 1;
        let arrow = |id: &'static str, name: &'static str| {
            div()
                .id(id)
                .absolute()
                .top(relative(0.5))
                .mt(px(-18.0))
                .flex()
                .size_9()
                .items_center()
                .justify_center()
                .rounded(t.radius)
                .bg(t.background.opacity(0.6))
                .cursor_pointer()
                .hover(|s| s.bg(t.muted))
                .child(icon(name).size_4())
        };
        let record = {
            let stage = self.stage.clone();
            canvas(move |bounds, _, _| stage.set(bounds), |_, _, _, _| {})
                .absolute()
                .inset_0()
        };

        let body = div()
            .id("viewer-stage")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .when(!self.zoom.zoomed(), |stage| {
                stage
                    .mx(if viewport.width < px(640.0) {
                        px(12.0)
                    } else {
                        px(80.0)
                    })
                    .mb_6()
            })
            .child(record)
            .child(self.render_item(&attachment, cx))
            .on_scroll(cx.listener(|this, event, _, cx| this.on_wheel(event, cx)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event, _, cx| this.on_down(event, cx)),
            )
            .on_mouse_move(cx.listener(|this, event, _, cx| this.on_move(event, cx)))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, event, _, cx| this.on_up(event, cx)),
            );

        let content =
            div()
                .id("attachment-viewer")
                .track_focus(&self.focus)
                .on_key_down(cx.listener(|this, event, _, cx| this.on_key(event, cx)))
                .occlude()
                .relative()
                .flex()
                .flex_col()
                .w(viewport.width)
                .h(viewport.height - TITLE_BAR_HEIGHT)
                .bg(black().opacity(0.5))
                .text_color(t.foreground)
                .child(div().absolute().inset_0().bg(t.background.opacity(0.4)))
                .child(self.render_header(&attachment, cx))
                .child(
                    div()
                        .relative()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_h_0()
                        .child(body)
                        .when(
                            several && viewport.width >= px(640.0) && !self.zoom.zoomed(),
                            |stage| {
                                stage
                                    .child(
                                        arrow("viewer-previous", "arrow-left").left_4().on_click(
                                            cx.listener(|this, _, _, cx| this.step(false, cx)),
                                        ),
                                    )
                                    .child(arrow("viewer-next", "arrow-right").right_4().on_click(
                                        cx.listener(|this, _, _, cx| this.step(true, cx)),
                                    ))
                            },
                        ),
                )
                .when(several, |content| content.child(self.render_thumbnails(cx)));

        deferred(
            anchored()
                .position(point(px(0.0), TITLE_BAR_HEIGHT))
                .child(content),
        )
        .with_priority(2)
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::{point, size};

    use super::fitted;

    #[test]
    fn fits_images_inside_the_stage() {
        let wide = fitted(size(400.0, 300.0), size(800.0, 200.0));
        assert_eq!(
            (wide.origin, wide.size),
            (point(0.0, 100.0), size(400.0, 100.0))
        );
        let tall = fitted(size(400.0, 300.0), size(100.0, 300.0));
        assert_eq!(
            (tall.origin, tall.size),
            (point(150.0, 0.0), size(100.0, 300.0))
        );
        let unknown = fitted(size(400.0, 300.0), size(0.0, 0.0));
        assert_eq!(unknown.size, size(400.0, 300.0));
    }
}
