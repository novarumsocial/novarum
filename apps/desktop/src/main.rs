// Novarum desktop: a native (GPUI) port of apps/frontend, replacing the Electron shell.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod api;
mod app;
mod assets;
mod media;
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
    let (window, _) = gpui_kit::open_window(options, cx, |window, cx| {
        startup::mark("window created");
        window.set_window_title("Novarum");
        cx.new(|cx| app::AppRoot::new(window, cx))
    })
    .expect("failed to open the main window");
    // Tailwind's preflight `html { line-height: 1.5 }`; gpui defaults to the golden ratio
    let _ = window.update(cx, |_, window, cx| {
        base::Root::update(window, cx, |root, _, _| {
            root.style().text.line_height = Some(relative(1.5))
        })
    });
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
        media::init(cx);
        updater::init(cx);
        desktop::init(cx);
        startup::mark("state ready");

        let auto_update = updater::supported() && updater::launch_prefs().auto_update;
        if !desktop::launch_hidden() {
            // the session and lists load while the window and its GPU context come up
            let _ = state::boot(cx);
            open_main_window(cx);
        }
        if auto_update {
            // after startup's own requests; `check` downloads a found update, which installs
            // when Novarum quits
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_secs(10))
                    .await;
                cx.update(updater::Updater::check).await;
            })
            .detach();
        }

        cx.on_app_quit(|cx| {
            updater::Updater::install_on_quit(cx);
            async {}
        })
        .detach();
    });
}
