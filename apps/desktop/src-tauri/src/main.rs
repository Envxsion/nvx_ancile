// ------------------------------------------------------------------
//  Title    |  NVX Ancile desktop
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  The app people install: one window, every service run
//           |  for them, no Node, Python or Docker to set up.
//  How      |  On launch: the window opens where it was left (hidden
//           |  until placed), the start-up screen, secrets from the OS
//           |  keychain, then the supervisor starts the services side
//           |  by side and the window moves to the Cockpit that Core
//           |  serves on 127.0.0.1 as soon as Core is ready. One
//           |  instance only; a second launch (or an ancile:// link,
//           |  deeplink.rs) focuses the first. Closing the window asks
//           |  once whether to keep running in the tray or quit, then
//           |  does that (shell.rs); quitting checks for live runs and
//           |  stops every service, Postgres last and cleanly.
//  Note     |  The Cockpit is a remote page to Tauri and gets no
//           |  native APIs (capabilities/default.json covers only the
//           |  start-up screen). It learns it runs on the desktop from
//           |  an initialisation script that sets __NVX_DESKTOP__.
// ------------------------------------------------------------------

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod closing;
mod core_api;
mod deeplink;
mod layout;
mod links;
mod notify;
// Update scheduling is used only by the updater.
#[cfg_attr(not(feature = "updater"), allow(dead_code))]
mod schedule;
mod secrets;
mod shell;
mod supervisor;
mod tray;
#[cfg(feature = "updater")]
mod updates;
mod window_state;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use supervisor::Supervisor;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

/// Where to send the window once Core is ready (a deep link may set it).
struct Pending(Mutex<Option<String>>);

/// The link just opened: the same one arriving twice (the second launch and the
/// deep-link plugin both hear it) opens once.
static LAST_ROUTE: Mutex<Option<(String, Instant)>> = Mutex::new(None);

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

/// Open a place in the Cockpit: a link, or a click on a notification. It only
/// opens a place; nothing is sent, approved or spent (deeplink.rs).
pub(crate) fn open_route(app: &AppHandle, route: String) {
    {
        let mut last = LAST_ROUTE.lock().unwrap();
        if let Some((r, at)) = last.as_ref() {
            if *r == route && at.elapsed() < Duration::from_millis(1500) {
                return;
            }
        }
        *last = Some((route.clone(), Instant::now()));
    }
    show_main(app);
    let ready = supervisor_of(app)
        .map(|s| s.status().core_ready)
        .unwrap_or(false);
    if !ready {
        *app.state::<Pending>().0.lock().unwrap() = Some(route);
        return;
    }
    navigate(app, &route);
}

/// Every service started again (after a restore from Core's start-up screen): open the Cockpit afresh.
pub(crate) fn reload_main(app: &AppHandle) {
    navigate(app, "/");
}

fn navigate(app: &AppHandle, route: &str) {
    let (Some(sup), Some(w)) = (supervisor_of(app), app.get_webview_window("main")) else {
        return;
    };
    if let Ok(url) = Url::parse(&format!("{}{}", sup.layout().core_url(), route)) {
        let _ = w.navigate(url);
    }
}

/// A web or mail link from the Cockpit: the system browser or mail client
/// opens it, never this window.
fn open_external(url: &Url) {
    if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        log::warn!("could not open a link outside the app: {e}");
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch: bring this one forward, and open the link it was
            // given (the deep-link plugin hears it too; open_route opens it once).
            show_main(app);
            for url in deeplink::links_in_args(&argv) {
                if let Some(route) = deeplink::route_for(&url) {
                    open_route(app, route);
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(not(windows))]
    {
        builder = builder.plugin(tauri_plugin_notification::init());
    }
    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .on_window_event(shell::on_window_event)
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
            let shell = shell::init(&handle, &layout.data);
            // Where the window opens: where it was left, fitted to the screens connected now.
            let (screens, primary) = shell::monitors(&handle);
            let plan = window_state::plan(shell.saved().as_ref(), &screens, primary);
            log::info!(
                "NVX Ancile {} starting; data in {}",
                env!("CARGO_PKG_VERSION"),
                layout.data.display()
            );

            // Links: the Cockpit stays here, web and mail links go to the
            // system, and every other scheme does nothing (links.rs).
            let core_nav = layout.core_url();
            let core_new = core_nav.clone();
            let mut window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("NVX Ancile")
                    .inner_size(plan.width, plan.height)
                    .min_inner_size(
                        window_state::MIN_SIZE.0.min(plan.width),
                        window_state::MIN_SIZE.1.min(plan.height),
                    )
                    // Placed first, shown after: nothing jumps.
                    .visible(false)
                    .theme(Some(tauri::Theme::Dark))
                    .background_color(tauri::webview::Color(8, 9, 10, 255))
                    .on_navigation(move |url| match links::decide(url, &core_nav) {
                        links::Action::Stay => true,
                        links::Action::External => {
                            open_external(url);
                            false
                        }
                        links::Action::Refuse => {
                            log::warn!("refused a link with the scheme {}", url.scheme());
                            false
                        }
                    })
                    .on_new_window(move |url, _features| match links::decide(&url, &core_new) {
                        // A file Core serves (a source's original): its own window.
                        links::Action::Stay => NewWindowResponse::Allow,
                        links::Action::External => {
                            open_external(&url);
                            NewWindowResponse::Deny
                        }
                        links::Action::Refuse => {
                            log::warn!("refused a link with the scheme {}", url.scheme());
                            NewWindowResponse::Deny
                        }
                    })
                    .initialization_script(format!(
                        "window.__NVX_DESKTOP__ = Object.freeze({{ version: {:?} }});",
                        env!("CARGO_PKG_VERSION")
                    ));
            if matches!(plan.spot, window_state::Spot::Centre) {
                window = window.center();
            }
            let window = window.build()?;
            shell::apply_plan(&window, &plan);
            let _ = window.show();

            app.manage(Pending(Mutex::new(None)));
            #[cfg(feature = "updater")]
            app.manage(updates::Waiting(Mutex::new(None)));
            // No tray (some Linux desktops): closing the window quits instead of hiding it.
            if let Err(e) = tray::install(&handle) {
                log::warn!("no tray icon, so closing the window will quit: {e}");
                shell.set_tray(false);
            }

            #[cfg(any(windows, target_os = "linux"))]
            if cfg!(debug_assertions) {
                // Installers register ancile:// for real; a dev build registers itself.
                let _ = app.deep_link().register_all();
            }
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(route) = deeplink::route_for(&url) {
                        open_route(&links, route);
                    }
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(route) = urls.iter().find_map(deeplink::route_for) {
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
                    // Core is up: poll it for notifications and commands (shell.rs).
                    shell::start_polling(handle.clone());
                    // Services are up: say what changed if this start follows an update,
                    // then look for an update now, and every few hours.
                    #[cfg(feature = "updater")]
                    {
                        updates::report_if_updated(&handle);
                        updates::spawn(handle.clone());
                    }
                }
                Err(e) => log::error!("start-up failed: {e}"),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("NVX Ancile could not start its window");

    app.run(|app, event| {
        shell::on_run_event(app, &event);
        if let tauri::RunEvent::Exit = event {
            if let Some(sup) = supervisor_of(app) {
                sup.shutdown();
            }
            // "When I quit": the update the person chose goes in as the app leaves.
            #[cfg(feature = "updater")]
            updates::install_on_quit(app);
        }
    });
}
