// Port of apps/frontend/src/lib/components/user-area.svelte.
use gpui_kit::component::{
    menu::{DropdownMenu, PopupMenuItem},
    popover::Popover,
    switch::Switch,
};

use crate::prelude::*;

use crate::{
    api,
    state::{
        chat::Chat,
        dms::{Dms, dm_display},
        router,
        session::Session,
        settings::{NoiseSuppressionModel, SettingsStore},
        voice::Voice,
    },
    ui::{avatar::avatar, trigger::trigger},
    views::shell::ShellState,
};

const EMERALD_400: u32 = 0x34d399;
const EMERALD_500: u32 = 0x10b981;
const LIME_400: u32 = 0xa3e635;
const LIME_500: u32 = 0x84cc16;
const AMBER_400: u32 = 0xfbbf24;
const AMBER_500: u32 = 0xf59e0b;
const ROSE_300: u32 = 0xfda4af;
const ROSE_400: u32 = 0xfb7185;
const ROSE_500: u32 = 0xf43f5e;

/// The connection icon and its `bg-*-500/10 text-*-400` colors for a round trip in ms.
pub fn signal_tier(connecting: bool, latency: Option<u32>) -> (&'static str, u32, u32) {
    if connecting {
        return ("signal-zero", AMBER_500, AMBER_400);
    }
    match latency.unwrap_or(0) {
        0..60 => ("signal", EMERALD_500, EMERALD_400),
        60..120 => ("signal-high", LIME_500, LIME_400),
        120..200 => ("signal-medium", AMBER_500, AMBER_400),
        _ => ("signal-low", ROSE_500, ROSE_400),
    }
}

pub struct UserArea {
    _subscriptions: Vec<Subscription>,
}

