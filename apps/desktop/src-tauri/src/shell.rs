// ------------------------------------------------------------------
//  Title    |  The shell
//  Ref      |  ROADMAP rows DK1, DK2, NT1, UP1 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  Everything the desktop app does with its own window
//           |  that the Cockpit may not: closing to the tray or
//           |  quitting (after a check for live runs), remembering
//           |  where the window was, native notifications, and the
//           |  commands the Cockpit gives through Core.
//  How      |  The Cockpit is a remote page with no native access, so
//           |  it asks Core and Core queues. Every two seconds, once
//           |  Core is up, this module polls Core (core_api.rs) for
//           |  notifications and commands, and tells it whether the
//           |  window is showing and what is still warming up. The
//           |  decisions are in closing.rs, notify.rs, schedule.rs and
//           |  window_state.rs (pure, tested); this file does the
//           |  windows, dialogs and threads.
//  Note     |  An operating system shutdown is never held up: no
//           |  dialog, no hiding. Dialogs come from the dialog plugin,
//           |  called from Rust only; the Cockpit gets none of its
//           |  commands.
// ------------------------------------------------------------------

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, RunEvent, UserAttentionType, Window,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::closing::{self, Activity, Behaviour, Env, OnClose};
use crate::core_api::Core;
use crate::notify::{self, Click, Notifier};
use crate::window_state::{self, Monitor, Saved, Snapshot, Spot};

const POLL_EVERY: Duration = Duration::from_secs(2);
/// On a system whose notifications cannot be clicked, coming back this soon opens the place.
const CLICK_WINDOW: Duration = Duration::from_secs(30);

pub struct Shell {
    close: AtomicU8,
    tray_ok: AtomicBool,
    quitting: AtomicBool,
    dialog_open: AtomicBool,
    approvals: AtomicU32,
    runs: AtomicU32,
    notifier: Mutex<Notifier>,
    click: Mutex<Option<(String, Instant)>>,
    prefs_file: PathBuf,
    state_file: PathBuf,
    saved: Mutex<(Option<Saved>, bool)>,
}

fn code(b: Behaviour) -> u8 {
    match b {
        Behaviour::Ask => 0,
        Behaviour::Tray => 1,
        Behaviour::Quit => 2,
    }
}

fn behaviour(c: u8) -> Behaviour {
    match c {
        1 => Behaviour::Tray,
        2 => Behaviour::Quit,
        _ => Behaviour::Ask,
    }
}

pub fn shell_of(app: &AppHandle) -> Option<Arc<Shell>> {
    app.try_state::<Arc<Shell>>().map(|s| Arc::clone(&s))
}

/// Set up before the window is built: the saved close choice and window bounds.
pub fn init(app: &AppHandle, data: &std::path::Path) -> Arc<Shell> {
    let prefs_file = data.join("desktop-prefs.json");
    let state_file = data.join("window-state.json");
    let close = std::fs::read_to_string(&prefs_file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| {
            v.get("close")
                .and_then(|c| c.as_str())
                .map(Behaviour::parse)
        })
        .unwrap_or(Behaviour::Ask);
    let saved = window_state::load(&state_file);
    let shell = Arc::new(Shell {
        close: AtomicU8::new(code(close)),
        tray_ok: AtomicBool::new(true),
        quitting: AtomicBool::new(false),
        dialog_open: AtomicBool::new(false),
        approvals: AtomicU32::new(0),
        runs: AtomicU32::new(0),
        notifier: Mutex::new(Notifier::default()),
        click: Mutex::new(None),
        prefs_file,
        state_file,
        saved: Mutex::new((saved, false)),
    });
    app.manage(Arc::clone(&shell));
    // Bounds are written a moment after the last move, not on every pixel.
    let writer = Arc::clone(&shell);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        writer.flush_state();
    });
    shell
}

impl Shell {
    pub fn saved(&self) -> Option<Saved> {
        self.saved.lock().unwrap().0.clone()
    }

