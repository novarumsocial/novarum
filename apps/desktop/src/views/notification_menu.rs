// Port of apps/frontend/src/lib/components/notification-menu.svelte. Stub until ported: appends the
// notification and mute submenus to a context menu.
use gpui_kit::component::menu::PopupMenu;

use crate::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Noun {
    Server,
    Channel,
    Conversation,
}

pub fn notification_menu(
    menu: PopupMenu,
    target_id: &str,
    guild_id: Option<&str>,
    noun: Noun,
    _window: &mut Window,
    _cx: &mut App,
) -> PopupMenu {
    let _ = (target_id, guild_id, noun);
    menu
}
