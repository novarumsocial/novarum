// What apps/electron/src/main.ts did around the web app: auto-launch, launching hidden, the tray,
// the unread badge, and closing to the tray.
use gpui_kit::*;

/// `--hidden` from the autostart entry, when the user wants to start hidden.
pub fn launch_hidden() -> bool {
    std::env::args().any(|arg| arg == "--hidden") && crate::updater::launch_prefs().start_hidden
}

pub fn apply_auto_launch(enabled: bool) {
    if !crate::updater::supported() {
        return;
    }
    #[cfg(target_os = "linux")]
    {
        let Some(home) = dirs::home_dir() else { return };
        let entry = home.join(".config/autostart/novarum.desktop");
        if !enabled {
            let _ = std::fs::remove_file(entry);
            return;
        }
        let exec = std::env::var("APPIMAGE")
            .ok()
            .or_else(|| std::env::current_exe().ok().map(|path| path.display().to_string()))
            .unwrap_or_default();
        let _ = std::fs::create_dir_all(entry.parent().unwrap());
        let _ = std::fs::write(
            entry,
            format!("[Desktop Entry]\nType=Application\nName=Novarum\nExec=\"{exec}\" --hidden\nIcon=novarum\n"),
        );
    }
    #[cfg(not(target_os = "linux"))]
    let _ = enabled;
}

/// Rebuilds the tray menu after the update status changes. Filled in with the tray port.
pub fn update_tray(_cx: &mut App) {}

/// `app.setBadgeCount`. Filled in with the tray port.
pub fn set_badge_count(_count: usize, _cx: &mut App) {}
