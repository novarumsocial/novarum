// Port of apps/frontend/src/lib/components/voice-area.svelte, voice-stage.svelte and
// voice-tile.svelte: the call's header, the stage (a grid, or a spotlight plus a filmstrip) and
// the floating controls.
use std::{cell::Cell, collections::HashSet, rc::Rc, sync::Arc};

use gpui_kit::component::{
    popover::Popover,
    slider::{Slider, SliderEvent, SliderState},
};

use crate::{
    models::{Author, ChannelType},
    prelude::*,
    state::{
        chat::Chat,
        dms::Dms,
        session::Session,
        settings::SettingsStore,
        video::VideoFeeds,
        voice::{self, Voice},
    },
    theme,
    ui::avatar::avatar_with_fallback,
    util::voice_layout::{fit_tiles_with, initials_for},
    views::{
        channel_sidebar::avatar_bg, participant_context_menu::participant_context_menu,
        shell::ShellState,
    },
};

const GAP: f32 = 8.0;
const STAGE_PADDING: f32 = 12.0;
const SIDE_STRIP_WIDTH: f32 = 160.0;
const BOTTOM_STRIP_HEIGHT: f32 = 96.0;
const SPEAKING_RING: &str = "#00d492";
const ROSE: &str = "#e11d48";

/// A person, or the screen they're sharing (`VoiceTile`).
#[derive(Clone)]
struct Tile {
    key: String,
    identity: String,
    screen: bool,
    state: voice::VoiceState,
    member: Option<Author>,
    name: String,
}

#[derive(Clone, Copy, PartialEq)]
enum TileSize {
    Grid(f32, f32),
    Fit(f32, f32),
    Strip,
}

pub struct VoiceArea {
    embedded: bool,
    /// the tile someone clicked into the spotlight; beats screen-share auto-promotion
    focused_key: Option<String>,
    manual_grid: bool,
    strip_collapsed: bool,
    last_auto_key: Option<String>,
    /// 1:1 DM streams already tuned into once, so stopping one sticks until they share again
    auto_watched: HashSet<String>,
    stage_size: Rc<Cell<Size<Pixels>>>,
    /// takes Escape while fullscreen
    focus: FocusHandle,
    /// the controls fade after a few idle seconds, or when the pointer leaves the call
    controls_visible: bool,
    hovering_controls: bool,
    idle: Option<Task<()>>,
    /// the spotlit stream's volume slider, for whoever is sharing
    stream_volume: Option<(String, Entity<SliderState>)>,
    _subscriptions: Vec<Subscription>,
}

