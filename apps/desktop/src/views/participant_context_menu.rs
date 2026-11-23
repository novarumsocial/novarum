// Port of apps/frontend/src/lib/components/participant-context-menu.svelte: right-clicking someone
// in the call mutes them locally or sets their volume (0-300%), or stops watching their stream;
// on yourself it toggles your mic. The mute and volume rows keep the menu open like the web's
// `closeOnSelect={false}`.
use gpui_kit::component::{
    menu::{ContextMenuExt, PopupMenu, PopupMenuItem},
    slider::{Slider, SliderEvent, SliderState},
};

use crate::{prelude::*, state::voice::Voice};

/// Swallows the click so the menu item underneath doesn't run and close the menu.
fn keep_open(element: impl IntoElement) -> Div {
    div()
        .w_full()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(element)
}

fn check_row(
    id: &'static str,
    label: &'static str,
    checked: bool,
    on_toggle: impl Fn(&mut App) + 'static,
    cx: &App,
) -> Div {
    let t = theme::tokens(cx);
    keep_open(
        div()
            .id(id)
            .flex()
            .w_full()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex()
                    .size_4()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .when(checked, |slot| {
                        slot.child(icon("check").size_4().text_color(t.foreground))
                    }),
            )
            .child(label)
            .on_click(move |_, _, cx| on_toggle(cx)),
    )
}

fn menu(menu: PopupMenu, identity: &str, name: &str, cx: &mut Context<PopupMenu>) -> PopupMenu {
    let voice = Voice::global(cx);
    if voice.read(cx).local_identity() == Some(identity) {
        return menu.item(PopupMenuItem::element(|_, cx| {
            let muted = Voice::global(cx).read(cx).self_muted;
            check_row(
                "participant-self-mute",
                "Mute",
                muted,
                move |cx| Voice::global(cx).update(cx, |voice, cx| voice.set_muted(!muted, cx)),
                cx,
            )
        }));
    }

    let volume = voice.read(cx).participant_volume(identity);
    let slider = cx.new(|_| {
        SliderState::new()
            .min(0.0)
            .max(300.0)
            .step(1.0)
            .default_value(volume * 100.0)
    });
    cx.subscribe(&slider, {
        let identity = identity.to_string();
        move |_, _, event: &SliderEvent, cx| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            let volume = value.start() / 100.0;
            Voice::global(cx).update(cx, |voice, cx| {
                voice.set_participant_volume(&identity, volume, cx)
            });
        }
    })
    .detach();

    let watching = voice.read(cx).watched_streams.contains(identity);
    let (mute_identity, volume_identity, stream_identity) = (
        identity.to_string(),
        identity.to_string(),
        identity.to_string(),
    );
    let label = SharedString::from(format!("Volume for {name}"));
    menu.min_w(px(192.0))
        .item(PopupMenuItem::element(move |_, cx| {
            let muted = Voice::global(cx).read(cx).participant_muted(&mute_identity);
            let identity = mute_identity.clone();
            check_row(
                "participant-local-mute",
                "Local mute",
                muted,
                move |cx| {
                    Voice::global(cx).update(cx, |voice, cx| {
                        voice.set_participant_muted(&identity, !muted, cx)
                    })
                },
                cx,
            )
        }))
        .item(PopupMenuItem::element(move |_, cx| {
            let percent = slider.read(cx).value().start().round();
            let (identity, reset) = (volume_identity.clone(), slider.clone());
            keep_open(
                div()
                    .id("participant-volume")
                    .flex()
                    .w_full()
                    .flex_col()
                    .gap_2()
                    .py_1()
                    .child(
                        div()
                            .flex()
                            .w_full()
                            .justify_between()
                            .child("Volume")
                            .child(format!("{percent}%")),
                    )
                    .child(
                        Slider::new(&slider)
                            .accessibility_label(label.clone())
                            .w_full(),
                    )
                    // like the web's double-click on the thumb: back to 100%
                    .on_click(move |event, window, cx| {
                        if event.click_count() == 2 {
                            reset.update(cx, |slider, cx| slider.set_value(100.0, window, cx));
                            Voice::global(cx).update(cx, |voice, cx| {
                                voice.set_participant_volume(&identity, 1.0, cx)
                            });
                        }
                    }),
            )
        }))
        .when(watching, |menu| {
            menu.separator()
                .item(
                    PopupMenuItem::new("Stop watching stream").on_click(move |_, _, cx| {
                        Voice::global(cx).update(cx, |voice, cx| {
                            voice.stop_watching_stream(&stream_identity, cx)
                        })
                    }),
                )
        })
}

/// Wraps `element` in the participant menu while you're in a call, like the web's
/// `{#if voice && voice.connected}`.
pub fn participant_context_menu<E>(element: E, identity: &str, name: &str, cx: &App) -> AnyElement
where
    E: ContextMenuExt + IntoElement + 'static,
{
    if !Voice::global(cx).read(cx).connected() {
        return element.into_any_element();
    }
    let (identity, name) = (identity.to_string(), name.to_string());
    element
        .context_menu(move |popup, _, cx| menu(popup, &identity, &name, cx))
        .into_any_element()
}
