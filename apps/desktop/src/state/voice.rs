// Port of apps/frontend/src/lib/voice.svelte.ts. Placeholder API until the LiveKit port: the shell
// and sidebars call these, the voice milestone fills them in.
use gpui_kit::*;

use crate::state::realtime::Realtime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

pub struct Voice {
    pub channel_id: Option<String>,
    pub connection_state: ConnectionState,
}

struct GlobalVoice(Entity<Voice>);
impl Global for GlobalVoice {}

pub fn init(cx: &mut App) {
    let voice = cx.new(|_| Voice { channel_id: None, connection_state: ConnectionState::Disconnected });
    cx.set_global(GlobalVoice(voice));
}

impl Voice {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalVoice>().0.clone()
    }

    pub fn join(&mut self, channel_id: &str, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        self.channel_id = Some(channel_id.to_string());
        Realtime::global(cx).update(cx, |realtime, _| realtime.join_voice(channel_id));
        cx.notify();
        Task::ready(Ok(()))
    }

    pub fn leave(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.channel_id = None;
        self.connection_state = ConnectionState::Disconnected;
        Realtime::global(cx).update(cx, |realtime, _| realtime.leave_voice());
        cx.notify();
        Task::ready(())
    }
}
