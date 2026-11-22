// Port of apps/frontend/src/lib/components/video-player.svelte. gpui can't decode or play video,
// so this draws the attachment's poster (the homeserver's preview frame) with a play button that
// opens the video in the system's player through the browser, plus the download button the web
// put in the control bar.
use crate::prelude::*;

use crate::{desktop, models::Attachment, views::attachment_viewer::download};

pub fn video_player(
    id: impl Into<ElementId>,
    attachment: &Attachment,
    cx: &mut App,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let t = theme::tokens(cx);
    let poster = crate::ui::image::remote_img(&attachment.preview_url, cx);
    let (url, download_url, filename) = (
        attachment.url.clone(),
        attachment.url.clone(),
        attachment.filename.clone(),
    );
    let radius = if t.radius > px(0.0) { px(8.0) } else { px(0.0) };
    div()
        .id(id.clone())
        .group("video")
        .relative()
        .w_full()
        .h(px(252.0))
        .overflow_hidden()
        .rounded(radius)
        .border_1()
        .border_color(t.border)
        .bg(black())
        .cursor_pointer()
        .children(poster.map(|poster| poster.object_fit(ObjectFit::Contain)))
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .flex()
                        .size_12()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .bg(t.popover.opacity(0.85))
                        .border_1()
                        .border_color(t.border)
                        .text_color(t.foreground)
                        .group_hover("video", |s| s.bg(t.popover))
                        .child(icon("play").size_5()),
                ),
        )
        .child(
            div()
                .id((id, SharedString::from("download")))
                .absolute()
                .bottom_2()
                .right_2()
                .flex()
                .size_8()
                .items_center()
                .justify_center()
                .rounded(t.radius)
                .bg(t.popover.opacity(0.85))
                .border_1()
                .border_color(t.border)
                .text_color(t.foreground)
                .hover(|s| s.bg(t.popover))
                .child(icon("download").size_4())
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    download(&download_url, &filename, cx);
                }),
        )
        .on_click(move |_, _, cx| desktop::open_url(&url, cx))
}
