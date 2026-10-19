// ------------------------------------------------------------------
//  Title    |  Tray
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  NVX Ancile in the tray: whether it is ready (or, in
//           |  Pro with the window hidden, "Running in the background"),
//           |  a way back to the window, the logs folder, and Quit
//           |  (which first looks for runs and approvals, then stops
//           |  every service cleanly). With updates on: the update on
//           |  offer (Pro arriving, Pro ended, or a newer version) and
//           |  "Check for updates".
// ------------------------------------------------------------------

use crate::supervisor::Status;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
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
    #[cfg(not(feature = "updater"))]
    let menu = Menu::with_items(app, &[&status, &sep, &open, &logs, &sep, &quit])?;
    // With updates on, a line that offers an update once one is found.
    #[cfg(feature = "updater")]
    let menu = {
        let update = MenuItem::with_id(app, "update", "Up to date", false, None::<&str>)?;
        let check = MenuItem::with_id(app, "check", "Check for updates", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[&status, &update, &check, &sep, &open, &logs, &sep, &quit],
        )?;
        app.manage(crate::updates::TrayLine(update));
        menu
    };
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
            "quit" => crate::shell::request_quit(app),
            #[cfg(feature = "updater")]
            "update" => crate::updates::install(app.clone()),
            #[cfg(feature = "updater")]
            "check" => crate::updates::check_now(app.clone()),
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

/// Pro: the window is hidden and scheduled work carries on.
static BACKGROUND: AtomicBool = AtomicBool::new(false);
static HEADLINE: Mutex<String> = Mutex::new(String::new());

/// What the first line says: the background mode wins over "Ready".
pub fn line(headline: &str, background: bool) -> String {
    if background && (headline == "Ready" || headline.starts_with("Ready. Warming")) {
        "Running in the background".to_string()
    } else {
        headline.to_string()
    }
}

fn render(app: &AppHandle) {
    let text = line(&HEADLINE.lock().unwrap(), BACKGROUND.load(Ordering::SeqCst));
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("NVX Ancile: {text}")));
    }
    if let Some(item) = app.try_state::<StatusItem>() {
        let _ = item.0.set_text(text);
    }
}

/// Mirror the supervisor's status in the tray tooltip and first menu line.
pub fn refresh(app: &AppHandle, status: &Status) {
    *HEADLINE.lock().unwrap() = status.message.clone();
    render(app);
}

/// Core says Pro keeps scheduled work going, and the window is hidden.
pub fn set_background(app: &AppHandle, on: bool) {
    if BACKGROUND.swap(on, Ordering::SeqCst) != on {
        render(app);
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

#[cfg(test)]
mod tests {
    use super::line;

    #[test]
    fn the_background_line_replaces_ready_but_never_a_problem() {
        assert_eq!(line("Ready", true), "Running in the background");
        assert_eq!(
            line("Ready. Warming up: sources and search", true),
            "Running in the background"
        );
        assert_eq!(line("Ready", false), "Ready");
        assert_eq!(
            line("Ready, but sources and search did not start", false),
            "Ready, but sources and search did not start"
        );
        assert_eq!(
            line("Ready, but sources and search did not start", true),
            "Ready, but sources and search did not start",
            "a problem is never hidden behind the background line"
        );
        assert_eq!(
            line("A service keeps stopping", true),
            "A service keeps stopping"
        );
        assert_eq!(line("Starting", true), "Starting");
    }
}
