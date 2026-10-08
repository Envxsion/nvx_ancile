// ------------------------------------------------------------------
//  Title    |  Tray
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  NVX Ancile in the tray: whether it is ready, a way back
//           |  to the window, the logs folder, and Quit (which stops
//           |  every service cleanly).
// ------------------------------------------------------------------

use crate::supervisor::Status;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "ancile";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Starting", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open NVX Ancile", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open the logs folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NVX Ancile", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &sep, &open, &logs, &sep, &quit])?;
    app.manage(StatusItem(status));

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("NVX Ancile: starting")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::show_main(app),
            "logs" => {
                if let Some(sup) = crate::supervisor_of(app) {
                    open_folder(&sup.layout().logs);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

struct StatusItem(MenuItem<tauri::Wry>);

/// Mirror the supervisor's status in the tray tooltip and first menu line.
pub fn refresh(app: &AppHandle, status: &Status) {
    let text = if status.ready {
        "Ready".to_string()
    } else {
        status.message.clone()
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("NVX Ancile: {text}")));
    }
    if let Some(item) = app.try_state::<StatusItem>() {
        let _ = item.0.set_text(text);
    }
}

fn open_folder(path: &std::path::Path) {
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(program).arg(path).spawn();
}