impl UserArea {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(&Voice::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Session::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Dms::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
        ];
        Self {
            _subscriptions: subscriptions,
        }
    }

    fn voice_channel_name(channel_id: &str, cx: &App) -> Option<String> {
        let chat = Chat::global(cx).read(cx);
        chat.channels_by_server
            .values()
            .flatten()
            .flat_map(|category| &category.channels)
            .find(|channel| channel.id == channel_id)
            .map(|channel| channel.name.clone())
            .or_else(|| {
                Dms::global(cx)
                    .read(cx)
                    .get(channel_id)
                    .map(|dm| dm_display(dm).name)
            })
    }

    fn render_voice_panel(&self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let voice = Voice::global(cx).read(cx);
        let (connecting, connected) = (voice.connecting(), voice.connected());
        let (camera, screen, noise) = (
            voice.self_camera,
            voice.self_screen_share,
            voice.noise_cancellation_enabled,
        );
        let channel_id = voice.channel_id.clone().unwrap_or_default();
        let channel_name =
            Self::voice_channel_name(&channel_id, cx).unwrap_or("Voice channel".into());
        let (tier_icon, tier_bg, tier_text) = signal_tier(connecting, None);

        let media_toggle = |id: &'static str,
                            on: bool,
                            label: &'static str,
                            text: &'static str,
                            icon_name: &'static str| {
            div()
                .id(id)
                .flex()
                .h_8()
                .items_center()
                .justify_center()
                .gap(px(6.0))
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .when(circle, |toggle| toggle.rounded_full())
                .map(|toggle| {
                    if on {
                        toggle
                            .bg(t.primary)
                            .text_color(t.primary_foreground)
                            .hover(|toggle| toggle.bg(t.primary.opacity(0.85)))
                    } else {
                        toggle
                            .bg(t.sidebar_accent)
                            .text_color(t.sidebar_foreground.opacity(0.8))
                            .hover(|toggle| {
                                toggle
                                    .bg(t.sidebar_accent.opacity(0.7))
                                    .text_color(t.sidebar_foreground)
                            })
                    }
                })
                .map(|toggle| {
                    if connected {
                        toggle.cursor_pointer()
                    } else {
                        toggle.opacity(0.5)
                    }
                })
                .child(icon(icon_name).size_4())
                .child(text)
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
                })
        };

        let settings_popover = Popover::new("voice-processing")
            .anchor(Anchor::BottomRight)
            .w(px(320.0))
            .p_0()
            .gap_0()
            .overflow_hidden()
            .trigger(
                trigger("voice-processing-trigger")
                    .flex()
                    .size_7()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .map(|button| {
                        if noise {
                            button
                                .text_color(t.primary)
                                .hover(|button| button.text_color(t.primary.opacity(0.8)))
                        } else {
                            button
                                .text_color(t.muted_foreground)
                                .hover(|button| button.text_color(t.sidebar_foreground))
                        }
                    })
                    .child(icon("audio-waveform").size_4())
                    .tooltip(|window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new("Voice processing settings")
                            .build(window, cx)
                    }),
            )
            .content(|_, _, cx| voice_processing(cx));

        div()
            .border_b_1()
            .border_color(t.border.opacity(0.8))
            .px_3()
            .py_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .size_8()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .bg(rgba((tier_bg << 8) | 0x1a))
                            .text_color(rgb(tier_text))
                            .child(icon(tier_icon).size_4()),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .child(
                                div()
                                    .truncate()
                                    .text_xs()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(rgb(if connecting {
                                        AMBER_400
                                    } else {
                                        EMERALD_400
                                    }))
                                    .child(if connecting {
                                        "VOICE CONNECTING"
                                    } else {
                                        "VOICE CONNECTED"
                                    }),
                            )
                            .child(
                                div()
                                    .id("voice-channel-name")
                                    .truncate()
                                    .text_size(px(11.0))
                                    .text_color(t.muted_foreground)
                                    .cursor_pointer()
                                    .hover(|name| name.underline())
                                    .child(channel_name)
                                    .on_click(move |_, _, cx| {
                                        Chat::global(cx).update(cx, |chat, cx| {
                                            chat.select_channel(&channel_id, cx)
                                        })
                                    }),
                            ),
                    )
                    .child(settings_popover)
                    .child(
                        div()
                            .id("leave-call")
                            .flex()
                            .size_8()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .text_color(t.muted_foreground)
                            .cursor_pointer()
                            .when(circle, |button| button.rounded_full())
                            .hover(|button| {
                                button
                                    .bg(rgb(ROSE_500).opacity(0.1))
                                    .text_color(rgb(ROSE_300))
                            })
                            .child(icon("phone-off").size_4())
                            .tooltip(|window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new("Leave call")
                                    .build(window, cx)
                            })
                            .on_click(|_, _, cx| ShellState::leave_voice(cx)),
                    ),
            )
            .child(
                div()
                    .mt_2()
                    .grid()
                    .grid_cols(2)
                    .gap(px(6.0))
                    .child(
                        media_toggle(
                            "camera-toggle",
                            camera,
                            if camera {
                                "Turn off camera"
                            } else {
                                "Turn on camera"
                            },
                            "Camera",
                            if camera { "video" } else { "video-off" },
                        )
                        .when(connected, |toggle| {
                            toggle.on_click(move |_, _, cx| {
                                Voice::global(cx)
                                    .update(cx, |voice, cx| voice.set_camera(!camera, cx))
                            })
                        }),
                    )
                    .child(
                        media_toggle(
                            "screen-toggle",
                            screen,
                            if screen {
                                "Stop sharing your screen"
                            } else {
                                "Share your screen"
                            },
                            "Screen",
                            "monitor-up",
                        )
                        .when(connected, |toggle| {
                            toggle.on_click(move |_, _, cx| {
                                Voice::global(cx)
                                    .update(cx, |voice, cx| voice.set_screen_share(!screen, cx))
                            })
                        }),
                    ),
            )
    }

    fn render_account(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let Some(user) = Session::user(cx) else {
            return div().into_any_element();
        };
        let name = user.name().to_string();

        let trigger = trigger("account-switcher")
            .flex()
            .min_w_0()
            .flex_1()
            .ml(px(-6.0))
            .items_center()
            .gap(px(10.0))
            .px(px(6.0))
            .py_1()
            .cursor_pointer()
            .hover(|trigger| trigger.bg(t.sidebar_accent))
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        avatar(
                            user.avatar_url.as_deref(),
                            &name,
                            user.avatar_color.as_deref(),
                            32.0,
                            cx,
                        )
                        .text_xs(),
                    )
                    .child(
                        div()
                            .absolute()
                            .right(px(-1.0))
                            .bottom(px(-1.0))
                            .size(px(if circle { 11.0 } else { 10.0 }))
                            .border_2()
                            .border_color(t.sidebar)
                            .bg(rgb(EMERALD_500))
                            .when(circle, |dot| dot.rounded_full()),
                    ),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .line_height(rems(1.25))
                            .text_color(t.sidebar_foreground)
                            .child(name),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.0))
                            .text_color(t.muted_foreground)
                            .child(format!("@{}:{}", user.username, user.homeserver)),
                    ),
            );

        Popover::new("accounts")
            .anchor(Anchor::BottomLeft)
            .w(px(256.0))
            .p_1()
            .gap_0()
            .trigger_style(StyleRefinement::default().flex_1().min_w_0())
            .trigger(trigger)
            .content(|_, _, cx| account_menu(cx))
            .into_any_element()
    }

    fn icon_button(
        id: &'static str,
        icon_name: &'static str,
        color: Hsla,
        hover: Hsla,
        label: &'static str,
    ) -> Stateful<Div> {
        div()
            .id(id)
            .flex()
            .size_7()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(color)
            .hover(|button| button.text_color(hover))
            .child(icon(icon_name).size_4())
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
            })
    }
}

