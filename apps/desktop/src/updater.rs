// The auto-updater of apps/electron/src/main.ts (electron-updater on the `dev` prerelease channel).
// Releases tagged `v<version>` carry a signed `novarum-desktop-update.json` (cargo-packager's
// updater manifest) pointing at the AppImage, the macOS .app or the NSIS installer; the updater
// verifies the download against `PUBKEY` and swaps in whichever of those Novarum runs from.
use std::time::Duration;

use cargo_packager_updater::{Update, UpdaterBuilder, WindowsConfig, WindowsUpdateInstallMode};
use gpui_kit::*;
use serde::{Deserialize, Serialize};

use crate::{api, runtime, storage};

const RELEASES_URL: &str =
    "https://api.github.com/repos/novarumsocial/novarum/releases?per_page=30";
const MANIFEST: &str = "novarum-desktop-update.json";
/// minisign public key; the private half signs releases in CI
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENBREM3NTIyOEM0Mzg1NTcKUldSWGhVT01JblhjeXEzK2E2RnNnaGZFYjhtUk5lVzNMOGtXcGxERTdyQVpoVzh0ek5SSDlJbEkK";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Downloaded,
    Error,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpdateStatus {
    pub status: Status,
    pub version: Option<String>,
    /// Download progress, 0-100.
    pub percent: Option<f32>,
}

/// launch-prefs.json of the Electron app.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchPrefs {
    pub auto_launch: bool,
    pub start_hidden: bool,
    /// Download updates in the background and install them when Novarum quits.
    pub auto_update: bool,
}

impl Default for LaunchPrefs {
    fn default() -> Self {
        Self {
            auto_launch: false,
            start_hidden: true,
            auto_update: true,
        }
    }
}

pub fn launch_prefs() -> LaunchPrefs {
    storage::get("novarum:launch-prefs").unwrap_or_default()
}

pub fn set_launch_prefs(prefs: LaunchPrefs) {
    storage::set("novarum:launch-prefs", &prefs);
    crate::desktop::apply_auto_launch(prefs.auto_launch);
}

pub struct Updater {
    pub status: UpdateStatus,
    update: Option<Update>,
    downloaded: Option<Vec<u8>>,
    busy: bool,
}

struct GlobalUpdater(Entity<Updater>);
impl Global for GlobalUpdater {}

/// Release builds installed in a form that can replace itself, like `app.isPackaged`: the
/// AppImage, the macOS bundle or the Windows install. A .deb updates through the package manager.
pub fn supported() -> bool {
    !cfg!(debug_assertions)
        && std::env::var_os("NOVARUM_NO_UPDATE").is_none()
        && (cfg!(windows) || std::env::var_os("APPIMAGE").is_some() || app_bundle().is_some())
}

/// The `Novarum.app` this binary runs from, on macOS.
fn app_bundle() -> Option<std::path::PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(|path| path.to_path_buf())
}

pub fn init(cx: &mut App) {
    let status = if supported() {
        Status::Idle
    } else {
        Status::Unsupported
    };
    let updater = cx.new(|_| Updater {
        status: UpdateStatus {
            status,
            version: None,
            percent: None,
        },
        update: None,
        downloaded: None,
        busy: false,
    });
    cx.set_global(GlobalUpdater(updater.clone()));

    // the background check every 30 minutes
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor()
                .timer(Duration::from_secs(30 * 60))
                .await;
            if launch_prefs().auto_update {
                let _ = cx.update(|cx| Updater::check(cx));
            }
        }
    })
    .detach();
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    assets: Vec<GithubAsset>,
}

/// Silent: no installer window, no recreated shortcuts (`/NS`), and Novarum restarts (`/R`).
fn windows_install(relaunch: bool) -> WindowsConfig {
    let mut config = WindowsConfig::default();
    config.install_mode = Some(if relaunch {
        WindowsUpdateInstallMode::Quiet
    } else {
        WindowsUpdateInstallMode::BasicUi
    });
    config.installer_args = Some(if relaunch {
        vec!["/NS".into()]
    } else {
        vec!["/S".into(), "/NS".into()]
    });
    config
}

