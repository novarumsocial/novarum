// Port of apps/frontend/src/lib/components/audio-player.svelte. The web used video.js's audio
// skin; here one rodio player (on its own thread, like sounds.rs) plays one attachment at a time,
// drawn as play/pause, elapsed time, a seek bar and the length. rodio has no Opus decoder, so
// `.opus` files can't play (they can still be downloaded).
use std::{
    cell::Cell,
    io::Cursor,
    rc::Rc,
    sync::{LazyLock, Mutex, mpsc},
    time::Duration,
};

use rodio::Source;

use crate::prelude::*;

use crate::{api, models::Attachment, views::attachment_viewer::download};

enum Command {
    Play { url: String, bytes: Vec<u8> },
    Toggle,
    Seek(Duration),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Status {
    pub url: Option<String>,
    pub loading: bool,
    pub paused: bool,
    pub position: Duration,
    pub duration: Option<Duration>,
    pub failed: bool,
}

static STATUS: LazyLock<Mutex<Status>> = LazyLock::new(Mutex::default);

fn set_status(edit: impl FnOnce(&mut Status)) {
    edit(&mut STATUS.lock().unwrap());
}

pub fn status() -> Status {
    STATUS.lock().unwrap().clone()
}

static PLAYER: LazyLock<Mutex<mpsc::Sender<Command>>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel::<Command>();
    let _ = std::thread::Builder::new().name("audio-player".into()).spawn(move || {
        let Ok(mut stream) = rodio::OutputStreamBuilder::open_default_stream() else {
            set_status(|status| status.failed = true);
            return;
        };
        stream.log_on_drop(false);
        let mut sink: Option<rodio::Sink> = None;
        loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(Command::Play { url, bytes }) => {
                    if let Some(sink) = sink.take() {
                        sink.stop();
                    }
                    match rodio::Decoder::try_from(Cursor::new(bytes)) {
                        Ok(source) => {
                            let duration = source.total_duration();
                            let next = rodio::Sink::connect_new(stream.mixer());
                            next.append(source);
                            sink = Some(next);
                            set_status(|status| {
                                *status = Status { url: Some(url), duration, ..Status::default() };
                            });
                        }
                        Err(_) => set_status(|status| {
                            *status = Status { url: Some(url), failed: true, paused: true, ..Status::default() };
                        }),
                    }
                }
                Ok(Command::Toggle) => {
                    if let Some(sink) = &sink {
                        if sink.is_paused() { sink.play() } else { sink.pause() }
                    }
                }
                Ok(Command::Seek(position)) => {
                    if let Some(sink) = &sink {
                        let _ = sink.try_seek(position);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            if let Some(current) = &sink {
                let (paused, position, ended) = (current.is_paused(), current.get_pos(), current.empty());
                set_status(|status| {
                    status.paused = paused || ended;
                    status.position = if ended { Duration::ZERO } else { position };
                });
                if ended {
                    sink = None;
                }
            }
        }
    });
    Mutex::new(sender)
});

fn send(command: Command) {
    let _ = PLAYER.lock().unwrap().send(command);
}

/// Repaints while something plays, so the time and the bar move.
struct Ticker(#[allow(dead_code)] Task<()>);
impl Global for Ticker {}

fn ensure_ticker(cx: &mut App) {
    if cx.has_global::<Ticker>() {
        return;
    }
    let task = cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let status = status();
            cx.update(|cx| cx.refresh_windows());
            if status.url.is_none() || (status.paused && !status.loading) {
                cx.update(|cx| cx.remove_global::<Ticker>());
                return;
            }
        }
    });
    cx.set_global(Ticker(task));
}

/// Plays `url`, or pauses/resumes it if it is the one already loaded.
pub fn toggle(url: &str, cx: &mut App) {
    let current = status();
    if current.url.as_deref() == Some(url) && !current.failed {
        send(Command::Toggle);
        ensure_ticker(cx);
        return;
    }
    set_status(|status| *status = Status { url: Some(url.to_string()), loading: true, ..Status::default() });
    ensure_ticker(cx);
    let url = url.to_string();
    cx.spawn(async move |cx| {
        match api::fetch_bytes(url.clone()).await {
            Ok(bytes) => send(Command::Play { url, bytes }),
            Err(_) => set_status(|status| *status = Status { url: Some(url), failed: true, paused: true, ..Status::default() }),
        }
        cx.update(|cx| cx.refresh_windows());
    })
    .detach();
}

