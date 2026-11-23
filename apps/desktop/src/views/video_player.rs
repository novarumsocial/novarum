// Port of apps/frontend/src/lib/components/video-player.svelte. Plays inline through libmpv
// (`media::Media`); until it's started, or without libmpv (which opens it externally instead), it
// shows the homeserver's preview frame with a play button. The controls stand in for video.js's
// skin: play/pause, seek, time, mute and the download button the web adds to the bar.
use crate::prelude::*;

use crate::{
    desktop,
    media::{self, Media},
    models::Attachment,
    ui::drag::{DragPhase, drag_surface, fraction},
    views::attachment_viewer::download,
};

fn clock(seconds: f64) -> String {
    let seconds = seconds.max(0.0) as u64;
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

pub fn video_player(
    id: impl Into<ElementId>,
    attachment: &Attachment,
    cx: &mut App,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let t = theme::tokens(cx);
    let radius = if t.radius > px(0.0) { px(8.0) } else { px(0.0) };
    let playing = Media::global(cx).read(cx).playing(&attachment.id);
    let (key, url) = (attachment.id.clone(), attachment.url.clone());

    let button = |id: ElementId, name: &'static str| {
        div()
            .id(id)
            .flex()
            .size_8()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .rounded(t.radius)
            .text_color(t.foreground)
            .hover(|button| button.bg(t.accent))
            .child(icon(name).size_4())
    };
    let download_button = {
        let (url, filename) = (attachment.url.clone(), attachment.filename.clone());
        button(
            (id.clone(), SharedString::from("download")).into(),
            "download",
        )
        .on_click(move |_, _, cx| {
            cx.stop_propagation();
            download(&url, &filename, cx);
        })
    };

    let player = div()
        .id(id.clone())
        .group("video")
        .relative()
        .w_full()
        .h(px(252.0))
        .overflow_hidden()
        .rounded(radius)
        .border_1()
        .border_color(t.border)
        .bg(black());

    let Some((frame, state)) = playing else {
        let poster = crate::ui::image::remote_img(&attachment.preview_url, cx);
        return player
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
                    .absolute()
                    .bottom_2()
                    .right_2()
                    .bg(t.popover.opacity(0.85))
                    .border_1()
                    .border_color(t.border)
                    .rounded(t.radius)
                    .child(download_button),
            )
            .on_click(move |_, _, cx| {
                let started = media::available()
                    && Media::global(cx)
                        .update(cx, |media, cx| media.play(&key, &url, cx))
                        .inspect_err(|error| eprintln!("Could not play the video: {error}"))
                        .is_ok();
                if !started {
                    desktop::open_url(&url, cx);
                }
            });
    };

    let progress = if state.duration > 0.0 {
        (state.position / state.duration).clamp(0.0, 1.0) as f32
    } else {
        0.0
    };
    let show_controls = state.paused || state.ended;
    let seeking = Media::global(cx).read(cx).seeking.clone();

    player
        .children(frame.map(|frame| img(frame).size_full().object_fit(ObjectFit::Contain)))
        .when(state.buffering, |player| {
            player.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(white())
                    .child(ui::spinner((id.clone(), SharedString::from("buffering")))),
            )
        })
        .on_click(|_, _, cx| Media::global(cx).update(cx, |media, _| media.toggle_pause()))
        .child(
            div()
                .id((id.clone(), SharedString::from("controls")))
                .absolute()
                .bottom_2()
                .left_2()
                .right_2()
                .flex()
                .items_center()
                .gap_1()
                .p_1()
                .rounded(t.radius)
                .border_1()
                .border_color(t.border)
                .bg(t.popover)
                .when(!show_controls, |bar| {
                    bar.invisible().group_hover("video", |bar| bar.visible())
                })
                // clicks on the bar shouldn't also pause the video underneath
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(
                    button(
                        (id.clone(), SharedString::from("play")).into(),
                        if state.paused || state.ended {
                            "play"
                        } else {
                            "pause"
                        },
                    )
                    .on_click(|_, _, cx| {
                        cx.stop_propagation();
                        Media::global(cx).update(cx, |media, _| media.toggle_pause())
                    }),
                )
                .child(seek_bar(progress, seeking, t))
                .child(
                    div()
                        .flex_shrink_0()
                        .px_1()
                        .text_xs()
                        .text_color(t.foreground)
                        .child(format!(
                            "{} / {}",
                            clock(state.position),
                            clock(state.duration)
                        )),
                )
                .child(
                    button(
                        (id.clone(), SharedString::from("mute")).into(),
                        if state.muted { "volume-x" } else { "volume-2" },
                    )
                    .on_click(|_, _, cx| {
                        cx.stop_propagation();
                        Media::global(cx).update(cx, |media, _| media.toggle_mute())
                    }),
                )
                .child(download_button),
        )
}

fn seek_bar(progress: f32, seeking: std::rc::Rc<std::cell::Cell<bool>>, t: Tokens) -> Div {
    div()
        .relative()
        .flex_1()
        .h_6()
        .flex()
        .items_center()
        .child(
            div().w_full().h_1().rounded_full().bg(t.muted).child(
                div()
                    .h_full()
                    .w(relative(progress))
                    .rounded_full()
                    .bg(t.primary),
            ),
        )
        .child(drag_surface(
            seeking,
            CursorStyle::PointingHand,
            |phase, position, bounds, _, cx| {
                if phase != DragPhase::End {
                    let (x, _) = fraction(position, bounds);
                    Media::global(cx).update(cx, |media, _| media.seek(x));
                }
            },
        ))
}
