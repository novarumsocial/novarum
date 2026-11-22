// Port of apps/frontend/src/lib/components/app-shell.svelte.
use std::time::Duration;

use crate::prelude::*;

use crate::{
    models::{ChannelType, DmType},
    state::{
        self,
        chat::Chat,
        dms::{Dms, dm_path},
        friends::Friends,
        notification_settings::{NotificationSettings, Target},
        realtime::Realtime,
        router::{self, ChatRoute, Router},
        session::Session,
        settings::SettingsStore,
        voice::{ConnectionState, Voice},
    },
    views::{
        call_ringing::CallRinging, channel_sidebar::ChannelSidebar, chat_area::ChatArea,
        developers_home::DevelopersHome, dm_sidebar::DmSidebar, friends_home::FriendsHome,
        group_members::GroupMembers, guild_sidebar::GuildSidebar, initial_loader::InitialLoader,
        member_sidebar::MemberSidebar, user_area::UserArea, voice_area::VoiceArea,
    },
};

/// Tailwind's `md` and `lg` breakpoints: below them the sidebars become drawers.
pub const MD: f32 = 768.0;
pub const LG: f32 = 1024.0;

/// Set when the launch splash already booted the app, so the shell skips its own loader
/// (`window.electron.behindSplash`).
pub struct BehindSplash;
impl Global for BehindSplash {}

/// The shell's own state that the panels act on (`mobileNavigationOpen`, `callExpanded`...).
pub struct ShellState {
    pub mobile_navigation_open: bool,
    pub mobile_members_open: bool,
    pub call_expanded: bool,
    /// `window.innerWidth`, kept by the shell for the panels' breakpoints.
    pub width: f32,
}

struct GlobalShell(Entity<ShellState>);
impl Global for GlobalShell {}

impl ShellState {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalShell>().0.clone()
    }

    fn set(cx: &mut App, edit: impl FnOnce(&mut ShellState)) {
        Self::global(cx).update(cx, |shell, cx| {
            edit(shell);
            cx.notify();
        });
    }

    pub fn open_navigation(cx: &mut App) {
        Self::set(cx, |shell| {
            shell.mobile_members_open = false;
            shell.mobile_navigation_open = true;
        });
    }

    pub fn close_navigation(cx: &mut App) {
        Self::set(cx, |shell| shell.mobile_navigation_open = false);
    }

    pub fn open_members(cx: &mut App) {
        Self::set(cx, |shell| {
            shell.mobile_navigation_open = false;
            shell.mobile_members_open = true;
        });
    }

    pub fn close_members(cx: &mut App) {
        Self::set(cx, |shell| shell.mobile_members_open = false);
    }

    pub fn toggle_members(cx: &mut App) {
        if Self::global(cx).read(cx).width >= LG {
            SettingsStore::update(cx, |settings| settings.show_member_list = !settings.show_member_list);
        } else {
            Self::open_members(cx);
        }
    }

    pub fn toggle_call_expanded(cx: &mut App) {
        Self::set(cx, |shell| shell.call_expanded = !shell.call_expanded);
    }

    /// `startCall`: joins the call and rings the others if nobody is in it yet.
    pub fn start_call(id: &str, cx: &mut App) {
        let ring = Chat::global(cx).read(cx).voice_states.get(id).is_none_or(Vec::is_empty);
        let voice = Voice::global(cx);
        let join = voice.update(cx, |voice, cx| voice.join(id, cx));
        let id = id.to_string();
        cx.spawn(async move |cx| {
            if join.await.is_ok() && ring {
                cx.update(|cx| {
                    if voice.read(cx).channel_id.as_deref() == Some(&id) {
                        Realtime::global(cx).update(cx, |realtime, cx| realtime.ring_call(&id, true, cx));
                    }
                });
            }
        })
        .detach();
    }

    pub fn leave_voice(cx: &mut App) {
        Self::set(cx, |shell| shell.call_expanded = false);
        Voice::global(cx).update(cx, |voice, cx| voice.leave(cx)).detach();
    }

    /// `selectChannel`: voice channels join the call; the chat only opens once you're in it.
    pub fn select_channel(id: &str, cx: &mut App) {
        let chat = Chat::global(cx);
        let kind = chat
            .read(cx)
            .current_categories(cx)
            .iter()
            .flat_map(|category| &category.channels)
            .find(|channel| channel.id == id)
            .map(|channel| channel.kind);
        Self::close_navigation(cx);
        let voice = Voice::global(cx).read(cx);
        let in_call = voice.connection_state != ConnectionState::Disconnected
            && voice.channel_id.as_deref() == Some(id);
        if kind != Some(ChannelType::Voice) || in_call {
            chat.update(cx, |chat, cx| chat.select_channel(id, cx));
        }
        if kind == Some(ChannelType::Voice) {
            Voice::global(cx).update(cx, |voice, cx| voice.join(id, cx)).detach();
        }
    }

    /// `goto(dmPath(id)); startCall(id)`, for accepting a ringing call.
    pub fn accept_call(id: &str, cx: &mut App) {
        router::goto(dm_path(id, None), cx);
        Self::start_call(id, cx);
    }
}