/// `m:ss`
pub fn format_clock(duration: Duration) -> String {
    let seconds = duration.as_secs();
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// Where a click at `x` lands in a bar `width` wide, as a fraction of it.
pub fn seek_fraction(x: f32, width: f32) -> f32 {
    if width <= 0.0 { 0.0 } else { (x / width).clamp(0.0, 1.0) }
}

pub fn audio_player(id: impl Into<ElementId>, attachment: &Attachment, hovered: bool, cx: &mut App) -> Div {
    let id: ElementId = id.into();
    let t = theme::tokens(cx);
    let status = status();
    let current = status.url.as_deref() == Some(attachment.url.as_str());
    let playing = current && !status.paused && !status.loading && !status.failed;
    let position = if current { status.position } else { Duration::ZERO };
    let duration = if current { status.duration } else { None };
    let progress = duration
        .filter(|duration| !duration.is_zero())
        .map_or(0.0, |duration| position.as_secs_f32() / duration.as_secs_f32());

    let bar_bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
    let url = attachment.url.clone();
    let bar = div()
        .id((id.clone(), SharedString::from("seek")))
        .relative()
        .flex_1()
        .h_4()
        .flex()
        .items_center()
        .cursor_pointer()
        .child(
            canvas(
                {
                    let bar_bounds = bar_bounds.clone();
                    move |bounds, _, _| bar_bounds.set(bounds)
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        )
        .child(
            div()
                .w_full()
                .h_1()
                .bg(t.muted)
                .child(div().h_full().w(relative(progress.clamp(0.0, 1.0))).bg(t.primary)),
        )
        .on_mouse_down(MouseButton::Left, move |event, _, _| {
            let (Some(duration), true) = (duration, current) else { return };
            let bounds = bar_bounds.get();
            let fraction = seek_fraction(f32::from(event.position.x - bounds.origin.x), f32::from(bounds.size.width));
            send(Command::Seek(duration.mul_f32(fraction)));
        });

    let clock = |text: String| div().flex_shrink_0().text_xs().text_color(t.muted_foreground).child(text);
    let filename = attachment.filename.clone();
    let download_url = attachment.url.clone();
    div()
        .flex()
        .w_full()
        .flex_col()
        .gap_1p5()
        .child(
            div()
                .flex()
                .h_10()
                .items_center()
                .gap_2()
                .px_1()
                .border_1()
                .border_color(t.border)
                .rounded(t.radius)
                .bg(if hovered { t.muted.opacity(0.3) } else { t.background })
                .text_color(t.primary)
                .child(
                    div()
                        .id((id.clone(), SharedString::from("play")))
                        .flex()
                        .size_8()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .rounded(t.radius)
                        .cursor_pointer()
                        .hover(|s| s.bg(t.muted))
                        .child(if current && status.loading {
                            crate::ui::spinner((id.clone(), SharedString::from("loading"))).into_any_element()
                        } else {
                            icon(if playing { "pause" } else { "play" }).size_4().into_any_element()
                        })
                        .on_click(move |_, _, cx| toggle(&url, cx)),
                )
                .child(clock(format_clock(position)))
                .child(bar)
                .child(clock(duration.map(format_clock).unwrap_or_else(|| "-:--".into())))
                .when(current && status.failed, |row| {
                    row.child(div().pr_1().text_xs().text_color(t.destructive).child("Can't play"))
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap_1p5()
                .pr_1()
                .child(div().flex_1().min_w_0().truncate().text_xs().text_color(t.muted_foreground).child(filename.clone()))
                .child(
                    div()
                        .id((id, SharedString::from("download")))
                        .flex()
                        .size_7()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .text_color(t.muted_foreground)
                        .hover(|s| s.bg(t.muted).text_color(t.primary))
                        .child(icon("download").size(px(14.0)))
                        .on_click(move |_, _, cx| download(&download_url, &filename, cx)),
                ),
        )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{format_clock, seek_fraction};

    #[test]
    fn formats_clocks_and_seeks() {
        assert_eq!(format_clock(Duration::from_secs(0)), "0:00");
        assert_eq!(format_clock(Duration::from_secs(125)), "2:05");
        assert_eq!(seek_fraction(50.0, 200.0), 0.25);
        assert_eq!(seek_fraction(-5.0, 200.0), 0.0);
        assert_eq!(seek_fraction(500.0, 200.0), 1.0);
        assert_eq!(seek_fraction(5.0, 0.0), 0.0);
    }
}
