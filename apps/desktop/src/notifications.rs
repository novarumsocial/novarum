// Port of apps/frontend/src/lib/notifications.ts: OS notifications through notify-rust, and the
// notification sound.
use futures::{StreamExt, channel::mpsc};
use gpui_kit::*;

use crate::{
    models::MessageData,
    sounds,
    state::{
        notification_settings::{NotificationEntries, Target, effective_level, level_allows},
        router,
        settings::SettingsStore,
    },
    util::utils::mentions_everyone,
};

pub struct NotifyContext<'a> {
    pub user_id: &'a str,
    pub handle: &'a str,
    pub active_channel_id: Option<&'a str>,
    pub has_focus: bool,
    pub entries: &'a NotificationEntries,
}

/// one place decides whether a new message is worth a sound or a notification; the server's push
/// uses the same effective_level/level_allows pair, so the two never disagree.
pub fn should_notify(message: &MessageData, context: &NotifyContext) -> bool {
    if message.author.user_id == context.user_id {
        return false;
    }
    if context.active_channel_id == Some(message.channel_id.as_str()) && context.has_focus {
        return false;
    }
    let is_dm = message.guild_id.is_none();
    let mentioned = is_dm
        || mentions_everyone(message.content.as_deref())
        || message
            .pinged_handles
            .iter()
            .any(|handle| handle.eq_ignore_ascii_case(context.handle));
    let target = Target {
        channel_id: &message.channel_id,
        guild_id: message.guild_id.as_deref(),
    };
    level_allows(
        effective_level(context.entries, target, chrono::Utc::now()),
        mentioned,
    )
}

/// "Ana (#general · Rustaceans)", or just "Ana" in a DM (`names` is `None`).
pub fn message_notification_title(
    display_name: Option<&str>,
    username: &str,
    names: Option<(Option<&str>, Option<&str>)>,
) -> String {
    let name = display_name
        .filter(|name| !name.is_empty())
        .unwrap_or(username);
    match names {
        Some((channel, guild)) => {
            format!(
                "{name} (#{} · {})",
                channel.unwrap_or("channel"),
                guild.unwrap_or("server")
            )
        }
        None => name.to_string(),
    }
}

/// notification sound by universfield in pixabay (https://pixabay.com/users/universfield-28281460/)
pub fn notification_sound(cx: &App) {
    sounds::play("notification", SettingsStore::get(cx).notification_volume);
}

pub struct NotificationOptions {
    pub title: String,
    pub body: Option<String>,
    /// a newer notification with the same tag replaces the old one
    pub tag: Option<String>,
    /// where a click takes you, through `router::goto`
    pub on_click: Option<String>,
}

struct Clicks(mpsc::UnboundedSender<String>);
impl Global for Clicks {}

/// Clicked notifications come back on another thread; this brings them to the window.
pub fn init(cx: &mut App) {
    let (sender, mut receiver) = mpsc::unbounded::<String>();
    cx.set_global(Clicks(sender));
    cx.spawn(async move |cx| {
        while let Some(path) = receiver.next().await {
            cx.update(|cx| {
                cx.activate(true);
                router::goto(path, cx);
            });
        }
    })
    .detach();
}

/// Shows an OS notification. Clicking it opens `on_click` where the platform reports clicks
/// (freedesktop notification servers); elsewhere it only shows.
pub fn send_notification(notification: NotificationOptions, cx: &App) {
    let clicks = cx.try_global::<Clicks>().map(|clicks| clicks.0.clone());
    std::thread::spawn(move || {
        let mut builder = notify_rust::Notification::new();
        builder.appname("Novarum").summary(&notification.title);
        if let Some(body) = &notification.body {
            builder.body(body);
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            use std::hash::{Hash, Hasher};
            if let Some(tag) = &notification.tag {
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                tag.hash(&mut hasher);
                builder.id((hasher.finish() as u32).max(1));
            }
            if notification.on_click.is_some() {
                builder.action("default", "Open");
            }
            let Ok(handle) = builder.show() else { return };
            if let (Some(path), Some(clicks)) = (notification.on_click, clicks) {
                handle.wait_for_action(|action| {
                    if action == "default" {
                        let _ = clicks.unbounded_send(path);
                    }
                });
            }
        }
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        {
            let _ = (clicks, notification.tag, notification.on_click);
            let _ = builder.show();
        }
    });
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{NotifyContext, message_notification_title, should_notify};
    use crate::{
        models::{MessageData, PublicUser},
        state::notification_settings::{NotificationEntry, NotificationLevel},
    };

    fn message(guild_id: Option<&str>, content: &str, pinged: &[&str]) -> MessageData {
        MessageData {
            id: "m".into(),
            channel_id: "c".into(),
            guild_id: guild_id.map(str::to_string),
            content: Some(content.into()),
            nonce: None,
            reply_to: None,
            edited: false,
            edited_time: None,
            pinged_handles: pinged.iter().map(|handle| handle.to_string()).collect(),
            attachments: vec![],
            created_at: "2026-01-01T00:00:00.000Z".into(),
            author: PublicUser {
                user_id: "other".into(),
                username: "leo".into(),
                homeserver: "x".into(),
                display_name: None,
                avatar_url: None,
                avatar_color: None,
                speaking_ring_color: None,
                banner_url: None,
                about: None,
                is_bot: false,
            },
            embeds: vec![],
            components: vec![],
            interaction: None,
            system: None,
            ephemeral: false,
        }
    }

    #[test]
    fn notifies_for_dms_and_mentions_only() {
        let entries = HashMap::new();
        let context = NotifyContext {
            user_id: "me",
            handle: "@ana:x",
            active_channel_id: None,
            has_focus: true,
            entries: &entries,
        };
        assert!(should_notify(&message(None, "hi", &[]), &context));
        assert!(!should_notify(&message(Some("g"), "hi", &[]), &context));
        assert!(should_notify(
            &message(Some("g"), "hi", &["@ANA:x"]),
            &context
        ));
        assert!(should_notify(
            &message(Some("g"), "hi @everyone", &[]),
            &context
        ));
    }

    #[test]
    fn stays_quiet_in_the_open_channel_and_for_own_messages() {
        let entries = HashMap::new();
        let silenced = HashMap::from([(
            "c".to_string(),
            NotificationEntry {
                level: NotificationLevel::None,
                muted_until: None,
            },
        )]);
        let mut context = NotifyContext {
            user_id: "other",
            handle: "@ana:x",
            active_channel_id: Some("c"),
            has_focus: true,
            entries: &entries,
        };
        assert!(!should_notify(&message(None, "hi", &[]), &context));
        context.user_id = "me";
        assert!(!should_notify(&message(None, "hi", &[]), &context));
        context.has_focus = false;
        assert!(should_notify(&message(None, "hi", &[]), &context));

        context.entries = &silenced;
        assert!(!should_notify(&message(None, "hi", &[]), &context));
    }

    #[test]
    fn titles_name_the_channel_and_guild() {
        assert_eq!(message_notification_title(Some("Ana"), "ana", None), "Ana");
        assert_eq!(
            message_notification_title(None, "ana", Some((Some("general"), None))),
            "ana (#general · server)"
        );
    }
}