struct Panels {
    guild_sidebar: Entity<GuildSidebar>,
    channel_sidebar: Entity<ChannelSidebar>,
    dm_sidebar: Entity<DmSidebar>,
    user_area: Entity<UserArea>,
    friends_home: Entity<FriendsHome>,
    developers_home: Entity<DevelopersHome>,
    chat_area: Entity<ChatArea>,
    voice_area: Entity<VoiceArea>,
    member_sidebar: Entity<MemberSidebar>,
    group_members: Entity<GroupMembers>,
    call_ringing: Entity<CallRinging>,
}

pub struct AppShell {
    booting: bool,
    loader: Entity<InitialLoader>,
    panels: Option<Panels>,
    unread_total: usize,
    _subscriptions: Vec<Subscription>,
}

impl AppShell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        if !cx.has_global::<GlobalShell>() {
            let shell = cx.new(|_| ShellState {
                mobile_navigation_open: false,
                mobile_members_open: false,
                call_expanded: false,
                width: 1100.0,
            });
            cx.set_global(GlobalShell(shell));
        }
        let behind_splash = cx.has_global::<BehindSplash>();
        let subscriptions = vec![
            cx.observe(&Router::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Session::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Chat::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Dms::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Friends::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&NotificationSettings::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&SettingsStore::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&Voice::global(cx), |_, _, cx| cx.notify()),
            cx.observe(&ShellState::global(cx), |_, _, cx| cx.notify()),
            crate::views::settings_dialog::watch(window, cx),
            // the server skips push for users with an active window, so it has to hear when this one stops being it
            cx.observe_window_activation(window, |_, window, cx| {
                Realtime::set_window_active(window.is_window_active(), cx);
            }),
        ];

        let loader = cx.new(|_| InitialLoader::new());
        let boot = state::boot(cx);
        cx.spawn_in(window, async move |this, cx| {
            let signed_in = boot.await;
            if !signed_in {
                let _ = cx.update(|_, cx| router::goto("/login", cx));
                return;
            }
            if !behind_splash {
                let _ = this.update(cx, |this, cx| this.loader.update(cx, |loader, cx| loader.finish(cx)));
                cx.background_executor().timer(Duration::from_millis(100)).await;
            }
            let _ = this.update_in(cx, |this, window, cx| {
                this.booting = false;
                this.panels = Some(Panels {
                    guild_sidebar: cx.new(|cx| GuildSidebar::new(window, cx)),
                    channel_sidebar: cx.new(|cx| ChannelSidebar::new(window, cx)),
                    dm_sidebar: cx.new(|cx| DmSidebar::new(window, cx)),
                    user_area: cx.new(|cx| UserArea::new(window, cx)),
                    friends_home: cx.new(|cx| FriendsHome::new(window, cx)),
                    developers_home: cx.new(|cx| DevelopersHome::new(window, cx)),
                    chat_area: cx.new(|cx| ChatArea::new(window, cx)),
                    voice_area: cx.new(|cx| VoiceArea::new(window, cx)),
                    member_sidebar: cx.new(|cx| MemberSidebar::new(window, cx)),
                    group_members: cx.new(|cx| GroupMembers::new(window, cx)),
                    call_ringing: cx.new(|cx| CallRinging::new(window, cx)),
                });
                cx.notify();
            });
        })
        .detach();

        Self { booting: !behind_splash, loader, panels: None, unread_total: 0, _subscriptions: subscriptions }
    }

    /// Mentions across guilds plus unread DMs: the title and the launcher badge.
    fn unread_total(cx: &App) -> usize {
        let chat = Chat::global(cx).read(cx);
        let notifications = NotificationSettings::global(cx).read(cx);
        let mentions: u32 = chat
            .channels_by_server
            .iter()
            .flat_map(|(guild_id, categories)| {
                categories.iter().flat_map(|category| &category.channels).map(move |channel| (guild_id, channel))
            })
            .filter(|(guild_id, channel)| {
                notifications.shows_mentions(Target { channel_id: &channel.id, guild_id: Some(guild_id) })
            })
            .map(|(_, channel)| channel.mention)
            .sum();
        let unread_dms = Dms::global(cx)
            .read(cx)
            .list
            .iter()
            .filter(|dm| dm.unread && notifications.shows_unread(Target { channel_id: &dm.id, guild_id: None }))
            .count();
        mentions as usize + unread_dms
    }
}

fn scrim(id: &'static str, on_click: fn(&mut App)) -> Stateful<Div> {
    div().id(id).absolute().inset_0().bg(black().opacity(0.6)).on_click(move |_, _, cx| on_click(cx))
}

