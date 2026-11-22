pub mod auth;
pub mod constellation;
pub mod initial_loader;
pub mod login;
pub mod shell;
pub mod titlebar;
pub mod updater;

use crate::prelude::*;

use crate::state::router::Page;

/// One view per SvelteKit route.
pub fn page_view(page: &Page, window: &mut Window, cx: &mut App) -> AnyView {
    match page {
        Page::Login => cx.new(|cx| login::LoginPage::new(window, cx)).into(),
        Page::Guilds(_) => cx.new(|cx| shell::AppShell::new(window, cx)).into(),
        // ported in their own milestones; until then they land on sign-in
        Page::Register | Page::ResetPassword | Page::Authorize | Page::Invite(_) | Page::Updater => {
            cx.new(|cx| login::LoginPage::new(window, cx)).into()
        }
    }
}