impl VoiceArea {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(false, cx)
    }

    /// The DM call, embedded above the messages (chat_area's `dmCallSlot`).
    pub fn embedded(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(true, cx)
    }

    fn build(embedded: bool, cx: &mut Context<Self>) -> Self {
        let _subscriptions = vec![
            cx.observe(&Voice::global(cx), |this, _, cx| {
                this.auto_watch(cx);
                cx.notify();
            }),
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&VideoFeeds::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&ShellState::global(cx), |_, _, cx| cx.notify()),
        ];
        Self {
            embedded,
            focused_key: None,
            manual_grid: false,
            strip_collapsed: false,
            last_auto_key: None,
            auto_watched: HashSet::new(),
            stage_size: Rc::default(),
            focus: cx.focus_handle(),
            controls_visible: true,
            hovering_controls: false,
            idle: None,
            stream_volume: None,
            _subscriptions,
        }
    }

    /// In a 1:1 DM call, tune into the other person's stream automatically, once per stream.
    fn auto_watch(&mut self, cx: &mut Context<Self>) {
        let Some(channel) = Chat::global(cx).read(cx).current_channel(cx) else {
            return;
        };
        let voice = Voice::global(cx);
        let (local, states) = {
            let voice = voice.read(cx);
            if voice.channel_id.as_deref() != Some(channel.id.as_str()) {
                return;
            }
            (
                voice.local_identity().map(str::to_string),
                voice.voice_states.clone(),
            )
        };
        let one_on_one = channel.kind == ChannelType::Dm && !channel.group && states.len() == 2;
        for (identity, state) in states {
            if Some(&identity) == local.as_ref() {
                continue;
            }
            if !state.screen_share {
                self.auto_watched.remove(&identity);
            } else if one_on_one && self.auto_watched.insert(identity.clone()) {
                voice.update(cx, |voice, cx| voice.watch_stream(&identity, cx));
            }
        }
    }

    /// The people who may be in this call: the guild's members, or you plus the DM's others.
    fn members(&self, channel_id: &str, cx: &App) -> Vec<Author> {
        if !self.embedded {
            return Chat::global(cx).read(cx).members.clone();
        }
        let me = Session::user(cx).map(|me| Author::from(&me.as_public()));
        let others: Vec<Author> = Dms::global(cx)
            .read(cx)
            .get(channel_id)
            .map(|dm| dm.participants.iter().map(Author::from).collect())
            .unwrap_or_default();
        me.into_iter().chain(others).collect()
    }

    fn tiles(&self, channel_id: &str, cx: &App) -> Vec<Tile> {
        let members = self.members(channel_id, cx);
        let voice = Voice::global(cx).read(cx);
        let member_for = |identity: &str| {
            let handle = voice.participant_handle(identity);
            members
                .iter()
                .find(|member| member.user_id == identity)
                .or_else(|| {
                    members.iter().find(|member| {
                        handle.is_some_and(|handle| {
                            member.username == handle.username
                                && member.server.eq_ignore_ascii_case(&handle.homeserver)
                        })
                    })
                })
                .cloned()
        };
        let mut entries: Vec<_> = voice.voice_states.iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        let build = |screen: bool| {
            entries
                .iter()
                .filter(move |(_, state)| !screen || state.screen_share)
                .map(move |(identity, state)| {
                    let member = member_for(identity);
                    let name = member
                        .as_ref()
                        .map(|member| member.name().to_string())
                        .unwrap_or_else(|| identity.to_string());
                    Tile {
                        key: if screen {
                            format!("screen:{identity}")
                        } else {
                            identity.to_string()
                        },
                        identity: identity.to_string(),
                        screen,
                        state: (*state).clone(),
                        member,
                        name,
                    }
                })
        };
        // screen shares first, so they sort ahead of the people sharing them
        build(true).chain(build(false)).collect()
    }

    fn wake_controls(&mut self, cx: &mut Context<Self>) {
        if !self.controls_visible {
            self.controls_visible = true;
            cx.notify();
        }
        self.idle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(2500))
                .await;
            let _ = this.update(cx, |this, cx| this.hide_controls(cx));
        }));
    }

    fn hide_controls(&mut self, cx: &mut Context<Self>) {
        self.idle = None;
        self.controls_visible = false;
        cx.notify();
    }

    /// The web's "Stream volume" popover: only the shared screen's audio, not their mic.
    fn stream_slider(&mut self, identity: &str, cx: &mut Context<Self>) -> Entity<SliderState> {
        if let Some((current, slider)) = &self.stream_volume
            && current == identity
        {
            return slider.clone();
        }
        let volume = Voice::global(cx)
            .read(cx)
            .participant_screen_volume(identity);
        let slider = cx.new(|_| {
            SliderState::new()
                .min(0.0)
                .max(300.0)
                .step(1.0)
                .default_value(volume * 100.0)
        });
        let owner = identity.to_string();
        cx.subscribe(&slider, move |_, _, event: &SliderEvent, cx| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            let volume = value.start() / 100.0;
            Voice::global(cx).update(cx, |voice, cx| {
                voice.set_participant_screen_volume(&owner, volume, cx)
            });
        })
        .detach();
        self.stream_volume = Some((identity.to_string(), slider.clone()));
        slider
    }

    fn focus_tile(&mut self, tile: &Tile, cx: &mut Context<Self>) {
        let watching = Voice::global(cx)
            .read(cx)
            .watched_streams
            .contains(&tile.identity);
        if tile.screen && !watching && !self.is_self(&tile.identity, cx) {
            let identity = tile.identity.clone();
            Voice::global(cx).update(cx, |voice, cx| voice.watch_stream(&identity, cx));
        }
        self.focused_key = Some(tile.key.clone());
        self.manual_grid = false;
        cx.notify();
    }

    fn show_grid(&mut self, cx: &mut Context<Self>) {
        self.focused_key = None;
        self.manual_grid = true;
        cx.notify();
    }

    fn is_self(&self, identity: &str, cx: &App) -> bool {
        Voice::global(cx).read(cx).local_identity() == Some(identity)
    }

    fn has_video(tile: &Tile, cx: &App) -> bool {
        VideoFeeds::global(cx)
            .read(cx)
            .frame(&tile.identity, tile.screen)
            .is_some()
    }

    /// Picks the spotlight like the web: a focused tile, else the first stream that's playing.
    fn spotlight_key(&mut self, tiles: &[Tile], cx: &App) -> Option<String> {
        let auto = tiles
            .iter()
            .find(|tile| tile.screen && Self::has_video(tile, cx))
            .map(|tile| tile.key.clone());
        // a newly started screen share takes over the stage, even if the user had chosen grid
        if auto.is_some() && auto != self.last_auto_key {
            self.manual_grid = false;
        }
        self.last_auto_key = auto.clone();
        if self
            .focused_key
            .as_ref()
            .is_some_and(|key| !tiles.iter().any(|tile| &tile.key == key))
        {
            self.focused_key = None;
        }
        self.focused_key
            .clone()
            .or(if self.manual_grid { None } else { auto })
    }

    fn render_stage(&mut self, tiles: Vec<Tile>, cx: &mut Context<Self>) -> AnyElement {
        let size = self.stage_size.get();
        let (width, height) = (f32::from(size.width), f32::from(size.height));
        let spotlight_key = self.spotlight_key(&tiles, cx);
        let spotlight = tiles
            .iter()
            .find(|tile| Some(&tile.key) == spotlight_key.as_ref())
            .cloned();

        let measure = {
            let cell = self.stage_size.clone();
            let entity = cx.entity_id();
            canvas(
                move |bounds, _, cx| {
                    if cell.get() != bounds.size {
                        cell.set(bounds.size);
                        cx.notify(entity);
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_full()
        };

        let stage = div()
            .relative()
            .flex()
            .min_h_0()
            .min_w_0()
            .flex_1()
            .child(measure);

        let Some(spotlight) = spotlight else {
            let aspect = if width < 640.0 {
                (1.0, 2.0)
            } else {
                (16.0 / 9.0, 16.0 / 9.0)
            };
            let grid = fit_tiles_with(width, height, tiles.len(), GAP, aspect.0, aspect.1, 140.0);
            let overflows = grid.rows as f32 * (grid.height + GAP) - GAP > height + 1.0;
            return stage
                .child(
                    div()
                        .id("voice-grid")
                        .flex()
                        .size_full()
                        .flex_wrap()
                        .items_center()
                        .justify_center()
                        .gap(px(GAP))
                        .map(|grid| {
                            if overflows {
                                grid.content_start().overflow_y_scroll()
                            } else {
                                grid.content_center()
                            }
                        })
                        .children(tiles.iter().map(|tile| {
                            let target = tile.clone();
                            let element = self
                                .render_tile(tile, TileSize::Grid(grid.width, grid.height), cx)
                                .on_click(
                                    cx.listener(move |this, _, _, cx| this.focus_tile(&target, cx)),
                                );
                            participant_context_menu(element, &tile.identity, &tile.name, cx)
                        })),
                )
                .into_any_element();
        };

        let rest: Vec<Tile> = tiles
            .iter()
            .filter(|tile| tile.key != spotlight.key)
            .cloned()
            .collect();
        let side = width > height * 1.1;
        let strip = !rest.is_empty() && !self.strip_collapsed;
        let (box_width, box_height) = match (strip, side) {
            (true, true) => (width - SIDE_STRIP_WIDTH - GAP, height),
            (true, false) => (width, height - BOTTOM_STRIP_HEIGHT - GAP),
            _ => (width, height),
        };
        let collapsed = self.strip_collapsed;
        let rest_count = rest.len();
        let circle = SettingsStore::get(cx).circle_icons;

        let spotlight_box = div()
            .group("voice-spotlight")
            .relative()
            .flex()
            .min_h_0()
            .min_w_0()
            .flex_1()
            .items_center()
            .justify_center()
            .child(participant_context_menu(
                self.render_tile(&spotlight, TileSize::Fit(box_width, box_height), cx)
                    .on_click(cx.listener(|this, _, _, cx| this.show_grid(cx))),
                &spotlight.identity,
                &spotlight.name,
                cx,
            ))
            .when(rest_count > 0, |spot| {
                spot.child(
                    div()
                        .id("voice-strip-toggle")
                        .absolute()
                        .map(|toggle| {
                            if side {
                                toggle.top_2().right_2()
                            } else {
                                toggle.bottom_2().right_2()
                            }
                        })
                        .flex()
                        .h_7()
                        .items_center()
                        .gap(px(6.0))
                        .px_2()
                        .bg(black().opacity(0.6))
                        .hover(|toggle| toggle.bg(black().opacity(0.75)))
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(white())
                        .cursor_pointer()
                        .when(circle, |toggle| toggle.rounded_full())
                        .when(!collapsed, |toggle| {
                            toggle
                                .invisible()
                                .group_hover("voice-spotlight", |toggle| toggle.visible())
                        })
                        .child(
                            icon(match (side, collapsed) {
                                (true, true) => "panel-right-open",
                                (true, false) => "panel-right-close",
                                (false, true) => "panel-bottom-open",
                                (false, false) => "panel-bottom-close",
                            })
                            .size(px(14.0)),
                        )
                        .when(collapsed, |toggle| toggle.child(rest_count.to_string()))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.strip_collapsed = !this.strip_collapsed;
                            cx.notify();
                        })),
                )
            });

        let filmstrip = strip.then(|| {
            div()
                .id("voice-filmstrip")
                .flex()
                .flex_shrink_0()
                .gap(px(GAP))
                .map(|strip| {
                    if side {
                        strip
                            .ml(px(GAP))
                            .w(px(SIDE_STRIP_WIDTH))
                            .flex_col()
                            .overflow_y_scroll()
                    } else {
                        strip
                            .mt(px(GAP))
                            .h(px(BOTTOM_STRIP_HEIGHT))
                            .overflow_x_scroll()
                    }
                })
                .children(rest.iter().map(|tile| {
                    let target = tile.clone();
                    div()
                        .flex_shrink_0()
                        .map(|cell| {
                            if side {
                                cell.w_full().h(px(SIDE_STRIP_WIDTH * 9.0 / 16.0))
                            } else {
                                cell.h_full().w(px(BOTTOM_STRIP_HEIGHT * 16.0 / 9.0))
                            }
                        })
                        .child(participant_context_menu(
                            self.render_tile(tile, TileSize::Strip, cx).on_click(
                                cx.listener(move |this, _, _, cx| this.focus_tile(&target, cx)),
                            ),
                            &tile.identity,
                            &tile.name,
                            cx,
                        ))
                }))
        });

        stage
            .child(
                div()
                    .flex()
                    .size_full()
                    .when(side, |stage| stage.flex_row())
                    .when(!side, |stage| stage.flex_col())
                    .child(spotlight_box)
                    .children(filmstrip),
            )
            .into_any_element()
    }

    fn render_tile(&self, tile: &Tile, size: TileSize, cx: &mut Context<Self>) -> Stateful<Div> {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let is_self = self.is_self(&tile.identity, cx);
        let compact = size == TileSize::Strip;
        let frame: Option<Arc<RenderImage>> = VideoFeeds::global(cx)
            .read(cx)
            .frame(&tile.identity, tile.screen);

        let mut el = div()
            .id(SharedString::from(format!("voice-tile-{}", tile.key)))
            .relative()
            .flex_shrink_0()
            .overflow_hidden()
            .border_1()
            .border_color(t.border)
            .bg(if tile.screen { black() } else { t.muted })
            .cursor_pointer()
            .hover(|tile| tile.opacity(0.95));
        el = match size {
            TileSize::Grid(width, height) => el.w(px(width)).h(px(height)),
            TileSize::Fit(width, height) => {
                let aspect = frame
                    .as_ref()
                    .map(|frame| {
                        let size = frame.size(0);
                        size.width.0 as f32 / size.height.0.max(1) as f32
                    })
                    .unwrap_or(16.0 / 9.0);
                let fitted = width.min(height * aspect).max(0.0);
                el.w(px(fitted.floor())).h(px((fitted / aspect).floor()))
            }
            TileSize::Strip => el.size_full(),
        };

        let body: AnyElement = if let Some(frame) = frame {
            // contain, not cover: never crop someone's camera to fit the tile shape
            img(frame)
                .size_full()
                .object_fit(ObjectFit::Contain)
                .into_any_element()
        } else if tile.screen && !is_self {
            div()
                .flex()
                .size_full()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .text_color(white())
                .child(icon("monitor-up").size(px(if compact { 20.0 } else { 32.0 })))
                .when(!compact, |watch| {
                    watch.child(
                        div()
                            .bg(white().opacity(0.1))
                            .px_3()
                            .py(px(6.0))
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Watch Stream"),
                    )
                })
                .into_any_element()
        } else {
            let color = tile
                .member
                .as_ref()
                .and_then(|member| member.avatar_color.clone());
            let bg = color
                .as_deref()
                .and_then(ui::hex)
                .or_else(|| ui::hex(avatar_bg(&tile.identity)))
                .unwrap_or(t.muted);
            let avatar_size = if compact { 40.0 } else { 80.0 };
            div()
                .flex()
                .size_full()
                .items_center()
                .justify_center()
                .bg(bg)
                .child(
                    avatar_with_fallback(
                        tile.member
                            .as_ref()
                            .and_then(|member| member.avatar_url.as_deref()),
                        &tile.name,
                        Some(&initials_for(&tile.name)),
                        color.as_deref(),
                        avatar_size,
                        cx,
                    )
                    .rounded_full()
                    .border_2()
                    .border_color(white().opacity(0.3))
                    .shadow_2xl(),
                )
                .into_any_element()
        };

        let ring = tile
            .member
            .as_ref()
            .and_then(|member| member.speaking_ring_color.as_deref())
            .and_then(ui::hex)
            .or_else(|| ui::hex(SPEAKING_RING))
            .unwrap_or(white());

        el.child(body)
            .when(tile.state.speaking && !tile.screen, |tile| {
                // drawn inside, so it never changes the tile's box
                tile.child(div().absolute().inset_0().border_2().border_color(ring))
            })
            .child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .flex()
                    .max_w_full()
                    .items_center()
                    .gap(px(6.0))
                    .bg(black().opacity(0.65))
                    .px_2()
                    .py_1()
                    .when(compact, |bar| bar.text_size(px(11.0)))
                    .when(!compact, |bar| bar.text_sm())
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(white())
                    .when(tile.screen, |bar| {
                        bar.child(icon("monitor-up").size(px(14.0)).flex_shrink_0())
                    })
                    .child(div().truncate().child(tile.name.clone()))
                    .when(is_self, |bar| {
                        bar.child(
                            div()
                                .flex_shrink_0()
                                .text_color(white().opacity(0.7))
                                .child("(you)"),
                        )
                    }),
            )
            .when(
                !tile.screen && (tile.state.self_muted || tile.state.self_deafened),
                |el| {
                    let badge = if compact { 20.0 } else { 28.0 };
                    el.child(
                        div()
                            .absolute()
                            .bottom(px(6.0))
                            .right(px(6.0))
                            .flex()
                            .size(px(badge))
                            .items_center()
                            .justify_center()
                            .bg(ui::hex(ROSE).unwrap_or(t.destructive))
                            .text_color(white())
                            .when(circle, |badge| badge.rounded_full())
                            .child(
                                icon(if tile.state.self_deafened {
                                    "headphone-off"
                                } else {
                                    "mic-off"
                                })
                                .size(px(if compact {
                                    12.0
                                } else {
                                    16.0
                                })),
                            ),
                    )
                },
            )
    }

    /// The floating controls: mic, deafen, camera, screen, stop watching, leave.
    fn render_controls(
        &self,
        stop_watching: Option<(String, String)>,
        stream_slider: Option<Entity<SliderState>>,
        cx: &mut Context<Self>,
    ) -> Div {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let rose = ui::hex(ROSE).unwrap_or(t.destructive);
        let (muted, deafened, camera, screen) = {
            let voice = Voice::global(cx).read(cx);
            (
                voice.self_muted,
                voice.self_deafened,
                voice.self_camera,
                voice.self_screen_share,
            )
        };
        let control = |id: &'static str, icon_name: &'static str, label: SharedString| {
            div()
                .id(id)
                .flex()
                .size_8()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .bg(t.secondary)
                .text_color(t.foreground)
                .hover(|button| button.opacity(0.85))
                .when(circle, |button| button.rounded_full())
                .child(icon(icon_name).size(px(14.0)))
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx)
                })
        };
        let active = |button: Stateful<Div>, on: bool| {
            button.when(on, |button| {
                button.bg(t.primary).text_color(t.primary_foreground)
            })
        };
        let danger = |button: Stateful<Div>, on: bool| {
            button.when(on, |button| button.bg(rose).text_color(white()))
        };

        let bar = div()
            .id("call-controls")
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.hovering_controls = *hovered;
                cx.notify();
            }))
            .flex()
            .items_center()
            .gap(px(6.0))
            .border_1()
            .border_color(t.border)
            .bg(t.sidebar.opacity(0.8))
            .p_2()
            .shadow_lg()
            .when(circle, |bar| bar.rounded_full())
            .child(
                danger(
                    control(
                        "call-mute",
                        if muted { "mic-off" } else { "mic" },
                        if deafened {
                            "Undeafen"
                        } else if muted {
                            "Unmute"
                        } else {
                            "Mute"
                        }
                        .into(),
                    ),
                    muted,
                )
                .on_click(|_, _, cx| {
                    Voice::global(cx).update(cx, |voice, cx| {
                        if voice.self_deafened {
                            voice.set_deafened(false, cx)
                        } else {
                            voice.set_muted(!voice.self_muted, cx)
                        }
                    })
                }),
            )
            .child(
                danger(
                    control(
                        "call-deafen",
                        if deafened {
                            "headphone-off"
                        } else {
                            "headphones"
                        },
                        if deafened { "Undeafen" } else { "Deafen" }.into(),
                    ),
                    deafened,
                )
                .on_click(|_, _, cx| {
                    Voice::global(cx)
                        .update(cx, |voice, cx| voice.set_deafened(!voice.self_deafened, cx))
                }),
            )
            .child(
                active(
                    control(
                        "call-camera",
                        if camera { "video" } else { "video-off" },
                        if camera {
                            "Turn camera off"
                        } else {
                            "Turn camera on"
                        }
                        .into(),
                    ),
                    camera,
                )
                .on_click(move |_, _, cx| {
                    Voice::global(cx).update(cx, |voice, cx| voice.set_camera(!camera, cx))
                }),
            )
            .child(
                active(
                    control(
                        "call-screen",
                        "monitor-up",
                        if screen {
                            "Stop sharing screen"
                        } else {
                            "Share screen"
                        }
                        .into(),
                    ),
                    screen,
                )
                .on_click(move |_, _, cx| {
                    Voice::global(cx).update(cx, |voice, cx| voice.set_screen_share(!screen, cx))
                }),
            )
            .when_some(stream_slider, |bar, slider| {
                bar.child(
                    Popover::new("call-stream-volume")
                        .anchor(Anchor::BottomCenter)
                        .w(px(192.0))
                        .trigger(
                            crate::ui::trigger::trigger("call-stream-volume-trigger")
                                .flex()
                                .size_8()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .bg(t.secondary)
                                .text_color(t.foreground)
                                .hover(|button| button.opacity(0.85))
                                .when(circle, |button| button.rounded_full())
                                .child(icon("volume-2").size(px(14.0))),
                        )
                        .content(move |_, _, cx| {
                            let percent = slider.read(cx).value().start().round();
                            div()
                                .flex()
                                .w_full()
                                .flex_col()
                                .gap_2()
                                .text_sm()
                                .child(
                                    div()
                                        .flex()
                                        .w_full()
                                        .justify_between()
                                        .child("Stream volume")
                                        .child(format!("{percent}%")),
                                )
                                .child(Slider::new(&slider).w_full())
                        }),
                )
            })
            .when_some(stop_watching, |bar, (identity, name)| {
                bar.child(
                    control(
                        "call-stop-watching",
                        "monitor-off",
                        format!("Stop watching {name}").into(),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        Voice::global(cx)
                            .update(cx, |voice, cx| voice.stop_watching_stream(&identity, cx));
                        this.show_grid(cx);
                    })),
                )
            })
            .child(
                control("call-leave", "phone-off", "Leave call".into())
                    .bg(rose)
                    .text_color(white())
                    .on_click(|_, _, cx| ShellState::leave_voice(cx)),
            );
        div()
            .absolute()
            .bottom_3()
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(bar)
    }
}

