// Port of apps/frontend/src/lib/components/user-area.svelte. Stub until ported: the shell lays it out.
use crate::prelude::*;

pub struct UserArea {}

impl UserArea {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {}
    }
}

impl Render for UserArea {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        div().w_full().h(px(56.0)).bg(t.sidebar)
    }
}
