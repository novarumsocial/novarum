// The web app's `$lib/*.svelte.ts` stores, as gpui entities reachable through globals.
// the views use most of these as they're ported
pub mod audio_engine;
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
pub mod screen_audio;
pub mod session;
pub mod settings;
pub mod video;
pub mod voice;
pub mod voice_capture;
pub mod voice_room;

use futures::future::{FutureExt, Shared};
use gpui_kit::*;

pub fn init(cx: &mut App) {
    router::init(cx);
    settings::init(cx);
    session::init(cx);
    voice::init(cx);
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
    voice::Voice::global(cx)
        .update(cx, |voice, cx| voice.leave(cx))
        .detach();
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
    // started here rather than in the task, so the requests go out before the window opens.
    // the session check runs against the cached base url while discovery refreshes it; if
    // discovery moved the server, the check runs again against the new one. the lists load
    // meanwhile, and are dropped if nobody turns out to be signed in
    let base_url = crate::api::base_url();
    let refresh = session::Session::refresh(cx);
    let lists = load_lists(cx);
    let info = crate::runtime::io(crate::api::refresh_info());
    let task = cx
        .spawn(async move |cx| {
            let (user, _) = futures::join!(refresh, info);
            let (user, lists) = match user {
                None if crate::api::base_url() != base_url => {
                    let user = cx.update(session::Session::refresh).await;
                    (user, cx.update(load_lists))
                }
                user => (user, lists),
            };
            if user.is_none() {
                return false;
            }
            crate::startup::mark("signed in");
            cx.update(realtime::Realtime::connect);
            let (chat_lists, rest) = lists;
            chat_lists.await;
            let channel = cx.update(|cx| {
                chat::Chat::global(cx).update(cx, |chat, cx| chat.open_initial_channel(cx))
            });
            channel.await;
            rest.await;
            crate::startup::mark("signed-in data loaded");
            true
        })
        .shared();
    cx.set_global(BootTask(task.clone()));
    task
}

/// `Promise.all([chat.loadInitialData(), friends.load(), notificationSettings.load()])`, minus
/// the initial channel: the chat's lists, then friends and notification settings.
fn load_lists(cx: &mut App) -> (Task<()>, Task<()>) {
    let chat = chat::Chat::global(cx).update(cx, |chat, cx| chat.load_lists(cx));
    let friends = friends::Friends::global(cx).update(cx, |friends, cx| friends.load(cx));
    let notifications = notification_settings::NotificationSettings::global(cx)
        .update(cx, |settings, cx| settings.load(cx));
    let rest = cx.spawn(async move |_| {
        futures::join!(friends, notifications);
    });
    (chat, rest)
}
