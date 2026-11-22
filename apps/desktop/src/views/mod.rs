pub mod animated_image;
pub mod attachment_viewer;
pub mod audio_player;
pub mod auth;
pub mod auth_card;
pub mod authorize;
pub mod avatar_crop_dialog;
pub mod bot_badge;
pub mod call_ringing;
pub mod channel_sidebar;
pub mod chat_area;
pub mod color_picker;
pub mod command_form;
pub mod constellation;
pub mod create_channel_dialog;
pub mod create_server_dialog;
pub mod developers_home;
pub mod dm_sidebar;
pub mod edit_channel_dialog;
pub mod emoji_text;
pub mod friends_home;
pub mod group_members;
pub mod group_settings_dialog;
pub mod guild_settings_dialog;
pub mod guild_sidebar;
pub mod initial_loader;
pub mod invite;
pub mod invite_dialog;
pub mod login;
pub mod markdown;
pub mod member_sidebar;
pub mod message;
pub mod message_components;
pub mod message_embed;
pub mod message_input;
pub mod mic_level_meter;
pub mod mic_test;
pub mod new_dm_dialog;
pub mod notification_menu;
pub mod profile_card;
pub mod register;
pub mod reset_password;
pub mod settings_devices;
pub mod settings_dialog;
pub mod settings_group;
pub mod settings_row;
pub mod shell;
pub mod system_message;
pub mod titlebar;
pub mod updater;
pub mod user_area;
pub mod video_player;
pub mod voice_area;

use crate::prelude::*;

use crate::state::router::Page;

/// One view per SvelteKit route.
pub fn page_view(page: &Page, window: &mut Window, cx: &mut App) -> AnyView {
    match page {
        Page::Login => cx.new(|cx| login::LoginPage::new(window, cx)).into(),
        Page::Register => cx.new(|cx| register::RegisterPage::new(window, cx)).into(),
        Page::ResetPassword => cx
            .new(|cx| reset_password::ResetPasswordPage::new(window, cx))
            .into(),
        Page::Authorize => cx
            .new(|cx| authorize::AuthorizePage::new(window, cx))
            .into(),
        Page::Invite(code) => cx
            .new(|cx| invite::InvitePage::new(code.clone(), window, cx))
            .into(),
        Page::Guilds(_) => cx.new(|cx| shell::AppShell::new(window, cx)).into(),
        // ported in its own milestone; until then it lands on sign-in
        Page::Updater => cx.new(|cx| login::LoginPage::new(window, cx)).into(),
    }
}
