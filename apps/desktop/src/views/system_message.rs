// Port of apps/frontend/src/lib/components/system-message.svelte: "Ana added Leo", a call...
use chrono::Local;

use crate::prelude::*;

use crate::{
    models::{Message, SystemMessage},
    state::settings::SettingsStore,
    util::{format_date::format_time, system_message::system_text},
};

pub fn system_icon(system: &SystemMessage) -> &'static str {
    match system {
        SystemMessage::GroupCreated => "users",
        SystemMessage::MemberAdded { .. } | SystemMessage::BotAdded { .. } => "user-plus",
        SystemMessage::MemberRemoved { .. } | SystemMessage::BotRemoved { .. } => "user-minus",
        SystemMessage::MemberLeft => "log-out",
        SystemMessage::OwnerChanged { .. } => "crown",
        SystemMessage::GroupRenamed { .. } => "pencil",
        SystemMessage::GroupIcon => "image",
        SystemMessage::Call { missed: true, .. } => "phone-missed",
        SystemMessage::Call { .. } => "phone",
    }
}

pub fn system_message(message: &Message, system: &SystemMessage, cx: &App) -> Div {
    let t = theme::tokens(cx);
    let color = match system {
        SystemMessage::Call { missed: true, .. } => t.destructive,
        // text-green-500
        SystemMessage::Call { .. } => rgb(0x22c55e).into(),
        _ => t.muted_foreground,
    };
    let time = format_time(
        &message.timestamp.with_timezone(&Local),
        SettingsStore::get(cx).time_format,
    );
    div()
        .flex()
        .items_center()
        .gap_3()
        .py_1()
        .text_sm()
        .text_color(t.muted_foreground)
        .child(
            div()
                .flex()
                .w_9()
                .flex_shrink_0()
                .justify_center()
                .child(icon(system_icon(system)).size_4().text_color(color)),
        )
        .child(
            div()
                .flex()
                .flex_1()
                .flex_wrap()
                .items_baseline()
                .min_w_0()
                .child(system_text(
                    system,
                    message.author.display_name.as_deref(),
                    &message.author.username,
                ))
                .child(
                    div()
                        .ml_1()
                        .text_size(px(10.0))
                        .text_color(t.muted_foreground.opacity(0.6))
                        .child(time),
                ),
        )
}
