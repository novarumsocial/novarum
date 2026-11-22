// `app.setBadgeCount`: the Unity launcher entry on Linux (docks and Plasma read it), the dock
// tile on macOS. Windows would need a taskbar overlay icon drawn per count, so it has none.
#![allow(dead_code)]
use gpui_kit::App;

#[cfg(target_os = "linux")]
pub fn set_badge_count(count: usize, _cx: &mut App) {
    use std::collections::HashMap;
    use tokio::sync::OnceCell;
    use zbus::zvariant::Value;

    static SESSION: OnceCell<Option<zbus::Connection>> = OnceCell::const_new();
    crate::runtime::handle().spawn(async move {
        let session = SESSION.get_or_init(|| async { zbus::Connection::session().await.ok() }).await;
        let Some(session) = session else { return };
        let properties =
            HashMap::from([("count", Value::from(count as i64)), ("count-visible", Value::from(count > 0))]);
        let _ = session
            .emit_signal(
                None::<&str>,
                "/com/canonical/unity/launcherentry/novarum",
                "com.canonical.Unity.LauncherEntry",
                "Update",
                &("application://novarum.desktop", properties),
            )
            .await;
    });
}

#[cfg(target_os = "macos")]
pub fn set_badge_count(count: usize, _cx: &mut App) {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::NSString;

    let Some(main_thread) = objc2::MainThreadMarker::new() else { return };
    let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
    NSApplication::sharedApplication(main_thread).dockTile().setBadgeLabel(label.as_deref());
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn set_badge_count(_count: usize, _cx: &mut App) {}