impl Render for VoiceArea {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let Some(channel) = Chat::global(cx).read(cx).current_channel(cx) else {
            return div().flex_1().bg(t.background).into_any_element();
        };
        let (connecting, active, reconnecting, participant_count) = {
            let voice = Voice::global(cx).read(cx);
            let in_channel = voice.channel_id.as_deref() == Some(channel.id.as_str());
            (
                in_channel && voice.connecting(),
                in_channel && !voice.connecting(),
                in_channel && voice.connection_state == voice::ConnectionState::Reconnecting,
                voice.participant_count(),
            )
        };

        let fullscreen = !self.embedded && ShellState::global(cx).read(cx).call_fullscreen;
        if fullscreen && !self.focus.is_focused(window) {
            window.focus(&self.focus, cx);
        }
        let fullscreen_button = |id: &'static str| {
            let label = if fullscreen {
                "Exit fullscreen"
            } else {
                "Fullscreen"
            };
            div()
                .id(id)
                .flex()
                .size_8()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .text_color(t.muted_foreground)
                .hover(|button| button.text_color(t.foreground).bg(t.accent))
                .child(
                    icon(if fullscreen {
                        "minimize-2"
                    } else {
                        "maximize-2"
                    })
                    .size_4(),
                )
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
                })
                .on_click(move |_, window, cx| {
                    ShellState::set_call_fullscreen(!fullscreen, window, cx)
                })
        };
        let header = (!self.embedded && !fullscreen).then(|| {
            div()
                .flex()
                .h(tw(12.0))
                .flex_shrink_0()
                .items_center()
                .gap_2()
                .border_b_1()
                .border_color(t.border)
                .px_4()
                .child(icon("volume-2").size_5().text_color(t.muted_foreground))
                .child(
                    div()
                        .truncate()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(channel.name.clone()),
                )
                .when(active, |header| {
                    header.child(
                        div()
                            .flex_shrink_0()
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child(participant_count.to_string()),
                    )
                })
                .when(active, |header| {
                    header.child(div().ml_auto().child(fullscreen_button("call-fullscreen")))
                })
        });

        let centered = || {
            div()
                .flex()
                .min_h_0()
                .flex_1()
                .flex_col()
                .items_center()
                .justify_center()
        };

        let tiles = self.tiles(&channel.id, cx);
        let mut stop_watching = None;
        let body: AnyElement = if connecting {
            centered()
                .gap_3()
                .child(
                    icon("loader-circle")
                        .size_8()
                        .text_color(t.muted_foreground)
                        .with_animation(
                            "voice-connecting",
                            Animation::new(std::time::Duration::from_secs(1)).repeat(),
                            |icon, delta| icon.transform(Transformation::rotate(percentage(delta))),
                        ),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(t.muted_foreground)
                        .child("Joining voice channel..."),
                )
                .into_any_element()
        } else if !active {
            centered()
                .gap_4()
                .p_6()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .child(format!("Join {}", channel.name)),
                        )
                        .child(
                            div()
                                .mt_1()
                                .text_sm()
                                .text_color(t.muted_foreground)
                                .child("Connect when you are ready."),
                        ),
                )
                .child(
                    Button::new("join-voice")
                        .icon(icon("volume-2").size_4())
                        .label("Join Voice")
                        .on_click(|_, _, cx| {
                            let id = Chat::global(cx)
                                .read(cx)
                                .current_channel(cx)
                                .map(|channel| channel.id.clone());
                            if let Some(id) = id {
                                ShellState::select_channel(&id, cx);
                            }
                        }),
                )
                .into_any_element()
        } else if tiles.is_empty() {
            centered()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child("Connected"),
                )
                .child(
                    div()
                        .mt_1()
                        .text_sm()
                        .text_color(t.muted_foreground)
                        .child("No one else is here yet."),
                )
                .into_any_element()
        } else {
            let spotlight = self.spotlight_key(&tiles, cx);
            stop_watching = tiles
                .iter()
                .find(|tile| {
                    Some(&tile.key) == spotlight.as_ref()
                        && tile.screen
                        && !self.is_self(&tile.identity, cx)
                        && Self::has_video(tile, cx)
                })
                .map(|tile| (tile.identity.clone(), tile.name.clone()));
            div()
                .flex()
                .min_h_0()
                .min_w_0()
                .flex_1()
                .p(px(STAGE_PADDING))
                .child(self.render_stage(tiles, cx))
                .into_any_element()
        };

        let stream_slider = stop_watching
            .as_ref()
            .map(|(identity, _)| self.stream_slider(identity, cx));
        let expanded = ShellState::global(cx).read(cx).call_expanded;
        let show_controls = self.controls_visible || self.hovering_controls;
        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(move |_, event: &KeyDownEvent, window, cx| {
                if fullscreen && event.keystroke.key == "escape" {
                    ShellState::set_call_fullscreen(false, window, cx);
                    cx.stop_propagation();
                }
            }))
            .flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .flex_1()
            .flex_col()
            .bg(t.background)
            .children(header)
            .child(
                div()
                    .id("call-stage")
                    .relative()
                    .flex()
                    .min_h_0()
                    .min_w_0()
                    .flex_1()
                    .flex_col()
                    .on_mouse_move(cx.listener(|this, _, _, cx| this.wake_controls(cx)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.wake_controls(cx)),
                    )
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                        if !hovered {
                            this.hide_controls(cx);
                        }
                    }))
                    .when(fullscreen, |stage| {
                        stage.child(
                            div()
                                .absolute()
                                .top_2()
                                .right_2()
                                .bg(t.secondary)
                                .shadow_md()
                                .child(fullscreen_button("call-exit-fullscreen")),
                        )
                    })
                    .when(reconnecting, |stage| {
                        stage.child(
                            div()
                                .flex()
                                .flex_shrink_0()
                                .items_center()
                                .gap_2()
                                .border_b_1()
                                .border_color(t.border)
                                .bg(ui::hex("#f59e0b")
                                    .unwrap_or(t.muted_foreground)
                                    .opacity(0.1))
                                .px_3()
                                .py_2()
                                .text_xs()
                                .text_color(ui::hex("#fbbf24").unwrap_or(t.muted_foreground))
                                .child(ui::spinner("voice-reconnecting"))
                                .child("Reconnecting to voice..."),
                        )
                    })
                    .child(body)
                    .when(active, |stage| {
                        stage
                            .child(
                                self.render_controls(stop_watching, stream_slider, cx)
                                    .when(!show_controls, |controls| controls.invisible()),
                            )
                            .when(self.embedded, |stage| {
                                stage.child(
                                    div()
                                        .id("call-expand")
                                        .when(!show_controls, |button| button.invisible())
                                        .absolute()
                                        .right_4()
                                        .bottom_5()
                                        .flex()
                                        .size_8()
                                        .items_center()
                                        .justify_center()
                                        .cursor_pointer()
                                        .text_color(t.muted_foreground)
                                        .hover(|button| button.text_color(t.foreground))
                                        .child(
                                            icon(if expanded {
                                                "minimize-2"
                                            } else {
                                                "maximize-2"
                                            })
                                            .size_4(),
                                        )
                                        .tooltip(move |window, cx| {
                                            gpui_kit::component::tooltip::Tooltip::new(
                                                if expanded {
                                                    "Show messages"
                                                } else {
                                                    "Expand call"
                                                },
                                            )
                                            .build(window, cx)
                                        })
                                        .on_click(|_, _, cx| ShellState::toggle_call_expanded(cx)),
                                )
                            })
                    }),
            )
            .into_any_element()
    }
}
