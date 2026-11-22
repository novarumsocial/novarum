// Port of apps/frontend/src/lib/components/call-ringing.svelte
use std::time::Duration;

use crate::{
    models::DmType,
    notifications::notification_sound,
    prelude::*,
    state::{
        chat::Chat,
        dms::{Dms, RING_TIMEOUT, dm_display},
        realtime::Realtime,
        settings::SettingsStore,
        voice::Voice,
    },
    views::{profile_card::green, shell::ShellState},
};

const RING_INTERVAL: Duration = Duration::from_secs(2);

/// Stop ringing out once they pick up or we hang up.
pub fn outgoing_ended(outgoing: &str, voice_channel: Option<&str>, in_call: usize) -> bool {
    voice_channel != Some(outgoing) || in_call > 1
}

/// A ringtone loop that gives up after `RING_TIMEOUT`; dropping it stops both.
struct Ring {
    channel_id: String,
    _task: Task<()>,
}

pub struct CallRinging {
    incoming: Option<Ring>,
    outgoing: Option<Ring>,
    /// the ring can arrive before the caller's presence, so only stop once they've been seen and left
    caller_seen: bool,
    _subscriptions: Vec<Subscription>,
}

impl CallRinging {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _subscriptions = vec![
            cx.observe(&Dms::global(cx), |this, _, cx| this.sync(cx)),
            cx.observe(&Chat::global(cx), |this, _, cx| this.sync(cx)),
            cx.observe(&Voice::global(cx), |this, _, cx| this.sync(cx)),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
        ];
        Self { incoming: None, outgoing: None, caller_seen: false, _subscriptions }
    }

    fn ring(channel_id: String, incoming: bool, cx: &mut Context<Self>) -> Ring {
        if incoming {
            notification_sound(cx);
        }
        let _task = cx.spawn(async move |_, cx| {
            let started = std::time::Instant::now();
            while started.elapsed() < RING_TIMEOUT {
                cx.background_executor().timer(RING_INTERVAL).await;
                if started.elapsed() >= RING_TIMEOUT {
                    break;
                }
                cx.update(|cx| notification_sound(cx));
            }
            cx.update(|cx| {
                Dms::global(cx).update(cx, |dms, cx| {
                    if incoming {
                        dms.set_incoming_call(None, cx);
                    } else {
                        dms.set_outgoing_call(None, cx);
                    }
                })
            });
        });
        Ring { channel_id: channel_id.clone(), _task }
    }

    /// The web's `$effect`s: who's still ringing, and the ringtones that go with them.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let dms = Dms::global(cx);
        let voice_channel = Voice::global(cx).read(cx).channel_id.clone();
        let chat = Chat::global(cx).read(cx);
        let count = |id: &str| chat.voice_states.get(id).map_or(0, Vec::len);
        let (incoming, outgoing) = {
            let dms = dms.read(cx);
            (dms.incoming_call.as_ref().map(|call| call.channel_id.clone()), dms.outgoing_call.clone())
        };
        let caller_count = incoming.as_deref().map_or(0, count);
        let outgoing_count = outgoing.as_deref().map_or(0, count);

        let mut clear_incoming = false;
        match &incoming {
            None => self.caller_seen = false,
            Some(id) if voice_channel.as_deref() == Some(id.as_str()) => clear_incoming = true,
            Some(_) if caller_count > 0 => self.caller_seen = true,
            Some(_) if self.caller_seen => clear_incoming = true,
            Some(_) => {}
        }
        let clear_outgoing =
            outgoing.as_deref().is_some_and(|id| outgoing_ended(id, voice_channel.as_deref(), outgoing_count));
        if clear_incoming || clear_outgoing {
            dms.update(cx, |dms, cx| {
                if clear_incoming {
                    dms.set_incoming_call(None, cx);
                }
                if clear_outgoing {
                    dms.set_outgoing_call(None, cx);
                }
            });
            return;
        }

        if self.incoming.as_ref().map(|ring| &ring.channel_id) != incoming.as_ref() {
            self.incoming = incoming.map(|id| Self::ring(id, true, cx));
        }
        if self.outgoing.as_ref().map(|ring| &ring.channel_id) != outgoing.as_ref() {
            self.outgoing = outgoing.map(|id| Self::ring(id, false, cx));
        }
        cx.notify();
    }

    fn accept(&mut self, cx: &mut Context<Self>) {
        let dms = Dms::global(cx);
        let Some(call) = dms.read(cx).incoming_call.clone() else { return };
        dms.update(cx, |dms, cx| dms.set_incoming_call(None, cx));
        ShellState::accept_call(&call.channel_id, cx);
    }

    fn decline(&mut self, cx: &mut Context<Self>) {
        let dms = Dms::global(cx);
        let Some(call) = dms.read(cx).incoming_call.clone() else { return };
        // stops my other devices; the homeserver only ends the whole ring for a 1:1
        Realtime::global(cx).update(cx, |realtime, cx| realtime.ring_call(&call.channel_id, false, cx));
        dms.update(cx, |dms, cx| dms.set_incoming_call(None, cx));
    }
}

