// Port of apps/frontend/src/lib/components/call-ringing.svelte. Stub until ported: the shell lays it out.
use crate::prelude::*;

pub struct CallRinging {}

impl CallRinging {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {}
    }
}

impl Render for CallRinging {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        div().absolute().size_0()
    }
}