/// The newest prerelease's manifest, handed to cargo-packager's updater, which picks this
/// platform's entry and checks it's newer. GitHub's "latest release" skips prereleases, so the
/// manifest is found through the releases list instead of a fixed URL.
async fn find_update() -> Result<Option<Update>, String> {
    runtime::io(async {
        let releases: Vec<GithubRelease> = api::http()
            .get(RELEASES_URL)
            .timeout(Duration::from_secs(10))
            .header("accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())?;
        // desktop releases are plain `v1.2.3-dev.4`; mobile-/native- have their own prefixes
        let Some(manifest) = releases
            .into_iter()
            .filter(|release| !release.draft)
            .filter_map(|release| {
                let version = semver::Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
                let asset = release
                    .assets
                    .into_iter()
                    .find(|asset| asset.name == MANIFEST)?;
                Some((version, asset.browser_download_url))
            })
            .max_by(|a, b| a.0.cmp(&b.0))
        else {
            return Ok(None);
        };
        let current =
            semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
        let mut config = cargo_packager_updater::Config::default();
        config.endpoints = vec![manifest.1.parse().map_err(|_| "Bad manifest url")?];
        config.pubkey = PUBKEY.into();
        config.windows = Some(windows_install(true));
        // the updater is blocking
        tokio::task::spawn_blocking(move || {
            UpdaterBuilder::new(current, config)
                .timeout(Duration::from_secs(30))
                .build()
                .and_then(|updater| updater.check())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    })
    .await
}

impl Updater {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalUpdater>().0.clone()
    }

    pub fn status(cx: &App) -> UpdateStatus {
        Self::global(cx).read(cx).status.clone()
    }

    fn set(this: &Entity<Self>, status: Status, percent: Option<f32>, cx: &mut App) {
        this.update(cx, |updater, cx| {
            updater.status.status = status;
            updater.status.percent = percent;
            updater.status.version = updater.update.as_ref().map(|update| update.version.clone());
            cx.notify();
        });
        crate::desktop::update_tray(cx);
    }

    /// `checkForUpdates`. Resolves to whether an update is available. Downloads it right away
    /// when auto-update is on, like `autoUpdater.on('update-available')`.
    pub fn check(cx: &mut App) -> Task<bool> {
        let this = Self::global(cx);
        let state = this.read(cx);
        if !supported()
            || state.busy
            || matches!(
                state.status.status,
                Status::Downloading | Status::Downloaded
            )
        {
            return Task::ready(state.update.is_some());
        }
        this.update(cx, |updater, _| updater.busy = true);
        Self::set(&this, Status::Checking, None, cx);
        cx.spawn(async move |cx| {
            let result = find_update().await;
            cx.update(|cx| {
                this.update(cx, |updater, _| {
                    updater.busy = false;
                    if let Ok(update) = &result {
                        updater.update = update.clone();
                    }
                });
                match result {
                    Ok(Some(_)) => {
                        Self::set(&this, Status::Available, None, cx);
                        if launch_prefs().auto_update {
                            Self::download(cx).detach();
                        }
                        true
                    }
                    Ok(None) => {
                        Self::set(&this, Status::Current, None, cx);
                        false
                    }
                    Err(error) => {
                        eprintln!("Failed to check for updates: {error}");
                        Self::set(&this, Status::Error, None, cx);
                        false
                    }
                }
            })
        })
    }

    /// `downloadUpdate`. Resolves once the update is downloaded and its signature checks out.
    pub fn download(cx: &mut App) -> Task<Result<(), String>> {
        let this = Self::global(cx);
        let state = this.read(cx);
        if state.status.status == Status::Downloaded {
            return Task::ready(Ok(()));
        }
        let Some(update) = state.update.clone() else {
            return Task::ready(Err("No update".into()));
        };
        if state.status.status == Status::Downloading {
            // someone else is already downloading; wait for them
            return cx.spawn(async move |cx| {
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(250))
                        .await;
                    match cx.update(|cx| this.read(cx).status.status) {
                        Status::Downloaded => return Ok(()),
                        Status::Downloading => continue,
                        _ => return Err("Download failed".into()),
                    }
                }
            });
        }
        Self::set(&this, Status::Downloading, Some(0.0), cx);

        let (progress_tx, mut progress_rx) = futures::channel::mpsc::unbounded::<f32>();
        let download = runtime::io(async move {
            tokio::task::spawn_blocking(move || {
                let received = std::cell::Cell::new(0usize);
                update
                    .download_extended(
                        |chunk, total| {
                            received.set(received.get() + chunk);
                            if let Some(total) = total.filter(|total| *total > 0) {
                                let percent = received.get() as f32 / total as f32 * 100.0;
                                let _ = progress_tx.unbounded_send(percent);
                            }
                        },
                        || {},
                    )
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| error.to_string())?
        });

        cx.spawn(async move |cx| {
            let watcher = {
                let this = this.clone();
                let cx = cx.clone();
                async move {
                    use futures::StreamExt;
                    while let Some(percent) = progress_rx.next().await {
                        let _ = cx
                            .update(|cx| Self::set(&this, Status::Downloading, Some(percent), cx));
                    }
                }
            };
            let (result, _) = futures::join!(download, watcher);
            cx.update(|cx| match result {
                Ok(bytes) => {
                    this.update(cx, |updater, _| updater.downloaded = Some(bytes));
                    Self::set(&this, Status::Downloaded, None, cx);
                    Ok(())
                }
                Err(error) => {
                    eprintln!("Auto-update failed: {error}");
                    Self::set(&this, Status::Error, None, cx);
                    Err(error)
                }
            })
        })
    }

    fn take_download(cx: &mut App) -> Option<(Update, Vec<u8>)> {
        Self::global(cx).update(cx, |updater, _| {
            Some((updater.update.clone()?, updater.downloaded.take()?))
        })
    }

    /// `quitAndInstall`. On Windows the silent installer closes Novarum and restarts it itself.
    pub fn install(cx: &mut App) {
        let Some((update, bytes)) = Self::take_download(cx) else {
            return;
        };
        if let Err(error) = update.install(bytes) {
            eprintln!("Could not install the update: {error}");
            return;
        }
        relaunch_after_quit();
        cx.quit();
    }

    /// `autoInstallOnAppQuit`: installs without starting Novarum again.
    pub fn install_on_quit(cx: &mut App) {
        if let Some((mut update, bytes)) = Self::take_download(cx) {
            update.config.windows = Some(windows_install(false));
            let _ = update.install(bytes);
        }
    }
}

/// Starts the updated Novarum once this one is gone, so its single-instance check doesn't just
/// hand off to the instance that's quitting.
fn relaunch_after_quit() {
    let target = app_bundle()
        .map(|bundle| ("open -n \"$0\"", bundle.into_os_string()))
        .or_else(|| std::env::var_os("APPIMAGE").map(|appimage| ("exec \"$0\"", appimage)));
    if let Some((command, path)) = target {
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sleep 1; {command}"))
            .arg(path)
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn prerelease_versions_order_like_electron_updater() {
        let older = semver::Version::parse("0.2.1").unwrap();
        let dev = semver::Version::parse("0.2.2-dev.131").unwrap();
        let next_dev = semver::Version::parse("0.2.2-dev.132").unwrap();
        assert!(dev > older);
        assert!(next_dev > dev);
    }
}
