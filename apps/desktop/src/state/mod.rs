// The web app's `$lib/*.svelte.ts` stores, as gpui entities reachable through globals.
// the views use most of these as they're ported
#[allow(dead_code)]
pub mod bots;
#[allow(dead_code)]
pub mod chat;
#[allow(dead_code)]
pub mod dms;
#[allow(dead_code)]
pub mod friends;
#[allow(dead_code)]
pub mod notification_settings;
#[allow(dead_code)]
pub mod realtime;
pub mod router;
pub mod session;
pub mod settings;

use futures::future::{FutureExt, Shared};
use gpui_kit::*;

pub fn init(cx: &mut App) {
    router::init(cx);
    settings::init(cx);
    session::init(cx);
    crate::notifications::init(cx);
    init_account(cx);
}

/// The stores that belong to the signed-in account.
fn init_account(cx: &mut App) {
    chat::init(cx);
    dms::init(cx);
    friends::init(cx);
    bots::init(cx);
    notification_settings::init(cx);
    realtime::init(cx);
}

/// Drops everything tied to the signed-in account, for switching accounts.
pub fn reset(cx: &mut App) {
    realtime::Realtime::disconnect(cx);
    session::init(cx);
    init_account(cx);
    cx.remove_global::<BootTask>();
}

#[derive(Clone)]
struct BootTask(Shared<Task<bool>>);
impl Global for BootTask {}

/// app-shell.svelte's `boot()`: the session, then the realtime socket and everything the shell
/// needs on screen. Shared, so the launch splash and the shell wait on the same work. Resolves to
/// whether someone is signed in.
pub fn boot(cx: &mut App) -> Shared<Task<bool>> {
    if let Some(task) = cx.try_global::<BootTask>() {
        return task.0.clone();
    }
    let task = cx
        .spawn(async move |cx| {
            crate::api::refresh_info().await;
            let refresh = cx.update(session::Session::refresh);
            if refresh.await.is_none() {
                return false;
            }
            let load = cx.update(|cx| {
                realtime::Realtime::connect(cx);
                load_signed_in(cx)
            });
            load.await;
            true
        })
        .shared();
    cx.set_global(BootTask(task.clone()));
    task
}

/// `Promise.all([chat.loadInitialData(), friends.load(), notificationSettings.load()])`
fn load_signed_in(cx: &mut App) -> Task<()> {
    let chat = chat::Chat::global(cx).update(cx, |chat, cx| chat.load_initial_data(cx));
    let friends = friends::Friends::global(cx).update(cx, |friends, cx| friends.load(cx));
    let notifications = notification_settings::NotificationSettings::global(cx).update(cx, |settings, cx| settings.load(cx));
    cx.spawn(async move |_| {
        futures::join!(chat, friends, notifications);
    })
}
