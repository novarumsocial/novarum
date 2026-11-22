// Port of apps/frontend/src/lib/components/settings-devices.svelte: the phones that get your push
// notifications.
use std::{rc::Rc, time::Duration};

use chrono::{DateTime, Local};
use serde::Deserialize;

use crate::prelude::*;
use crate::{
    api, state::settings::SettingsStore, util::format_date::format_date,
    views::settings_group::settings_group,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DeviceKind {
    Webpush,
    Unifiedpush,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub kind: DeviceKind,
    pub host: String,
    pub created_at: String,
    pub current: bool,
}

#[derive(Deserialize)]
struct DevicesPayload {
    subscriptions: Vec<Device>,
}

pub fn added_label(created_at: &str, now: &DateTime<Local>) -> String {
    let date = DateTime::parse_from_rfc3339(created_at)
        .map(|date| format_date(&date.with_timezone(&Local), now))
        .unwrap_or_default();
    match date.as_str() {
        "Today" | "Yesterday" => format!("Added {}", date.to_lowercase()),
        _ => format!("Added {date}"),
    }
}

type OpenNotifications = Rc<dyn Fn(&mut Window, &mut App)>;

pub struct SettingsDevices {
    devices: Vec<Device>,
    loading: bool,
    load_error: bool,
    confirming_id: Option<String>,
    removing_id: Option<String>,
    remove_error: Option<String>,
    on_open_notifications: OpenNotifications,
    _confirm_timer: Option<Task<()>>,
}

impl SettingsDevices {
    pub fn new(on_open_notifications: OpenNotifications, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            devices: vec![],
            loading: true,
            load_error: false,
            confirming_id: None,
            removing_id: None,
            remove_error: None,
            on_open_notifications,
            _confirm_timer: None,
        };
        this.load(cx);
        this
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.load_error = false;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = api::get::<DevicesPayload>("/notifications/subscriptions").await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(payload) => this.devices = payload.subscriptions,
                    Err(_) => this.load_error = true,
                }
                this.loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn remove(&mut self, device: Device, cx: &mut Context<Self>) {
        self.remove_error = None;
        self._confirm_timer = None;
        if self.confirming_id.as_ref() != Some(&device.id) {
            self.confirming_id = Some(device.id);
            self._confirm_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(4)).await;
                let _ = this.update(cx, |this, cx| {
                    this.confirming_id = None;
                    cx.notify();
                });
            }));
            cx.notify();
            return;
        }
        self.confirming_id = None;
        self.removing_id = Some(device.id.clone());
        // this app would register itself again on its next start, so it stops asking for pushes too
        if device.current {
            SettingsStore::update(cx, |settings| settings.push_notifications = false);
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result =
                api::delete::<api::Ignored>(format!("/notifications/subscriptions/{}", device.id))
                    .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Err(error) if error.status != 404 && !device.current => {
                        this.remove_error = Some(format!(
                            "Couldn't remove {}. Check your connection and try again.",
                            device.host
                        ))
                    }
                    _ => this.devices.retain(|item| item.id != device.id),
                }
                this.removing_id = None;
                cx.notify();
            });
        })
        .detach();
    }

    fn render_device(&self, device: &Device, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let confirming = self.confirming_id.as_ref() == Some(&device.id);
        let removing = self.removing_id.as_ref() == Some(&device.id);
        let detail = if confirming {
            if device.current {
                "Click again to remove. This also turns off push notifications here.".to_string()
            } else {
                "Click again to remove. It stops getting notifications.".to_string()
            }
        } else {
            added_label(&device.created_at, &Local::now())
        };
        let target = device.clone();
        div()
            .flex()
            .items_center()
            .gap_3()
            .px_4()
            .py(px(14.0))
            .child(
                div()
                    .flex()
                    .size_9()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .bg(t.muted)
                    .text_color(t.muted_foreground)
                    .when(circle, |icon| icon.rounded_full())
                    .child(icon("smartphone").size_4()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(div().truncate().child(device.host.clone()))
                            .when(device.current, |name| {
                                name.child(
                                    div()
                                        .flex_shrink_0()
                                        .bg(t.primary.opacity(0.3))
                                        .px(px(6.0))
                                        .py(px(2.0))
                                        .text_size(px(11.0))
                                        .text_color(t.foreground)
                                        .child("This device"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .mt(px(2.0))
                            .text_xs()
                            .text_color(if confirming {
                                t.destructive
                            } else {
                                t.muted_foreground
                            })
                            .child(detail),
                    ),
            )
            .child(
                Button::new(SharedString::from(format!("remove-{}", device.id)))
                    .small()
                    .when(confirming, |button| button.danger())
                    .when(!confirming, |button| button.ghost())
                    .disabled(removing)
                    .when(removing, |button| button.loading(true).label("Removing"))
                    .when(!removing, |button| {
                        button.label(if confirming {
                            "Confirm remove"
                        } else {
                            "Remove"
                        })
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.remove(target.clone(), cx))),
            )
            .into_any_element()
    }
}

impl Render for SettingsDevices {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let circle = SettingsStore::get(cx).circle_icons;
        let phones: Vec<Device> = self
            .devices
            .iter()
            .filter(|device| device.kind == DeviceKind::Unifiedpush)
            .cloned()
            .collect();
        let rows: Vec<AnyElement> = if self.loading {
            vec![
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_4()
                    .py_6()
                    .text_sm()
                    .text_color(t.muted_foreground)
                    .child(ui::spinner("devices-loading"))
                    .child("Loading devices…")
                    .into_any_element(),
            ]
        } else if self.load_error {
            vec![
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .px_4()
                    .py_4()
                    .child(ui::muted(
                        "Couldn't load your devices. Check your connection and try again.",
                        cx,
                    ))
                    .child(
                        Button::new("devices-retry")
                            .outline()
                            .small()
                            .icon(icon("refresh-cw"))
                            .label("Retry")
                            .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                    )
                    .into_any_element(),
            ]
        } else if phones.is_empty() {
            let open = self.on_open_notifications.clone();
            vec![
                div()
                    .flex()
                    .items_start()
                    .gap_3()
                    .px_4()
                    .py(px(14.0))
                    .child(
                        div()
                            .flex()
                            .size_9()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .border_1()
                            .border_dashed()
                            .border_color(t.muted_foreground.opacity(0.3))
                            .text_color(t.muted_foreground)
                            .when(circle, |icon| icon.rounded_full())
                            .child(icon("smartphone").size_4()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("No phones yet"))
                            .child(div().mt(px(2.0)).text_xs().text_color(t.muted_foreground).child(
                                "Turn on push notifications in the Android app, with a UnifiedPush distributor like ntfy.",
                            ))
                            .child(
                                div().mt_3().child(
                                    Button::new("open-notifications")
                                        .outline()
                                        .small()
                                        .label("Notification settings")
                                        .on_click(move |_, window, cx| open(window, cx)),
                                ),
                            ),
                    )
                    .into_any_element(),
            ]
        } else {
            phones
                .iter()
                .map(|device| self.render_device(device, cx))
                .collect()
        };

        div()
            .flex()
            .flex_col()
            .gap_6()
            .child(settings_group(
                Some("Push notifications"),
                Some("Remove a phone to stop its notifications. Signing out of it does the same."),
                rows,
                cx,
            ))
            .when_some(self.remove_error.clone(), |devices, error| {
                devices.child(div().text_xs().text_color(t.destructive).child(error))
            })
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Local, TimeZone};

    use super::{Device, DeviceKind, added_label};

    #[test]
    fn labels_when_a_device_was_added() {
        let now = Local.with_ymd_and_hms(2026, 11, 22, 15, 0, 0).unwrap();
        let today = now.to_rfc3339();
        assert_eq!(added_label(&today, &now), "Added today");
        let old = Local
            .with_ymd_and_hms(2026, 3, 4, 9, 0, 0)
            .unwrap()
            .to_rfc3339();
        assert_eq!(added_label(&old, &now), "Added Mar 4, 2026");
    }

    #[test]
    fn reads_the_subscription_payload() {
        let device: Device = serde_json::from_str(
            r#"{"id":"1","kind":"UNIFIEDPUSH","host":"ntfy.sh","createdAt":"2026-01-01T00:00:00.000Z","current":false}"#,
        )
        .unwrap();
        assert_eq!(device.kind, DeviceKind::Unifiedpush);
    }
}