    pub fn set_tray(&self, ok: bool) {
        self.tray_ok.store(ok, Ordering::SeqCst);
    }

    fn behaviour(&self) -> Behaviour {
        behaviour(self.close.load(Ordering::SeqCst))
    }

    fn set_behaviour(&self, b: Behaviour) {
        if self.close.swap(code(b), Ordering::SeqCst) != code(b) {
            let _ = std::fs::write(
                &self.prefs_file,
                serde_json::json!({ "close": b.as_str() }).to_string(),
            );
        }
    }

    fn flush_state(&self) {
        let mut g = self.saved.lock().unwrap();
        if g.1 {
            g.1 = false;
            if let Some(s) = &g.0 {
                if let Err(e) = window_state::save(&self.state_file, s) {
                    log::warn!("could not save the window's place: {e}");
                }
            }
        }
    }

    /// Note where the window is now (not while it is maximised, full screen or minimised).
    fn note_window(&self, w: &Window) {
        let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor())
        else {
            return;
        };
        let snap = Snapshot {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            scale,
            maximized: w.is_maximized().unwrap_or(false),
            fullscreen: w.is_fullscreen().unwrap_or(false),
            minimized: w.is_minimized().unwrap_or(false),
        };
        let mut g = self.saved.lock().unwrap();
        let next = window_state::merge(g.0.as_ref(), &snap);
        if next != g.0 {
            g.0 = next;
            g.1 = true;
        }
    }
}

/// The monitors connected now, and which is the main one.
pub fn monitors(app: &AppHandle) -> (Vec<Monitor>, usize) {
    let list = app.available_monitors().unwrap_or_default();
    let primary_pos = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.position().x, m.position().y));
    let out: Vec<Monitor> = list
        .iter()
        .map(|m| Monitor {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
        })
        .collect();
    let primary = primary_pos
        .and_then(|p| out.iter().position(|m| (m.x, m.y) == p))
        .unwrap_or(0);
    (out, primary)
}

/// Put a window that is not shown yet where it was left, then the caller shows it.
pub fn apply_plan(w: &tauri::WebviewWindow, plan: &window_state::Plan) {
    if let Spot::At { x, y } = plan.spot {
        let _ = w.set_position(PhysicalPosition::new(x, y));
        // Moving to a monitor with another scale can change the size: set it again.
        let _ = w.set_size(LogicalSize::new(plan.width, plan.height));
    }
    if plan.fullscreen {
        let _ = w.set_fullscreen(true);
    } else if plan.maximized {
        let _ = w.maximize();
    }
}

pub fn core_of(app: &AppHandle) -> Option<Core> {
    let sup = crate::supervisor_of(app)?;
    Some(Core::new(sup.layout().ports.core, sup.service_token()?))
}

/// What is running and waiting right now (None when Core cannot be reached: still starting).
pub fn activity_now(app: &AppHandle) -> Option<Activity> {
    let core = core_of(app)?;
    let p = core.counts().ok()?;
    Some(Activity {
        runs: p.runs,
        approvals: p.approvals,
    })
}

/// A native question with two buttons; `done(true)` when the first was chosen.
pub fn ask(
    app: &AppHandle,
    title: &str,
    message: &str,
    first: &str,
    second: &str,
    done: impl FnOnce(bool) + Send + 'static,
) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            first.to_string(),
            second.to_string(),
        ))
        .show(done);
}

pub fn mark_quitting(app: &AppHandle) {
    if let Some(sh) = shell_of(app) {
        sh.quitting.store(true, Ordering::SeqCst);
    }
}

#[cfg(windows)]
fn shutting_down() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: a plain query with no pointers.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

#[cfg(not(windows))]
fn shutting_down() -> bool {
    false
}

fn do_quit(app: &AppHandle) {
    mark_quitting(app);
    app.exit(0);
}

