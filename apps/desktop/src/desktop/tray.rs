// `createTray`/`updateTrayMenu`. On Linux it's a StatusNotifierItem over D-Bus (ksni), which needs
// no GTK loop next to gpui's; on macOS and Windows tray-icon hooks into the main thread's event
// loop, which gpui already runs.
use gpui_kit::*;

use super::{Action, Actions};
use crate::updater::{Status, Updater};

const ICON: &[u8] = include_bytes!("../../packaging/icons/64x64.png");

/// The tray icon as 8-bit RGBA, with its size.
fn icon_rgba() -> (Vec<u8>, u32, u32) {
    let mut reader = png::Decoder::new(std::io::Cursor::new(ICON)).read_info().expect("tray icon");
    let mut pixels = vec![0; reader.output_buffer_size().expect("tray icon size")];
    let info = reader.next_frame(&mut pixels).expect("tray icon pixels");
    pixels.truncate(info.buffer_size());
    (pixels, info.width, info.height)
}

/// The version behind "Restart to update to <version>".
fn downloaded_version(cx: &App) -> Option<String> {
    let update = Updater::status(cx);
    (update.status == Status::Downloaded).then(|| update.version.unwrap_or_default())
}

#[cfg(target_os = "linux")]
mod platform {
    use ksni::{MenuItem, TrayMethods, menu::StandardItem};

    use super::*;

    struct Tray {
        update: Option<String>,
        actions: Actions,
    }

    impl Tray {
        fn item(label: String, action: Action) -> MenuItem<Self> {
            StandardItem {
                label,
                activate: Box::new(move |tray: &mut Self| {
                    let _ = tray.actions.unbounded_send(action);
                }),
                ..Default::default()
            }
            .into()
        }
    }

    impl ksni::Tray for Tray {
        fn id(&self) -> String {
            "novarum".into()
        }

        fn title(&self) -> String {
            "Novarum".into()
        }

        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            let (mut data, width, height) = icon_rgba();
            // RGBA to ARGB
            data.as_chunks_mut::<4>().0.iter_mut().for_each(|pixel| pixel.rotate_right(1));
            vec![ksni::Icon { width: width as i32, height: height as i32, data }]
        }

        fn tool_tip(&self) -> ksni::ToolTip {
            ksni::ToolTip { title: "Novarum".into(), ..Default::default() }
        }

        fn activate(&mut self, _x: i32, _y: i32) {
            let _ = self.actions.unbounded_send(Action::Show);
        }

        fn menu(&self) -> Vec<MenuItem<Self>> {
            let mut menu = vec![Self::item("Open Novarum".into(), Action::Show)];
            if let Some(version) = &self.update {
                menu.push(Self::item(format!("Restart to update to {version}"), Action::Install));
            }
            menu.extend([MenuItem::Separator, Self::item("Quit".into(), Action::Quit)]);
            menu
        }
    }

    struct TrayHandle(ksni::Handle<Tray>);
    impl Global for TrayHandle {}

    pub fn create(actions: Actions, cx: &mut App) {
        let tray = Tray { update: downloaded_version(cx), actions };
        cx.spawn(async move |cx| {
            let spawned = crate::runtime::io(tray.spawn()).await;
            cx.update(|cx| match spawned {
                Ok(handle) => cx.set_global(TrayHandle(handle)),
                Err(error) => {
                    eprintln!("No tray icon: {error}");
                    super::super::no_tray(cx);
                }
            });
        })
        .detach();
    }

    pub fn update_tray(cx: &mut App) {
        let Some(TrayHandle(handle)) = cx.try_global::<TrayHandle>() else { return };
        let handle = handle.clone();
        let update = downloaded_version(cx);
        crate::runtime::handle().spawn(async move { handle.update(|tray| tray.update = update).await });
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod platform {
    use tray_icon::{
        Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
        menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    };

    use super::*;

    struct GlobalTray(TrayIcon);
    impl Global for GlobalTray {}

    fn menu(update: Option<String>) -> Menu {
        let menu = Menu::new();
        let _ = menu.append(&MenuItem::with_id("show", "Open Novarum", true, None));
        if let Some(version) = update {
            let label = format!("Restart to update to {version}");
            let _ = menu.append(&MenuItem::with_id("install", label, true, None));
        }
        let _ = menu.append_items(&[&PredefinedMenuItem::separator(), &MenuItem::with_id("quit", "Quit", true, None)]);
        menu
    }

    pub fn create(actions: Actions, cx: &mut App) {
        let menu_actions = actions.clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let action = match event.id.as_ref() {
                "show" => Action::Show,
                "install" => Action::Install,
                "quit" => Action::Quit,
                _ => return,
            };
            let _ = menu_actions.unbounded_send(action);
        }));
        TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let _ = actions.unbounded_send(Action::Show);
            }
        }));

        let (rgba, width, height) = icon_rgba();
        let tray = Icon::from_rgba(rgba, width, height).map_err(|error| error.to_string()).and_then(|icon| {
            TrayIconBuilder::new()
                .with_tooltip("Novarum")
                .with_icon(icon)
                .with_menu(Box::new(menu(downloaded_version(cx))))
                .with_menu_on_left_click(false)
                .build()
                .map_err(|error| error.to_string())
        });
        match tray {
            Ok(tray) => cx.set_global(GlobalTray(tray)),
            Err(error) => {
                eprintln!("No tray icon: {error}");
                super::super::no_tray(cx);
            }
        }
    }

    pub fn update_tray(cx: &mut App) {
        let update = downloaded_version(cx);
        if let Some(GlobalTray(tray)) = cx.try_global::<GlobalTray>() {
            tray.set_menu(Some(Box::new(menu(update))));
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;

    pub fn create(_actions: Actions, cx: &mut App) {
        super::super::no_tray(cx);
    }

    pub fn update_tray(_cx: &mut App) {}
}

/// `update_tray` rebuilds the tray menu after the update status changes.
pub use platform::{create, update_tray};

#[cfg(test)]
mod tests {
    #[test]
    fn tray_icon_decodes_to_rgba() {
        let (pixels, width, height) = super::icon_rgba();
        assert_eq!((width, height), (64, 64));
        assert_eq!(pixels.len(), 64 * 64 * 4);
    }
}