/// The popover's noise suppression switch and model picker.
fn voice_processing(cx: &mut App) -> Div {
    let t = theme::tokens(cx);
    let voice = Voice::global(cx).read(cx);
    let (enabled, testing) = (
        voice.noise_cancellation_enabled,
        voice.audio_loopback_testing,
    );
    let model = SettingsStore::get(cx).noise_suppression_model;
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_start()
                .justify_between()
                .gap_4()
                .px(px(14.0))
                .py_3()
                .child(
                    div()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .child("Noise suppression"),
                        )
                        .child(
                            div()
                                .mt(px(2.0))
                                .max_w(px(208.0))
                                .text_size(px(11.0))
                                .text_color(t.muted_foreground)
                                .child("Removes steady background noise"),
                        ),
                )
                .child(
                    Switch::new("noise-cancellation")
                        .mt(px(2.0))
                        .checked(enabled)
                        .disabled(testing)
                        .on_click(|checked, _, cx| {
                            let checked = *checked;
                            Voice::global(cx)
                                .update(cx, |voice, cx| voice.set_noise_cancellation(checked, cx))
                        }),
                ),
        )
        .when(enabled, |panel| {
            panel.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .px(px(14.0))
                    .pb_3()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Model"),
                    )
                    .child(
                        Button::new("noise-model")
                            .outline()
                            .small()
                            .w(px(144.0))
                            .disabled(testing)
                            .label(model.label())
                            .dropdown_caret(true)
                            .dropdown_menu(move |menu, _, _| {
                                [
                                    NoiseSuppressionModel::Deepfilternet,
                                    NoiseSuppressionModel::Rnnoise,
                                ]
                                .into_iter()
                                .fold(menu, |menu, option| {
                                    menu.item(
                                        PopupMenuItem::new(option.label())
                                            .checked(option == model)
                                            .on_click(move |_, _, cx| {
                                                Voice::global(cx).update(cx, |voice, cx| {
                                                    voice.set_noise_suppression_model(option, cx)
                                                })
                                            }),
                                    )
                                })
                            }),
                    ),
            )
        })
        .child(
            div()
                .border_t_1()
                .border_color(t.border)
                .bg(t.muted.opacity(0.2))
                .px(px(14.0))
                .py_3()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .child(
                            div()
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(FontWeight::MEDIUM)
                                        .child("Microphone output"),
                                )
                                .child(
                                    div()
                                        .mt(px(2.0))
                                        .text_size(px(11.0))
                                        .text_color(t.muted_foreground)
                                        .child("Make sure it sounds how you like!"),
                                ),
                        )
                        .when(testing, |row| {
                            row.child(
                                div()
                                    .text_size(px(10.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(t.destructive)
                                    .child("Listening"),
                            )
                        }),
                ),
        )
}