/// Quit, after looking for runs and approvals that would be cut off. Core that
/// cannot be reached (still starting) has nothing to lose.
pub fn request_quit(app: &AppHandle) {
    let Some(sh) = shell_of(app) else {
        app.exit(0);
        return;
    };
    if sh.quitting.load(Ordering::SeqCst) || sh.dialog_open.swap(true, Ordering::SeqCst) {
        return;
    }
    if shutting_down() {
        do_quit(app);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        match activity_now(&app).and_then(|a| closing::quit_prompt(&a, false)) {
            None => do_quit(&app),
            Some(p) => {
                crate::show_main(&app);
                let handle = app.clone();
                ask(&app, p.title, &p.message, p.stop, p.wait, move |stop| {
                    if stop {
                        do_quit(&handle);
                    } else if let Some(sh) = shell_of(&handle) {
                        sh.dialog_open.store(false, Ordering::SeqCst);
                    }
                });
            }
        }
        // `do_quit` leaves the flag set: the app is going. A dismissed question clears it above.
    });
}

fn hide_to_tray(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    report_window(app);
}

/// The first close: ask once, remember the answer here and in Core.
fn first_close(app: &AppHandle) {
    let Some(sh) = shell_of(app) else { return };
    if sh.dialog_open.swap(true, Ordering::SeqCst) {
        return;
    }
    let f = closing::FIRST_CLOSE;
    let handle = app.clone();
    ask(app, f.title, f.message, f.tray, f.quit, move |keep| {
        let Some(sh) = shell_of(&handle) else { return };
        sh.dialog_open.store(false, Ordering::SeqCst);
        sh.set_behaviour(if keep {
            Behaviour::Tray
        } else {
            Behaviour::Quit
        });
        let value = sh.behaviour().as_str();
        if let Some(core) = core_of(&handle) {
            std::thread::spawn(move || {
                if let Err(e) = core.put_close(value) {
                    log::info!("could not tell Core the close choice ({e})");
                }
            });
        }
        if keep {
            hide_to_tray(&handle);
        } else {
            request_quit(&handle);
        }
    });
}

/// Window events from main.rs's builder.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let Some(sh) = shell_of(app) else {
        if let WindowEvent::CloseRequested { .. } = event {
            app.exit(0);
        }
        return;
    };
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let env = Env {
                tray: sh.tray_ok.load(Ordering::SeqCst),
                shutting_down: shutting_down(),
            };
            match closing::on_close(sh.behaviour(), env) {
                OnClose::QuitNow => {
                    sh.note_window(window);
                    sh.flush_state();
                    sh.quitting.store(true, Ordering::SeqCst);
                }
                OnClose::Hide => {
                    sh.note_window(window);
                    sh.flush_state();
                    api.prevent_close();
                    hide_to_tray(app);
                }
                OnClose::QuitChecked => {
                    sh.note_window(window);
                    sh.flush_state();
                    api.prevent_close();
                    request_quit(app);
                }
                OnClose::Ask => {
                    sh.note_window(window);
                    sh.flush_state();
                    api.prevent_close();
                    first_close(app);
                }
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => sh.note_window(window),
        WindowEvent::Focused(true) => {
            sh.notifier.lock().unwrap().seen();
            set_title(app, 0);
            // A system notification we could not hear a click on: coming back opens its place.
            if !cfg!(windows) {
                let target = sh.click.lock().unwrap().take();
                if let Some((href, at)) = target {
                    if at.elapsed() < CLICK_WINDOW {
                        crate::open_route(app, href);
                    }
                }
            }
            report_window(app);
        }
        WindowEvent::Focused(false) => report_window(app),
        _ => {}
    }
}

/// App-level events: Cmd+Q and closing the last window ask first; the exit itself stops the services.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::ExitRequested { api, code, .. } => {
            let Some(sh) = shell_of(app) else { return };
            if code.is_none() && !sh.quitting.load(Ordering::SeqCst) && !shutting_down() {
                api.prevent_exit();
                request_quit(app);
            }
        }
        RunEvent::Exit => {
            if let Some(sh) = shell_of(app) {
                if let Some(w) = app.get_webview_window("main").map(|w| w.as_ref().window()) {
                    sh.note_window(&w);
                }
                sh.flush_state();
            }
        }
        _ => {}
    }
}

