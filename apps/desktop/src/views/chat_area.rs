// Port of apps/frontend/src/lib/components/chat-area.svelte. Stub until ported: the shell lays it out.
use crate::prelude::*;

pub struct ChatArea {}

impl ChatArea {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {}
    }
}

impl Render for ChatArea {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        div().flex_1().min_w_0().h_full()
    }
}
