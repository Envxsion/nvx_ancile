// ------------------------------------------------------------------
//  Title    |  NVX Ancile desktop
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  The app people install: one window, every service run
//           |  for them, no Node, Python or Docker to set up.
//  How      |  On launch: the start-up screen, secrets from the OS
//           |  keychain, then the supervisor starts the services and
//           |  the window moves to the Cockpit that Core serves on
//           |  127.0.0.1. One instance only; a second launch (or an
//           |  ancile:// link) focuses the first. Quitting stops
//           |  every service, Postgres last and cleanly.
//  Note     |  The Cockpit is a remote page to Tauri and gets no
//           |  native APIs (capabilities/default.json covers only the
//           |  start-up screen). It learns it runs on the desktop from
//           |  an initialisation script that sets __NVX_DESKTOP__.
// ------------------------------------------------------------------

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod layout;
mod secrets;
mod supervisor;
mod tray;

use std::sync::{Arc, Mutex};
use supervisor::Supervisor;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

/// Where to send the window once Core is ready (a deep link may set it).
struct Pending(Mutex<Option<String>>);

pub fn supervisor_of(app: &AppHandle) -> Option<Arc<Supervisor>> {
    app.try_state::<Arc<Supervisor>>().map(|s| Arc::clone(&s))
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// `ancile://activate?key=NVX-XXXX-XXXX-XXXX` opens Admin → Licence with the
/// key filled in. It never activates by itself: the person presses the button.
fn route_for(url: &Url) -> Option<String> {
    if url.scheme() != "ancile" {
        return None;
    }
    let what = url
        .host_str()
        .unwrap_or_else(|| url.path().trim_matches('/'));
    match what {
        "activate" => {
            let key = url
                .query_pairs()
                .find(|(k, _)| k == "key")
                .map(|(_, v)| v.to_uppercase())?;
            let valid = key.len() == 18
                && key.starts_with("NVX-")
                && key[4..]
                    .split('-')
                    .all(|p| p.len() == 4 && p.chars().all(|c| c.is_ascii_alphanumeric()));
            valid.then(|| format!("/admin/license?key={key}"))
        }
        _ => Some("/".into()),
    }
}

fn open_route(app: &AppHandle, route: String) {
    show_main(app);
    let ready = supervisor_of(app)
        .map(|s| s.status().ready)
        .unwrap_or(false);
    if !ready {
        *app.state::<Pending>().0.lock().unwrap() = Some(route);
        return;
    }
    navigate(app, &route);
}

fn navigate(app: &AppHandle, route: &str) {
    let (Some(sup), Some(w)) = (supervisor_of(app), app.get_webview_window("main")) else {
        return;
    };
    if let Ok(url) = Url::parse(&format!("{}{}", sup.layout().core_url(), route)) {
        let _ = w.navigate(url);
    }
}

fn init_logging(dir: &std::path::Path) {
    use simplelog::{Config, LevelFilter, WriteLogger};
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("desktop.log"))
    {
        let _ = WriteLogger::init(LevelFilter::Info, Config::default(), file);
    }
}

fn main() {
    #[allow(unused_mut)] // reassigned only with the updater feature
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch: bring this one forward. Links arrive through
            // the deep-link plugin's handler below.
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .on_window_event(|window, event| {
            // Closing the window quits NVX Ancile and stops its services, rather
            // than leaving a workspace running out of sight in the tray.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let mut resources = app.path().resource_dir()?;
            // `cargo run` does not copy bundled resources: use the source tree's.
            if cfg!(debug_assertions) && !resources.join("sidecars").exists() {
                resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            }
            let os_data = app.path().data_dir()?;
            let layout = layout::Layout::new(&resources, &os_data)?;
            init_logging(&layout.logs);
            log::info!(
                "NVX Ancile {} starting; data in {}",
                env!("CARGO_PKG_VERSION"),
                layout.data.display()
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("NVX Ancile")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::webview::Color(8, 9, 10, 255))
                .initialization_script(format!(
                    "window.__NVX_DESKTOP__ = Object.freeze({{ version: {:?} }});",
                    env!("CARGO_PKG_VERSION")
                ))
                .build()?;

            app.manage(Pending(Mutex::new(None)));
            tray::install(&handle)?;

            #[cfg(any(windows, target_os = "linux"))]
            if cfg!(debug_assertions) {
                // Installers register ancile:// for real; a dev build registers itself.
                let _ = app.deep_link().register_all();
            }
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(route) = route_for(&url) {
                        open_route(&links, route);
                    }
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(route) = urls.iter().find_map(route_for) {
                    *app.state::<Pending>().0.lock().unwrap() = Some(route);
                }
            }

            let profile =
                std::env::var("ANCILE_DESKTOP_PROFILE").unwrap_or_else(|_| "default".into());
            let secrets = match secrets::load_or_create(&profile) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("{e}");
                    std::collections::BTreeMap::new()
                }
            };
            let sup = Supervisor::new(handle.clone(), layout, secrets, &profile);
            app.manage(Arc::clone(&sup));

            std::thread::spawn(move || match sup.start_all() {
                Ok(()) => {
                    let route = handle
                        .state::<Pending>()
                        .0
                        .lock()
                        .unwrap()
                        .take()
                        .unwrap_or_else(|| "/".into());
                    navigate(&handle, &route);
                }
                Err(e) => log::error!("start-up failed: {e}"),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("NVX Ancile could not start its window");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(sup) = supervisor_of(app) {
                sup.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_links_fill_the_key_and_nothing_else() {
        let ok = Url::parse("ancile://activate?key=nvx-ab12-cd34-ef56").unwrap();
        assert_eq!(
            route_for(&ok).as_deref(),
            Some("/admin/license?key=NVX-AB12-CD34-EF56")
        );
        let bad = Url::parse("ancile://activate?key=NVX-AB12-CD34-EF56%26x%3D1").unwrap();
        assert_eq!(route_for(&bad), None);
        let other = Url::parse("https://example.com/activate?key=NVX-AB12-CD34-EF56").unwrap();
        assert_eq!(route_for(&other), None);
    }
}
