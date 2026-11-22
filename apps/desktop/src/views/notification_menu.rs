// Port of apps/frontend/src/lib/components/notification-menu.svelte: the "Mute" and "Notify"
// submenus of a right-click menu, for a guild, channel or DM.
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};

use crate::prelude::*;

use crate::state::notification_settings::{NotificationChange, NotificationLevel, NotificationSettings, Target};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Noun {
    Server,
    Channel,
    #[allow(dead_code)] // the DM sidebar's
    Conversation,
}

impl Noun {
    fn label(self) -> &'static str {
        match self {
            Noun::Server => "Server",
            Noun::Channel => "Channel",
            Noun::Conversation => "Conversation",
        }
    }
}

const MUTES: [(&str, Option<f64>); 4] = [
    ("For 1 Hour", Some(1.0)),
    ("For 8 Hours", Some(8.0)),
    ("For 24 Hours", Some(24.0)),
    ("Until I turn it back on", None),
];

const LEVELS: [(NotificationLevel, &str); 3] = [
    (NotificationLevel::All, "All Messages"),
    (NotificationLevel::Mentions, "Only Mentions"),
    (NotificationLevel::None, "Nothing"),
];

pub fn notification_menu(
    menu: PopupMenu,
    target_id: &str,
    guild_id: Option<&str>,
    noun: Noun,
    window: &mut Window,
    cx: &mut App,
) -> PopupMenu {
    let store = NotificationSettings::global(cx);
    let (level, muted, has_setting) = {
        let settings = store.read(cx);
        // a guild is its own parent here, so it falls back to the guild default (mentions)
        let guild_id = if noun == Noun::Server { Some(target_id) } else { guild_id };
        (
            settings.level(Target { channel_id: target_id, guild_id }),
            settings.is_muted(target_id),
            settings.entries.contains_key(target_id),
        )
    };
    let target = SharedString::from(target_id.to_string());

    let mute_menu = PopupMenu::build(window, cx, {
        let (store, target) = (store.clone(), target.clone());
        move |menu, _, _| {
            let unmute = {
                let (store, target) = (store.clone(), target.clone());
                PopupMenuItem::new("Unmute").on_click(move |_, _, cx| {
                    store.update(cx, |store, cx| store.unmute(target.to_string(), level, cx)).detach();
                })
            };
            MUTES.iter().fold(menu.when(muted, |menu| menu.item(unmute)), |menu, &(label, hours)| {
                let (store, target) = (store.clone(), target.clone());
                menu.item(PopupMenuItem::new(label).on_click(move |_, _, cx| {
                    store.update(cx, |store, cx| store.mute(target.to_string(), hours, level, cx)).detach();
                }))
            })
        }
    });

    let notify_menu = PopupMenu::build(window, cx, {
        let (store, target) = (store.clone(), target.clone());
        move |menu, _, _| {
            let menu = LEVELS.iter().fold(menu, |menu, &(value, label)| {
                let (store, target) = (store.clone(), target.clone());
                menu.item(PopupMenuItem::new(label).checked(level == value).on_click(move |_, _, cx| {
                    let change = NotificationChange { level: Some(value), ..Default::default() };
                    store.update(cx, |store, cx| store.set(target.to_string(), change, level, cx)).detach();
                }))
            });
            let (store, target) = (store.clone(), target.clone());
            menu.when(has_setting, |menu| {
                menu.separator().item(PopupMenuItem::new("Use Default").on_click(move |_, _, cx| {
                    store.update(cx, |store, cx| store.reset(target.to_string(), cx)).detach();
                }))
            })
        }
    });

    let mute_label = if muted { format!("Muted {}", noun.label()) } else { format!("Mute {}", noun.label()) };
    menu.item(PopupMenuItem::submenu(mute_label, mute_menu).icon(icon("bell-off")))
        .item(PopupMenuItem::submenu("Notify", notify_menu).icon(icon("bell")))
}
