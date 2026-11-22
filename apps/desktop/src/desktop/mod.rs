// What apps/electron/src/main.ts did around the web app: auto-launch, launching hidden, the tray,
// the unread badge, closing to the tray and opening links in the browser.
mod badge;
mod instance;
mod tray;

use futures::{StreamExt, channel::mpsc};
use gpui_kit::*;

// the shell calls these once unread counts and the settings page are ported
#[allow(unused_imports)]
pub use badge::set_badge_count;
pub use instance::claim as claim_single_instance;
pub use tray::update_tray;

/// What the tray menu and later launches ask the running app to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Show,
    Install,
    Quit,
}

pub type Actions = mpsc::UnboundedSender<Action>;

/// Starts the tray and the single-instance listener. Closing the main window only removes it
/// (the app quits explicitly), so both are the way back in.
pub fn init(cx: &mut App) {
    let (actions, mut requests) = mpsc::unbounded();
    instance::listen(actions.clone());
    tray::create(actions, cx);
    cx.spawn(async move |cx| {
        while let Some(action) = requests.next().await {
            cx.update(|cx| match action {
                Action::Show => show_main_window(cx),
                Action::Install => crate::updater::Updater::install(cx),
                Action::Quit => cx.quit(),
            });
        }
    })
    .detach();
}

/// Without a tray there is no way back to a closed window, so behave like a plain app.
fn no_tray(cx: &mut App) {
    cx.set_quit_mode(QuitMode::LastWindowClosed);
    if cx.windows().is_empty() {
        crate::open_main_window(cx);
    }
}

/// `showWindow`: focuses the open window, or reopens the main window closed to the tray.
pub fn show_main_window(cx: &mut App) {
    match cx.windows().first() {
        Some(window) => {
            let _ = window.update(cx, |_, window, _| window.activate_window());
        }
        None => crate::open_main_window(cx),
    }
    cx.activate(true);
}

#[allow(dead_code)]
/// `openExternalUrl`: only http(s) links leave the app.
pub fn open_url(url: &str, cx: &App) {
    if let Some(url) = external_url(url) {
        cx.open_url(url.as_str());
    }
}

fn external_url(url: &str) -> Option<url::Url> {
    url::Url::parse(url).ok().filter(|url| matches!(url.scheme(), "http" | "https"))
}

/// `--hidden` from the autostart entry, when the user wants to start hidden.
pub fn launch_hidden() -> bool {
    std::env::args().any(|arg| arg == "--hidden") && crate::updater::launch_prefs().start_hidden
}

#[allow(dead_code)]
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
    // `app.setLoginItemSettings`: a launch agent on macOS, the Run key on Windows
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let Ok(exe) = std::env::current_exe() else { return };
        let launcher = auto_launch::AutoLaunchBuilder::new()
            .set_app_name("Novarum")
            .set_app_path(&exe.to_string_lossy())
            .set_args(&["--hidden"])
            .set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser)
            .build();
        let result = launcher.and_then(|launcher| if enabled { launcher.enable() } else { launcher.disable() });
        if let Err(error) = result {
            eprintln!("Could not change the launch at login setting: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_http_links_open_externally() {
        assert!(super::external_url("https://novarum.me/invite/abc").is_some());
        assert!(super::external_url("http://localhost:5173").is_some());
        assert!(super::external_url("file:///etc/passwd").is_none());
        assert!(super::external_url("javascript:alert(1)").is_none());
        assert!(super::external_url("not a url").is_none());
    }
}