impl Render for AppShell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.booting {
            return div().size_full().child(self.loader.clone()).into_any_element();
        }
        let t = theme::tokens(cx);
        let Some(panels) = &self.panels else { return div().size_full().bg(t.background).into_any_element() };
        if Session::user(cx).is_none() {
            return div().size_full().bg(t.background).into_any_element();
        }

        let width = f32::from(window.viewport_size().width);
        let shell = ShellState::global(cx);
        if shell.read(cx).width != width {
            shell.update(cx, |shell, _| shell.width = width);
        }
        let (navigation_open, members_open) = {
            let shell = shell.read(cx);
            (shell.mobile_navigation_open, shell.mobile_members_open)
        };

        let unread = Self::unread_total(cx);
        if unread != self.unread_total {
            self.unread_total = unread;
            window.set_window_title(&if unread > 0 { format!("({unread}) Novarum") } else { "Novarum".into() });
            crate::desktop::set_badge_count(unread, cx);
        }

        let chat = Chat::global(cx).read(cx);
        let route = chat.route(cx);
        let has_server = chat.current_server(cx).is_some();
        let current_channel = chat.current_channel(cx);
        let current_group = match &route {
            ChatRoute::Dms { channel_id: Some(id), .. } => {
                Dms::global(cx).read(cx).get(id).is_some_and(|dm| dm.kind == DmType::GroupDm)
            }
            _ => false,
        };
        // a voice channel's call takes the whole width, so it has no member list
        let show_members = (matches!(route, ChatRoute::Guild { .. })
            && current_channel.as_ref().is_some_and(|channel| channel.kind != ChannelType::Voice))
            || current_group;
        let show_member_list = SettingsStore::get(cx).show_member_list;
        let home_like = matches!(route, ChatRoute::Home | ChatRoute::Dms { .. } | ChatRoute::Developers { .. });
        let narrow = width < MD;
        let below_lg = width < LG;

        let navigation = div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .h_full()
            .bg(t.sidebar)
            .when(narrow, |nav| nav.absolute().top_0().left_0().max_w(px(width - 48.0)))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(panels.guild_sidebar.clone())
                    .when(has_server, |nav| nav.child(panels.channel_sidebar.clone()))
                    .when(home_like, |nav| nav.child(panels.dm_sidebar.clone())),
            )
            .child(panels.user_area.clone());

        let main: AnyElement = match (&route, &current_channel) {
            (ChatRoute::Home, _) => panels.friends_home.clone().into_any_element(),
            (ChatRoute::Developers { .. }, _) => panels.developers_home.clone().into_any_element(),
            (_, Some(channel)) if channel.kind != ChannelType::Voice => panels.chat_area.clone().into_any_element(),
            (_, Some(_)) => panels.voice_area.clone().into_any_element(),
            _ => {
                let dms_route = matches!(route, ChatRoute::Dms { .. });
                div()
                    .relative()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .justify_center()
                    .bg(t.background)
                    .px_6()
                    .when(narrow, |main| {
                        main.child(
                            div()
                                .id("browse-channels")
                                .absolute()
                                .top_3()
                                .left_3()
                                .min_h_10()
                                .px_3()
                                .flex()
                                .items_center()
                                .border_1()
                                .border_color(t.border)
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .cursor_pointer()
                                .child("Browse channels")
                                .on_click(|_, _, cx| ShellState::open_navigation(cx)),
                        )
                    })
                    .child(
                        div()
                            .max_w(px(384.0))
                            .flex()
                            .flex_col()
                            .items_center()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(
                                if dms_route { "No conversation selected" } else { "No channel selected" },
                            ))
                            .child(div().mt_1().text_sm().text_color(t.muted_foreground).child(if dms_route {
                                "Pick a direct message to begin."
                            } else {
                                "Pick a server or create one to begin."
                            })),
                    )
                    .into_any_element()
            }
        };

        let members = div()
            .w(px(224.0))
            .h_full()
            .flex_shrink_0()
            .when(below_lg, |members| members.absolute().top_0().right_0())
            .child(if current_group {
                panels.group_members.clone().into_any_element()
            } else {
                panels.member_sidebar.clone().into_any_element()
            });

        let mut root = div().relative().flex().size_full().overflow_hidden().bg(t.background);
        let mut drawer = None;
        if !narrow {
            root = root.child(navigation);
        } else if navigation_open {
            drawer = Some(navigation);
        }
        root = root.child(main);
        if show_members && !below_lg && show_member_list {
            root = root.child(members);
        } else if show_members && below_lg && members_open {
            root = root.child(scrim("close-members", ShellState::close_members)).child(members);
        }
        if let Some(navigation) = drawer {
            root = root.child(scrim("close-navigation", ShellState::close_navigation)).child(navigation);
        }
        root.child(panels.call_ringing.clone()).into_any_element()
    }
}
