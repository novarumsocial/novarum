// The auto-updater of apps/electron/src/main.ts (electron-updater on the `dev` prerelease channel).
// Releases tagged `v<version>` carry a `novarum-desktop-<os>-<arch>.tar.gz` with the binary; it
// replaces the running executable and the app relaunches into it.
use std::{io::Read, time::Duration};

use futures::StreamExt;
use gpui_kit::*;
use serde::{Deserialize, Serialize};

use crate::{api, runtime, storage};

const RELEASES_URL: &str =
    "https://api.github.com/repos/novarumsocial/novarum/releases?per_page=30";

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

#[derive(Debug, Clone)]
struct Release {
    version: semver::Version,
    asset_url: String,
}

pub struct Updater {
    pub status: UpdateStatus,
    release: Option<Release>,
    downloaded: Option<std::path::PathBuf>,
    busy: bool,
}

struct GlobalUpdater(Entity<Updater>);
impl Global for GlobalUpdater {}

/// Only release builds update themselves, like `app.isPackaged`.
pub fn supported() -> bool {
    !cfg!(debug_assertions) && std::env::var_os("NOVARUM_NO_UPDATE").is_none()
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
        release: None,
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

fn asset_name() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    format!("novarum-desktop-{os}-{}.tar.gz", std::env::consts::ARCH)
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

async fn latest_release() -> Result<Option<Release>, String> {
    runtime::io(async {
        let releases: Vec<GithubRelease> = api::http()
            .get(RELEASES_URL)
            .header("accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())?;
        let current =
            semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
        let name = asset_name();
        Ok(releases
            .into_iter()
            .filter(|release| !release.draft)
            // desktop releases are plain `v1.2.3-dev.4`; mobile-/native- have their own prefixes
            .filter_map(|release| {
                let version = semver::Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
                let asset = release
                    .assets
                    .into_iter()
                    .find(|asset| asset.name == name)?;
                Some(Release {
                    version,
                    asset_url: asset.browser_download_url,
                })
            })
            .filter(|release| release.version > current)
            .max_by(|a, b| a.version.cmp(&b.version)))
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
            updater.status.version = updater
                .release
                .as_ref()
                .map(|release| release.version.to_string());
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
            return Task::ready(state.release.is_some());
        }
        this.update(cx, |updater, _| updater.busy = true);
        Self::set(&this, Status::Checking, None, cx);
        cx.spawn(async move |cx| {
            let result = latest_release().await;
            cx.update(|cx| {
                this.update(cx, |updater, _| {
                    updater.busy = false;
                    if let Ok(release) = &result {
                        updater.release = release.clone();
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

    /// `downloadUpdate`. Resolves once the new binary is unpacked next to the old one.
    pub fn download(cx: &mut App) -> Task<Result<(), String>> {
        let this = Self::global(cx);
        let state = this.read(cx);
        if state.status.status == Status::Downloaded {
            return Task::ready(Ok(()));
        }
        let Some(release) = state.release.clone() else {
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
            let response = api::http()
                .get(&release.asset_url)
                .send()
                .await
                .and_then(|response| response.error_for_status())
                .map_err(|error| error.to_string())?;
            let total = response.content_length().unwrap_or(0) as f32;
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                bytes.extend_from_slice(&chunk.map_err(|error| error.to_string())?);
                if total > 0.0 {
                    let _ = progress_tx.unbounded_send(bytes.len() as f32 / total * 100.0);
                }
            }
            drop(progress_tx);
            unpack(&bytes)
        });

        cx.spawn(async move |cx| {
            let watcher = {
                let this = this.clone();
                let cx = cx.clone();
                async move {
                    while let Some(percent) = progress_rx.next().await {
                        let _ = cx
                            .update(|cx| Self::set(&this, Status::Downloading, Some(percent), cx));
                    }
                }
            };
            let (result, _) = futures::join!(download, watcher);
            cx.update(|cx| match result {
                Ok(path) => {
                    this.update(cx, |updater, _| updater.downloaded = Some(path));
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

    /// `quitAndInstall`: swaps the executable and relaunches.
    pub fn install(cx: &mut App) {
        let Some(path) = Self::global(cx).read(cx).downloaded.clone() else {
            return;
        };
        if let Err(error) = self_replace::self_replace(&path) {
            eprintln!("Could not install the update: {error}");
            return;
        }
        let _ = std::fs::remove_file(&path);
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe).spawn();
        }
        cx.quit();
    }

    /// `autoInstallOnAppQuit`.
    pub fn install_on_quit(cx: &mut App) {
        if let Some(path) = Self::global(cx).read(cx).downloaded.clone() {
            let _ = self_replace::self_replace(&path);
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Pulls the `novarum` executable out of the release tarball, next to the running one.
fn unpack(bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let target = exe.with_extension("update");
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if name == "novarum" || name == "novarum.exe" {
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|error| error.to_string())?;
            std::fs::write(&target, data).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
            }
            return Ok(target);
        }
    }
    Err("The update has no novarum executable".into())
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
