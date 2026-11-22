// The web app's `$lib/*.svelte.ts` stores, as gpui entities reachable through globals.
pub mod router;
pub mod session;
pub mod settings;

use futures::future::{FutureExt, Shared};
use gpui_kit::*;

pub fn init(cx: &mut App) {
    router::init(cx);
    settings::init(cx);
    session::init(cx);
}

/// Drops everything tied to the signed-in account, for switching accounts.
pub fn reset(cx: &mut App) {
    session::init(cx);
    cx.remove_global::<BootTask>();
}

#[derive(Clone)]
struct BootTask(Shared<Task<bool>>);
impl Global for BootTask {}

/// app-shell.svelte's `boot()`: the session, then everything the shell needs on screen.
/// Shared, so the launch splash and the shell wait on the same work. Resolves to whether
/// someone is signed in.
pub fn boot(cx: &mut App) -> Shared<Task<bool>> {
    if let Some(task) = cx.try_global::<BootTask>() {
        return task.0.clone();
    }
    let task = cx
        .spawn(async move |cx| {
            crate::api::refresh_info().await;
            let refresh = cx.update(|cx| session::Session::refresh(cx));
            if refresh.await.is_none() {
                return false;
            }
            let load = cx.update(|cx| load_signed_in(cx));
            load.await;
            true
        })
        .shared();
    cx.set_global(BootTask(task.clone()));
    task
}

/// `Promise.all([chat.loadInitialData(), friends.load(), notificationSettings.load()])`
fn load_signed_in(_cx: &mut App) -> Task<()> {
    Task::ready(())
}
