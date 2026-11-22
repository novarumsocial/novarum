// Port of apps/frontend/src/lib/notification-settings.svelte.ts, with anchor's
// utils/notificationLevel.ts (shared with the server's push, so both agree on what notifies).
use std::collections::HashMap;

use chrono::{DateTime, SecondsFormat, Utc};
use gpui_kit::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{api, state::router::encode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum NotificationLevel {
    All,
    Mentions,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEntry {
    pub level: NotificationLevel,
    #[serde(default)]
    pub muted_until: Option<String>,
}

pub type NotificationEntries = HashMap<String, NotificationEntry>;

/// A channel, and the guild it's in (none for DMs).
#[derive(Debug, Clone, Copy)]
pub struct Target<'a> {
    pub channel_id: &'a str,
    pub guild_id: Option<&'a str>,
}

fn muted_at(muted_until: Option<&str>, now: DateTime<Utc>) -> bool {
    muted_until
        .and_then(|until| DateTime::parse_from_rfc3339(until).ok())
        .is_some_and(|until| until > now)
}

fn entry_level(entry: Option<&NotificationEntry>, now: DateTime<Utc>) -> Option<NotificationLevel> {
    let entry = entry?;
    Some(if muted_at(entry.muted_until.as_deref(), now) {
        NotificationLevel::None
    } else {
        entry.level
    })
}

/// the channel's setting wins, then the guild's, then the default: everything in a DM, only
/// mentions in a guild.
pub fn effective_level(
    entries: &NotificationEntries,
    target: Target,
    now: DateTime<Utc>,
) -> NotificationLevel {
    entry_level(entries.get(target.channel_id), now)
        .or_else(|| {
            target
                .guild_id
                .and_then(|guild| entry_level(entries.get(guild), now))
        })
        .unwrap_or(if target.guild_id.is_some() {
            NotificationLevel::Mentions
        } else {
            NotificationLevel::All
        })
}

/// a DM message counts as a mention, since it is always addressed to you.
pub fn level_allows(level: NotificationLevel, mentioned: bool) -> bool {
    level == NotificationLevel::All || (level == NotificationLevel::Mentions && mentioned)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setting {
    target_id: String,
    #[serde(flatten)]
    entry: NotificationEntry,
}

#[derive(Deserialize)]
struct SettingsPayload {
    settings: Vec<Setting>,
}

/// `{ level?, mutedUntil? }`: `None` keeps what's there; `Some(None)` unmutes.
#[derive(Debug, Clone, Default)]
pub struct NotificationChange {
    pub level: Option<NotificationLevel>,
    pub muted_until: Option<Option<String>>,
}

/// "until I turn it back on"
const FOREVER: &str = "9999-12-31T00:00:00.000Z";

pub struct NotificationSettings {
    pub entries: NotificationEntries,
}

struct GlobalNotificationSettings(Entity<NotificationSettings>);
impl Global for GlobalNotificationSettings {}

pub fn init(cx: &mut App) {
    let store = cx.new(|_| NotificationSettings {
        entries: HashMap::new(),
    });
    cx.set_global(GlobalNotificationSettings(store));
}

impl NotificationSettings {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalNotificationSettings>().0.clone()
    }

    pub fn load(&mut self, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let Ok(payload) = api::get::<SettingsPayload>("/notifications/settings").await else {
                return;
            };
            let _ = this.update(cx, |store, cx| {
                store.entries = payload
                    .settings
                    .into_iter()
                    .map(|item| (item.target_id, item.entry))
                    .collect();
                cx.notify();
            });
        })
    }

    pub fn level(&self, target: Target) -> NotificationLevel {
        effective_level(&self.entries, target, Utc::now())
    }

    /// a timed mute: hides the unread dot and silences notifications, but mention badges stay.
    pub fn is_muted(&self, target_id: &str) -> bool {
        muted_at(
            self.entries
                .get(target_id)
                .and_then(|entry| entry.muted_until.as_deref()),
            Utc::now(),
        )
    }

    /// unread dots are hidden when muted or set to nothing...
    pub fn shows_unread(&self, target: Target) -> bool {
        self.level(target) != NotificationLevel::None
    }

    /// ...but mention badges only disappear for "nothing", not for a plain mute.
    pub fn shows_mentions(&self, target: Target) -> bool {
        self.level(target) != NotificationLevel::None
            || self.is_muted(target.channel_id)
            || target.guild_id.is_some_and(|guild| self.is_muted(guild))
    }

    pub fn set(
        &mut self,
        target_id: String,
        change: NotificationChange,
        default_level: NotificationLevel,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let current = self.entries.get(&target_id);
        let next = NotificationEntry {
            level: change
                .level
                .or(current.map(|entry| entry.level))
                .unwrap_or(default_level),
            muted_until: change
                .muted_until
                .unwrap_or_else(|| current.and_then(|entry| entry.muted_until.clone())),
        };
        let previous = self.entries.clone();
        self.entries.insert(target_id.clone(), next.clone());
        cx.notify();

        let muted_until = next
            .muted_until
            .as_deref()
            .and_then(|until| DateTime::parse_from_rfc3339(until).ok())
            .map(|until| {
                until
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            });
        cx.spawn(async move |this, cx| {
            let body = json!({ "level": next.level, "mutedUntil": muted_until });
            let path = format!("/notifications/settings/{}", encode(&target_id));
            if api::put::<api::Ignored>(path, body).await.is_err() {
                let _ = this.update(cx, |store, cx| {
                    store.entries = previous;
                    cx.notify();
                });
            }
        })
    }

    pub fn mute(
        &mut self,
        target_id: String,
        hours: Option<f64>,
        default_level: NotificationLevel,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let until = match hours {
            Some(hours) if hours > 0.0 => (Utc::now()
                + chrono::Duration::milliseconds((hours * 3_600_000.0) as i64))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
            _ => FOREVER.into(),
        };
        let change = NotificationChange {
            muted_until: Some(Some(until)),
            ..Default::default()
        };
        self.set(target_id, change, default_level, cx)
    }

    pub fn unmute(
        &mut self,
        target_id: String,
        default_level: NotificationLevel,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let change = NotificationChange {
            muted_until: Some(None),
            ..Default::default()
        };
        self.set(target_id, change, default_level, cx)
    }

    pub fn reset(&mut self, target_id: String, cx: &mut Context<Self>) -> Task<()> {
        let previous = self.entries.clone();
        self.entries.remove(&target_id);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let path = format!("/notifications/settings/{}", encode(&target_id));
            if api::delete::<api::Ignored>(path).await.is_err() {
                let _ = this.update(cx, |store, cx| {
                    store.entries = previous;
                    cx.notify();
                });
            }
        })
    }

    /// push is decided on the server, so these two are mirrored there
    pub fn save_preferences(
        push: Option<bool>,
        message_preview: Option<bool>,
        cx: &mut App,
    ) -> Task<()> {
        let mut body = serde_json::Map::new();
        if let Some(push) = push {
            body.insert("push".into(), push.into());
        }
        if let Some(message_preview) = message_preview {
            body.insert("messagePreview".into(), message_preview.into());
        }
        cx.spawn(async move |_| {
            let _ = api::put::<api::Ignored>("/notifications/preferences", body).await;
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{TimeZone, Utc};

    use super::{NotificationEntry, NotificationLevel, Target, effective_level, level_allows};

    fn entry(level: NotificationLevel, muted_until: Option<&str>) -> NotificationEntry {
        NotificationEntry {
            level,
            muted_until: muted_until.map(str::to_string),
        }
    }

    #[test]
    fn the_channel_wins_then_the_guild_then_the_default() {
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let guild = Target {
            channel_id: "c",
            guild_id: Some("g"),
        };
        let dm = Target {
            channel_id: "d",
            guild_id: None,
        };
        let mut entries = HashMap::new();
        assert_eq!(
            effective_level(&entries, guild, now),
            NotificationLevel::Mentions
        );
        assert_eq!(effective_level(&entries, dm, now), NotificationLevel::All);

        entries.insert("g".into(), entry(NotificationLevel::All, None));
        assert_eq!(
            effective_level(&entries, guild, now),
            NotificationLevel::All
        );
        entries.insert(
            "c".into(),
            entry(
                NotificationLevel::Mentions,
                Some("2027-01-01T00:00:00.000Z"),
            ),
        );
        assert_eq!(
            effective_level(&entries, guild, now),
            NotificationLevel::None
        );
        entries.insert(
            "c".into(),
            entry(
                NotificationLevel::Mentions,
                Some("2025-01-01T00:00:00.000Z"),
            ),
        );
        assert_eq!(
            effective_level(&entries, guild, now),
            NotificationLevel::Mentions
        );
    }

    #[test]
    fn levels_allow_mentions_or_everything() {
        assert!(level_allows(NotificationLevel::All, false));
        assert!(level_allows(NotificationLevel::Mentions, true));
        assert!(!level_allows(NotificationLevel::Mentions, false));
        assert!(!level_allows(NotificationLevel::None, true));
    }
}