impl Render for CallRinging {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let dms = Dms::global(cx).read(cx);
        let Some(call) = dms.incoming_call.clone() else { return div().absolute().size_0() };
        let circle = SettingsStore::get(cx).circle_icons;
        let name = call.user.name().to_string();
        let group_name =
            dms.get(&call.channel_id).filter(|dm| dm.kind == DmType::GroupDm).map(|group| dm_display(group).name);

        let round = |button: Stateful<Div>| if circle { button.rounded_full() } else { button.rounded(t.radius) };
        let button = |id: &'static str| {
            round(div().id(id).flex().items_center().justify_center().size_10().flex_shrink_0().cursor_pointer())
        };

        let card = div()
            .id("incoming-call")
            .occlude()
            .flex()
            .items_center()
            .gap_3()
            .w_full()
            .max_w(px(384.0))
            .border_1()
            .border_color(t.border)
            .bg(t.sidebar.opacity(0.8))
            .p_3()
            .shadow_lg()
            .when(circle, |card| card.rounded_xl())
            .child(
                div()
                    .child(ui::avatar::avatar(call.user.avatar_url.as_deref(), &name, call.user.avatar_color.as_deref(), 40.0, cx))
                    .with_animation(
                        "pulse",
                        Animation::new(Duration::from_secs(2)).repeat(),
                        |avatar, delta| avatar.opacity(1.0 - 0.5 * (delta * std::f32::consts::PI).sin()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(t.foreground)
                            .child(name),
                    )
                    .child(div().truncate().text_xs().text_color(t.muted_foreground).child(match group_name {
                        Some(group) => format!("Calling {group}…"),
                        None => "Incoming call…".into(),
                    })),
            )
            .child(
                button("decline")
                    .bg(t.destructive)
                    .text_color(white())
                    .hover(|s| s.bg(t.destructive.opacity(0.9)))
                    .child(icon("phone-off").size_5())
                    .on_click(cx.listener(|this, _, _, cx| this.decline(cx))),
            )
            .child(
                button("accept")
                    .bg(green().opacity(0.2))
                    .text_color(green())
                    .hover(|s| s.bg(green().opacity(0.3)))
                    .child(icon("phone").size_5())
                    .on_click(cx.listener(|this, _, _, cx| this.accept(cx))),
            );

        div().absolute().top_4().left_4().right_4().flex().justify_center().child(
            card.with_animation(
                SharedString::from(format!("fly-{}", call.channel_id)),
                Animation::new(Duration::from_millis(200)),
                |card, delta| card.mt(px(-16.0 * (1.0 - delta))).opacity(delta),
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::outgoing_ended;

    #[test]
    fn outgoing_rings_until_answered_or_left() {
        assert!(!outgoing_ended("c", Some("c"), 1));
        assert!(outgoing_ended("c", Some("c"), 2));
        assert!(outgoing_ended("c", None, 1));
        assert!(outgoing_ended("c", Some("other"), 1));
    }
}
