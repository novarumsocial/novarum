// Novarum desktop: a native (GPUI) port of apps/frontend, replacing the Electron shell.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod api;
mod app;
mod assets;
mod desktop;
mod models;
#[allow(dead_code)]
mod notifications;
mod prelude;
mod realtime_events;
mod runtime;
mod socket;
mod sounds;
mod startup;
mod state;
mod storage;
mod theme;
mod ui;
mod updater;
#[allow(dead_code)]
mod util;
mod views;

use std::time::Duration;

use gpui_kit::{component::TitleBar, *};

use crate::views::{shell::BehindSplash, updater::UpdaterView};

fn main_window_options(cx: &App) -> WindowOptions {
    let bounds = Bounds::centered(None, size(px(1100.0), px(800.0)), cx);
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(720.0), px(480.0))),
        app_id: Some("novarum".into()),
        ..TitleBar::window_options()
    }
}

pub fn open_main_window(cx: &mut App) {
    let options = main_window_options(cx);
    gpui_kit::open_window(options, cx, |window, cx| {
        startup::mark("window created");
        window.set_window_title("Novarum");
        cx.new(|cx| app::AppRoot::new(window, cx))
    })
    .expect("failed to open the main window");
}

fn open_splash(cx: &mut App) -> AnyWindowHandle {
    let bounds = Bounds::centered(None, size(px(300.0), px(320.0)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: None,
        is_resizable: false,
        is_minimizable: false,
        app_id: Some("novarum".into()),
        window_decorations: Some(WindowDecorations::Client),
        ..Default::default()
    };
    gpui_kit::open_window(options, cx, |_, cx| cx.new(UpdaterView::new))
        .expect("splash")
        .0
}

fn main() {
    startup::mark("main");
    if !desktop::claim_single_instance() {
        return;
    }
    // closing the main window hides Novarum to the tray; it quits from the tray or the dock
    let app = gpui_kit::application()
        .with_assets(assets::Assets)
        .with_quit_mode(QuitMode::Explicit);
    app.on_reopen(desktop::show_main_window);
    app.run(|cx| {
        startup::mark("app.run");
        gpui_kit::init(cx);
        assets::load_fonts(cx);
        state::init(cx);
        updater::init(cx);
        desktop::init(cx);
        startup::mark("state ready");

        let auto_update = updater::supported() && updater::launch_prefs().auto_update;
        let hidden = desktop::launch_hidden();
        let force_splash = std::env::var_os("NOVARUM_SPLASH").is_some();

        if (auto_update || force_splash) && !hidden {
            // checks for an update while the app boots behind the splash, then hands off to the
            // main window, which skips its own loader. an update that lands first installs and
            // relaunches; otherwise the window opens as soon as the boot is done and the check
            // finishes behind it, installing when Novarum quits
            let boot = state::boot(cx);
            let splash = open_splash(cx);
            cx.spawn(async move |cx| {
                let check = cx.update(updater::Updater::check);
                let timeout = cx.background_executor().timer(Duration::from_secs(10));
                let first = futures::future::select(
                    check,
                    futures::future::select(boot, Box::pin(timeout)),
                )
                .await;
                let check = match first {
                    futures::future::Either::Left((true, _)) => {
                        let download = cx.update(updater::Updater::download);
                        if download.await.is_ok() {
                            cx.update(updater::Updater::install);
                        }
                        return;
                    }
                    futures::future::Either::Left((false, rest)) => {
                        // in case the boot never finishes, don't leave the user staring at the splash
                        let _ = rest.await;
                        None
                    }
                    futures::future::Either::Right((_, check)) => Some(check),
                };
                cx.update(|cx| {
                    cx.set_global(BehindSplash);
                    open_main_window(cx);
                    let _ = splash.update(cx, |_, window, _| window.remove_window());
                });
                if let Some(check) = check
                    && check.await
                {
                    cx.update(|cx| updater::Updater::download(cx)).detach();
                }
            })
            .detach();
        } else {
            if auto_update && hidden {
                cx.spawn(async move |cx| {
                    cx.background_executor()
                        .timer(Duration::from_secs(10))
                        .await;
                    let _ = cx.update(|cx| updater::Updater::check(cx));
                })
                .detach();
            }
            if !hidden {
                // the session and lists load while the window and its GPU context come up
                let _ = state::boot(cx);
                open_main_window(cx);
            }
        }

        cx.on_app_quit(|cx| {
            updater::Updater::install_on_quit(cx);
            async {}
        })
        .detach();
    });
}