fn set_title(app: &AppHandle, count: u32) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&notify::window_title(count));
        #[cfg(target_os = "macos")]
        let _ = w.set_badge_count(if count == 0 { None } else { Some(count as i64) });
    }
}

fn window_facts(app: &AppHandle) -> (bool, bool) {
    match app.get_webview_window("main") {
        Some(w) => (
            w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false),
            w.is_focused().unwrap_or(false),
        ),
        None => (false, false),
    }
}

fn report_window(app: &AppHandle) {
    let (visible, focused) = window_facts(app);
    let warming = crate::supervisor_of(app)
        .map(|s| s.status().warming)
        .unwrap_or_default();
    if let Some(core) = core_of(app) {
        std::thread::spawn(move || {
            let _ = core.window(visible, focused, &warming);
        });
    }
}

/// Begin polling Core, once it is up.
pub fn start_polling(app: AppHandle) {
    std::thread::spawn(move || {
        let mut cursor: u64 = 0;
        let mut last_report = (true, true, Vec::<String>::new());
        let mut since_report = 0u32;
        loop {
            std::thread::sleep(POLL_EVERY);
            let Some(sup) = crate::supervisor_of(&app) else {
                continue;
            };
            if sup.is_shutting() {
                return;
            }
            let (Some(core), Some(sh)) = (core_of(&app), shell_of(&app)) else {
                continue;
            };
            let (visible, focused) = window_facts(&app);
            let warming = sup.status().warming;
            since_report += 1;
            if (visible, focused, warming.clone()) != last_report || since_report >= 15 {
                since_report = 0;
                last_report = (visible, focused, warming.clone());
                let _ = core.window(visible, focused, &warming);
            }
            let Ok(p) = core.poll(cursor) else {
                continue;
            };
            cursor = p.seq;
            sh.approvals.store(p.approvals, Ordering::SeqCst);
            sh.runs.store(p.runs, Ordering::SeqCst);
            if !p.close.is_empty() {
                sh.set_behaviour(Behaviour::parse(&p.close));
            }
            crate::tray::set_background(&app, p.background && !visible);

            for c in &p.commands {
                handle_command(&app, &c.command);
            }

            let away = !visible || !focused;
            let (toasts, count) = {
                let mut n = sh.notifier.lock().unwrap();
                let fresh = n.fresh(p.notifications.clone());
                let toasts = n.plan(fresh, away);
                (toasts, n.count(p.approvals))
            };
            for t in &toasts {
                let handle = app.clone();
                let core = core.clone();
                notify::show(&app, t, move |click| on_click(&handle, &core, click));
            }
            if let Some(first) = toasts.first() {
                *sh.click.lock().unwrap() = Some((first.href.clone(), Instant::now()));
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.request_user_attention(Some(UserAttentionType::Informational));
                }
            }
            set_title(&app, if away { count } else { 0 });
        }
    });
}

fn handle_command(app: &AppHandle, command: &str) {
    match command {
        "quit" => request_quit(app),
        c if c.starts_with("update.") => {
            #[cfg(feature = "updater")]
            crate::updates::command(app, c);
            #[cfg(not(feature = "updater"))]
            log::info!("ignored {c}: this build has no updater");
        }
        other => log::info!("no such command {other}"),
    }
}

/// A click on a notification, or one of its buttons.
fn on_click(app: &AppHandle, core: &Core, click: Click) {
    match click {
        Click::Open(href) => {
            if notify::safe_href(&href) {
                crate::open_route(app, href);
            }
        }
        Click::Button {
            approval_id,
            approve,
        } => {
            let app = app.clone();
            let core = core.clone();
            std::thread::spawn(move || {
                if let Err(e) = core.approval_action(&approval_id, approve) {
                    // Refused (not Pro any more, a critical request, already answered): show it in the app.
                    log::info!("a notification button was refused ({e})");
                    crate::open_route(&app, format!("/open/approval/{approval_id}"));
                }
            });
        }
    }
}
