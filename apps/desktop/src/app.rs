// The window's content: +layout.svelte plus SvelteKit's router picking the page.
use crate::prelude::*;

use crate::{
    state::{
        self,
        router::{Page, Router},
    },
    theme, views,
};

pub struct AppRoot {
    page: Option<Page>,
    view: Option<AnyView>,
    generation: usize,
    _router: Subscription,
}

/// Bumped by `restart_session`, the desktop's `window.location.href = '/'`.
#[derive(Default)]
struct Generation(usize);
impl Global for Generation {}

impl AppRoot {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let router = Router::global(cx);
        let _router = cx.observe_in(&router, window, |this, _, window, cx| this.sync(window, cx));
        let mut this = Self {
            page: None,
            view: None,
            generation: 0,
            _router,
        };
        this.sync(window, cx);
        this
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let page = Router::global(cx).read(cx).page();
        let generation = cx.default_global::<Generation>().0;
        let same_page = match (&self.page, &page) {
            // the shell follows /guilds/... routes itself
            (Some(Page::Guilds(_)), Page::Guilds(_)) => true,
            (Some(old), new) => old == new,
            (None, _) => false,
        };
        if same_page && generation == self.generation && self.view.is_some() {
            return;
        }
        self.generation = generation;
        self.view = Some(views::page_view(&page, window, cx));
        self.page = Some(page);
        cx.notify();
    }
}

/// Signs into another account (or back in): drops every store and boots the shell again.
pub fn restart_session(cx: &mut App) {
    state::reset(cx);
    cx.default_global::<Generation>().0 += 1;
    state::router::goto("/guilds", cx);
    Router::global(cx).update(cx, |_, cx| cx.notify());
}

impl Render for AppRoot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.background)
            .text_color(t.foreground)
            .font_family("IBM Plex Sans")
            .when(!window.is_fullscreen(), |root| {
                root.child(views::titlebar::titlebar(cx))
            })
            .child(div().flex_1().min_h_0().children(self.view.clone()))
    }
}
