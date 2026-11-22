// Port of apps/frontend/src/lib/components/dm-sidebar.svelte. Stub until ported: the shell lays it out.
use crate::prelude::*;

pub struct DmSidebar {}

impl DmSidebar {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {}
    }
}

impl Render for DmSidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        div().w(px(240.0)).h_full().bg(t.sidebar)
    }
}
