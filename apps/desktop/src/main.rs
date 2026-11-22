// Novarum desktop: a native (GPUI) port of apps/frontend, replacing the Electron shell.
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
    gpui_kit::open_window(options, cx, |_, cx| cx.new(UpdaterView::new)).expect("splash").0
}

fn main() {
    gpui_kit::application().with_assets(assets::Assets).run(|cx| {
        gpui_kit::init(cx);
        assets::load_fonts(cx);
        state::init(cx);
        updater::init(cx);

        let auto_update = updater::supported() && updater::launch_prefs().auto_update;
        let hidden = desktop::launch_hidden();
        let force_splash = std::env::var_os("NOVARUM_SPLASH").is_some();

        if (auto_update || force_splash) && !hidden {
            // checks for an update before the main window opens and installs it right away.
            // otherwise the splash stays up while the app boots, then hands off to the main
            // window, which skips its own loader
            let splash = open_splash(cx);
            cx.spawn(async move |cx| {
                if views::updater::update_on_launch(cx).await {
                    return;
                }
                let boot = cx.update(|cx| state::boot(cx));
                let timeout = cx.background_executor().timer(Duration::from_secs(10));
                // in case the boot never finishes, don't leave the user staring at the splash
                let _ = futures::future::select(boot, Box::pin(timeout)).await;
                cx.update(|cx| {
                    cx.set_global(BehindSplash);
                    open_main_window(cx);
                    let _ = splash.update(cx, |_, window, _| window.remove_window());
                });
            })
            .detach();
        } else {
            if auto_update && hidden {
                cx.spawn(async move |cx| {
                    cx.background_executor().timer(Duration::from_secs(10)).await;
                    let _ = cx.update(|cx| updater::Updater::check(cx));
                })
                .detach();
            }
            // TODO(tray): with no tray icon yet, a hidden launch would leave no way back in
            open_main_window(cx);
        }

        cx.on_app_quit(|cx| {
            updater::Updater::install_on_quit(cx);
            async {}
        })
        .detach();
    });
}
