// Port of apps/frontend/src/lib/components/app-shell.svelte.
use std::time::Duration;

use crate::prelude::*;

use crate::{
    state::{self, router, session::Session},
    theme,
    views::initial_loader::InitialLoader,
};

pub struct AppShell {
    booting: bool,
    loader: Entity<InitialLoader>,
    _router: Subscription,
    _session: Subscription,
}

/// Set when the launch splash already booted the app, so the shell skips its own loader
/// (`window.electron.behindSplash`).
pub struct BehindSplash;
impl Global for BehindSplash {}

impl AppShell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let behind_splash = cx.has_global::<BehindSplash>();
        let _router = cx.observe(&router::Router::global(cx), |_, _, cx| cx.notify());
        let _session = cx.observe(&Session::global(cx), |_, _, cx| cx.notify());
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
            let _ = this.update(cx, |this, cx| {
                this.booting = false;
                cx.notify();
            });
        })
        .detach();
        Self { booting: !behind_splash, loader, _router, _session }
    }
}

impl Render for AppShell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.booting {
            return div().size_full().child(self.loader.clone()).into_any_element();
        }
        let t = theme::tokens(cx);
        let user = Session::user(cx);
        div()
            .size_full()
            .flex()
            .bg(t.background)
            .when_some(user, |shell, user| {
                shell.child(
                    div()
                        .m_auto()
                        .text_sm()
                        .text_color(t.muted_foreground)
                        .child(format!("Signed in as {}", user.handle)),
                )
            })
            .into_any_element()
    }
}
