pub mod auth;
pub mod auth_card;
pub mod authorize;
pub mod constellation;
pub mod initial_loader;
pub mod invite;
pub mod login;
pub mod register;
pub mod reset_password;
pub mod shell;
pub mod titlebar;
pub mod updater;

use crate::prelude::*;

use crate::state::router::Page;

/// One view per SvelteKit route.
pub fn page_view(page: &Page, window: &mut Window, cx: &mut App) -> AnyView {
    match page {
        Page::Login => cx.new(|cx| login::LoginPage::new(window, cx)).into(),
        Page::Register => cx.new(|cx| register::RegisterPage::new(window, cx)).into(),
        Page::ResetPassword => cx.new(|cx| reset_password::ResetPasswordPage::new(window, cx)).into(),
        Page::Authorize => cx.new(|cx| authorize::AuthorizePage::new(window, cx)).into(),
        Page::Invite(code) => cx.new(|cx| invite::InvitePage::new(code.clone(), window, cx)).into(),
        Page::Guilds(_) => cx.new(|cx| shell::AppShell::new(window, cx)).into(),
        // ported in its own milestone; until then it lands on sign-in
        Page::Updater => cx.new(|cx| login::LoginPage::new(window, cx)).into(),
    }
}
