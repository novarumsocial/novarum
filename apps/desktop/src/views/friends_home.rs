// Port of apps/frontend/src/lib/components/friends-home.svelte. Stub until ported: the shell lays it out.
use crate::prelude::*;

pub struct FriendsHome {}

impl FriendsHome {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {}
    }
}

impl Render for FriendsHome {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        div().flex_1().h_full()
    }
}