/// The account switcher: this account, the others you're signed into, add one, sign out.
fn account_menu(cx: &mut Context<gpui_kit::component::popover::PopoverState>) -> Div {
    let t = theme::tokens(cx);
    let Some(user) = Session::user(cx) else {
        return div();
    };
    let popover = cx.entity();
    let name = user.name().to_string();
    let home_server = api::anchor().home_server;
    let others: Vec<_> = Session::global(cx)
        .read(cx)
        .accounts
        .iter()
        .filter(|account| account.home_server != home_server)
        .cloned()
        .collect();
    let row = |id: SharedString| {
        div()
            .id(id)
            .flex()
            .w_full()
            .items_center()
            .gap(px(10.0))
            .px_2()
            .py(px(6.0))
            .cursor_pointer()
            .hover(|row| row.bg(t.accent))
    };
    let detail = |title: String, subtitle: String| {
        div()
            .min_w_0()
            .flex_1()
            .child(
                div()
                    .truncate()
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .child(title),
            )
            .child(
                div()
                    .truncate()
                    .text_size(px(11.0))
                    .text_color(t.muted_foreground)
                    .child(subtitle),
            )
    };

    let mut menu = div()
        .flex()
        .flex_col()
        .child(
            div()
                .px_2()
                .py(px(6.0))
                .text_size(px(11.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(t.muted_foreground)
                .child("Accounts"),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .bg(t.accent.opacity(0.5))
                .px_2()
                .py(px(6.0))
                .child(
                    avatar(
                        user.avatar_url.as_deref(),
                        &name,
                        user.avatar_color.as_deref(),
                        28.0,
                        cx,
                    )
                    .text_size(px(11.0)),
                )
                .child(detail(name.clone(), user.homeserver.clone()))
                .child(icon("check").size_4().text_color(t.primary)),
        );
    for account in others {
        let account_name = account
            .display_name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or(account.username.clone());
        let (switch_to, popover) = (account.home_server.clone(), popover.clone());
        menu = menu.child(
            row(format!("account-{}", account.home_server).into())
                .child(
                    avatar(
                        account.avatar_url.as_deref(),
                        &account_name,
                        account.avatar_color.as_deref(),
                        28.0,
                        cx,
                    )
                    .text_size(px(11.0)),
                )
                .child(detail(account_name, account.home_server.clone()))
                .on_click(move |_, window, cx| {
                    popover.update(cx, |popover, cx| popover.dismiss(window, cx));
                    Session::switch_account(switch_to.clone(), cx);
                }),
        );
    }
    let action = |id: &'static str, icon_name: &'static str, label: &'static str| {
        row(id.into())
            .text_xs()
            .child(
                div()
                    .flex()
                    .size_7()
                    .items_center()
                    .justify_center()
                    .text_color(t.muted_foreground)
                    .child(icon(icon_name).size_4()),
            )
            .child(label)
    };
    let add_popover = popover.clone();
    menu.child(div().my_1().border_t_1().border_color(t.border))
        .child(
            action("add-account", "plus", "Add account").on_click(move |_, window, cx| {
                add_popover.update(cx, |popover, cx| popover.dismiss(window, cx));
                router::goto("/login?add=1", cx);
            }),
        )
        .child(
            action("sign-out", "log-out", "Sign out").on_click(move |_, window, cx| {
                popover.update(cx, |popover, cx| popover.dismiss(window, cx));
                let logout = Session::logout(cx);
                cx.spawn(async move |cx| {
                    logout.await;
                    cx.update(|cx| router::goto("/login", cx));
                })
                .detach();
            }),
        )
}

impl Render for UserArea {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let voice = Voice::global(cx).read(cx);
        let in_call = voice.connected() || voice.connecting();
        let (muted, deafened, testing) = (
            voice.self_muted,
            voice.self_deafened,
            voice.audio_loopback_testing,
        );
        let rose = (rgb(ROSE_400).into(), rgb(ROSE_300).into());
        let plain = (t.muted_foreground, t.sidebar_foreground);

        let (mute_color, mute_hover) = if muted || deafened { rose } else { plain };
        let mute = Self::icon_button(
            "mute",
            if muted { "mic-off" } else { "mic" },
            mute_color,
            mute_hover,
            if deafened {
                "Undeafen"
            } else if muted {
                "Unmute"
            } else {
                "Mute"
            },
        )
        .on_click(move |_, _, cx| {
            Voice::global(cx).update(cx, |voice, cx| {
                if deafened {
                    voice.set_deafened(false, cx)
                } else {
                    voice.set_muted(!muted, cx)
                }
            })
        });
        let (deafen_color, deafen_hover) = if deafened { rose } else { plain };
        let deafen = Self::icon_button(
            "deafen",
            if deafened {
                "headphone-off"
            } else {
                "headphones"
            },
            deafen_color,
            deafen_hover,
            if deafened { "Undeafen" } else { "Deafen" },
        )
        .when(!testing, |button| {
            button.on_click(move |_, _, cx| {
                Voice::global(cx).update(cx, |voice, cx| voice.set_deafened(!deafened, cx))
            })
        });
        let settings = Self::icon_button(
            "user-settings",
            "settings",
            t.muted_foreground,
            t.sidebar_foreground,
            "User settings",
        )
        .on_click(|_, _, cx| SettingsStore::set_dialog_open(true, cx));

        div()
            .w(tw(74.0))
            .flex_shrink_0()
            .border_t_1()
            .border_color(t.border)
            .bg(t.sidebar_accent.opacity(0.3))
            .when(in_call, |area| area.child(self.render_voice_panel(cx)))
            .child(
                div()
                    .flex()
                    .h(tw(14.0))
                    .items_center()
                    .gap(px(10.0))
                    .px_3()
                    .child(self.render_account(cx))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.0))
                            .child(mute)
                            .child(deafen)
                            .child(settings),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::signal_tier;

    #[test]
    fn picks_signal_tiers() {
        assert_eq!(signal_tier(true, Some(10)).0, "signal-zero");
        assert_eq!(signal_tier(false, None).0, "signal");
        assert_eq!(signal_tier(false, Some(59)).0, "signal");
        assert_eq!(signal_tier(false, Some(60)).0, "signal-high");
        assert_eq!(signal_tier(false, Some(150)).0, "signal-medium");
        assert_eq!(signal_tier(false, Some(500)).0, "signal-low");
    }
}
