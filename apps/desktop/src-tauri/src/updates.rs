// ------------------------------------------------------------------
//  Title    |  Updates
//  Ref      |  NVX licensing and updates v2 §7 · ROADMAP row UP1 ·
//           |  docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  Ask nvx.sh whether a newer NVX Ancile exists, and
//           |  install it when the person chooses to. Pro arrives and
//           |  leaves only this way: there is no separate Pro download.
//  How      |  Once the services are up, then every 6 hours, and on
//           |  "Check for updates" (tray, or the update card in
//           |  Settings):
//           |  GET https://ancile.nvx.sh/api/updates/{target}/{arch}/
//           |  {current_version}?edition=free|pro&installed=free|pro
//           |  &channel=stable|beta[&pin=<version>]. `installed` is this
//           |  build (Pro when pro.js is beside Core's main.js);
//           |  `edition` asks for Pro when Pro is installed or a
//           |  licence token is held (a free install that turned a key
//           |  on). Core gives the channel (Beta is a Pro extra: Core
//           |  answers stable otherwise) and the token, sent as the
//           |  Authorization header. The answer:
//           |    200 "edition":"pro" to a free install: Pro is ready
//           |    200 "downgrade":true: Pro ended (90+ days, revoked):
//           |      one notice, one click, back to the free edition
//           |    200 otherwise: a plain update, or an older build
//           |      after a release was pulled (a rollback)
//           |    204: nothing newer (a lapsed Pro stays as it is)
//           |    503 or no answer: try again at the next check
//           |  Any 200 is an offer (nvx.sh decides, so the same version
//           |  in the other edition, or an older one, is offered too).
//           |  What is on offer, with its notes, size and progress, is
//           |  told to Core (POST /internal/v1/desktop/update-offer) so
//           |  Settings can show the card and the status bar the pill.
//           |  The Cockpit gives commands through Core (the shell polls
//           |  for them): Restart now, When I quit, Tonight, Cancel and
//           |  (Pro) Go back to the previous version.
//           |    Restart now: download, then wait for the runs and
//           |      approvals to finish or ask to stop them, then
//           |      install and restart.
//           |    When I quit: download now, install as the app exits.
//           |    Tonight: download now, install at the next 03:00 once
//           |      nothing is running (schedule.rs).
//           |    Go back (Pro): ask nvx.sh for the version this one
//           |      replaced (&pin=), back up the data first through
//           |      Core (the existing backup-first path) and install it.
//           |  A download that breaks is tried again a few times, from
//           |  the start (the updater cannot resume), then reported.
//           |  An older build would start on a database a newer one
//           |  updated: that is why the backup comes first, and that
//           |  older build then offers the backup from before the
//           |  update (Core's start-up screen).
//  Note     |  The token is never written to a log. Nothing is
//           |  downloaded or installed without a click, so a metered
//           |  connection is always asked first. After an update the
//           |  next start tells Core what changed (the one-time "What
//           |  changed" sheet).
// ------------------------------------------------------------------

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::closing::{quit_prompt, Activity};
use crate::schedule::{self, When};

const ENDPOINT: &str = "https://ancile.nvx.sh/api/updates/{{target}}/{{arch}}/{{current_version}}";
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// One check at a time (the timer and the tray item may meet).
static CHECKING: AtomicBool = AtomicBool::new(false);
/// An install is under way: no check changes the card under it.
static INSTALLING: AtomicBool = AtomicBool::new(false);
/// One download at a time.
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// The update found, waiting for the person to install it.
pub struct Waiting(pub Mutex<Option<Update>>);

/// The tray line that offers it.
pub struct TrayLine(pub MenuItem<tauri::Wry>);

/// What the person chose, and how far it has got. Told to Core at each change.
#[derive(Default)]
struct Flow {
    when_quit: bool,
    tonight_at: Option<i64>,
    /// "Restart now" is waiting for the runs to finish.
    waiting_idle: bool,
    downloaded: Option<(Update, Vec<u8>)>,
    state: Option<&'static str>,
    progress: Option<f64>,
    size: Option<u64>,
    error: Option<String>,
    /// The one found, for reporting (the Update itself may be held in `downloaded`).
    offered: Option<Offered>,
}

#[derive(Clone)]
struct Offered {
    version: String,
    edition: String,
    downgrade: bool,
    older: bool,
    notes: Option<String>,
}

static FLOW: Mutex<Flow> = Mutex::new(Flow {
    when_quit: false,
    tonight_at: None,
    waiting_idle: false,
    downloaded: None,
    state: None,
    progress: None,
    size: None,
    error: None,
    offered: None,
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    Free,
    Pro,
}

impl Edition {
    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Free => "free",
            Edition::Pro => "pro",
        }
    }
}

/// What an offered update means for this install.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferKind {
    /// A newer build of the edition already installed.
    Normal,
    /// A free install offered the Pro build: a key was turned on here.
    CrossToPro,
    /// The licence ended 90 or more days ago, or was revoked: back to free.
    Downgrade,
}

/// Is `offered` an older version than `current`? Dotted numbers; a
/// pre-release (`0.4.0-beta.1`) comes before its release.
pub fn is_older(offered: &str, current: &str) -> bool {
    fn parts(v: &str) -> (Vec<u64>, bool) {
        let v = v.trim().trim_start_matches('v');
        let core = v.split(['-', '+']).next().unwrap_or(v);
        let pre = v.split('+').next().unwrap_or(v).contains('-');
        (
            core.split('.').map(|p| p.parse().unwrap_or(0)).collect(),
            pre,
        )
    }
    let (a, a_pre) = parts(offered);
    let (b, b_pre) = parts(current);
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    a_pre && !b_pre
}

/// The tray line for an older build: a warning first, then what the second click does.
pub fn older_text(version: &str, armed: bool) -> String {
    if armed {
        format!("Back up your data and install NVX Ancile {version}")
    } else {
        format!("NVX Ancile {version} is older than this version: read before installing")
    }
}

/// Read the server's "edition" and "downgrade" against what is installed.
pub fn classify(installed: Edition, offered: Option<&str>, downgrade: bool) -> OfferKind {
    if downgrade && installed == Edition::Pro {
        OfferKind::Downgrade
    } else if installed == Edition::Free && offered == Some("pro") {
        OfferKind::CrossToPro
    } else {
        OfferKind::Normal
    }
}

/// The tray line for an offer.
pub fn tray_text(kind: OfferKind, version: &str) -> String {
    match kind {
        OfferKind::CrossToPro => "Pro is ready. Install".to_string(),
        OfferKind::Downgrade => {
            "Pro ended: switching to the free edition (your data stays)".to_string()
        }
        OfferKind::Normal => format!("Install NVX Ancile {version} and restart"),
    }
}

#[derive(serde::Deserialize)]
struct FromCore {
    channel: String,
    token: Option<String>,
}

/// Ask for the Pro edition when Pro is installed, or when a licence token is
/// held (a free install that turned a key on, or a lapsed Pro install).
pub fn wants_pro(bundled: bool, has_token: bool) -> bool {
    bundled || has_token
}

/// The update endpoint for this install: the edition asked for, the one
/// installed, the channel, and (Go back) the exact version wanted.
pub fn endpoint(wanted: Edition, installed: Edition, channel: &str, pin: Option<&str>) -> String {
    let channel = if channel == "beta" { "beta" } else { "stable" };
    let mut url = format!(
        "{ENDPOINT}?edition={}&installed={}&channel={channel}",
        wanted.as_str(),
        installed.as_str()
    );
    if let Some(v) = pin.filter(|v| plain_version(v)) {
        url.push_str("&pin=");
        url.push_str(v);
    }
    url
}

/// A version number and nothing that could change the address it goes into.
pub fn plain_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 40
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
}

/// What was installed over what, kept so the next start can say what changed and
/// Pro's "Go back" knows the version to ask for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub from: String,
    pub to: String,
    pub notes: Option<String>,
    #[serde(default)]
    pub reported: bool,
}

pub fn history_path(data: &Path) -> PathBuf {
    data.join("update-history.json")
}

pub fn read_history(data: &Path) -> Option<History> {
    let text = std::fs::read_to_string(history_path(data)).ok()?;
    let h: History = serde_json::from_str(&text).ok()?;
    (plain_version(&h.from) && plain_version(&h.to)).then_some(h)
}

fn write_history(data: &Path, h: &History) {
    if let Ok(json) = serde_json::to_vec_pretty(h) {
        let _ = std::fs::write(history_path(data), json);
    }
}

/// The version this one replaced, when the last update went to the version running now.
pub fn previous_version(h: Option<&History>, running: &str) -> Option<String> {
    h.filter(|h| h.to == running && h.from != running)
        .map(|h| h.from.clone())
}

/// At start: if the app is on a version it was not on, tell Core once what changed.
pub fn report_if_updated(app: &AppHandle) {
    let Some(sup) = crate::supervisor_of(app) else {
        return;
    };
    let data = sup.layout().data.clone();
    let Some(mut h) = read_history(&data) else {
        return;
    };
    let running = env!("CARGO_PKG_VERSION");
    if h.to != running || h.reported {
        return;
    }
    if let Some(core) = crate::shell::core_of(app) {
        match core.updated(&h.from, &h.to, h.notes.as_deref()) {
            Ok(()) => {
                h.reported = true;
                write_history(&data, &h);
            }
            Err(e) => log::info!("updates: could not tell Core what changed ({e})"),
        }
    }
}

fn core_url(port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{port}/internal/v1/desktop/{path}")
}

fn ask_core(port: u16, service_token: &str) -> Option<FromCore> {
    ureq::get(&core_url(port, "updates"))
        .set("authorization", &format!("Bearer {service_token}"))
        .timeout(Duration::from_secs(5))
        .call()
        .ok()?
        .into_string()
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// What the card shows, as Core takes it (contracts license.ts UpdateOfferReport).
fn report_json(f: &Flow, o: &Offered, previous: Option<&str>) -> serde_json::Value {
    let when = if f.tonight_at.is_some() {
        When::Tonight
    } else if f.when_quit {
        When::OnQuit
    } else {
        When::Unset
    };
    serde_json::json!({
        "version": o.version,
        "edition": o.edition,
        "downgrade": o.downgrade,
        "older": o.older,
        "notes": o.notes,
        "size_bytes": f.size,
        "state": f.state.unwrap_or("available"),
        "progress": f.progress,
        "when": when.as_str(),
        "scheduled_for": f.tonight_at.map(schedule::iso_utc),
        "error": f.error,
        "previous_version": previous,
    })
}

/// Tell Core what is on offer and how it is going (None: nothing), for the card and the pill.
fn tell_core(app: &AppHandle, offer: Option<serde_json::Value>) {
    let Some(sup) = crate::supervisor_of(app) else {
        return;
    };
    let Some(token) = sup.service_token() else {
        return;
    };
    let url = core_url(sup.layout().ports.core, "update-offer");
    let auth = format!("Bearer {token}");
    let sent = match offer {
        Some(body) => ureq::post(&url)
            .set("authorization", &auth)
            .set("content-type", "application/json")
            .timeout(Duration::from_secs(5))
            .send_string(&body.to_string()),
        None => ureq::delete(&url)
            .set("authorization", &auth)
            .timeout(Duration::from_secs(5))
            .call(),
    };
    if let Err(e) = sent {
        log::info!("updates: could not tell Core about the offer ({e})");
    }
}

fn report(app: &AppHandle) {
    let (body, none) = {
        let f = FLOW.lock().unwrap();
        match &f.offered {
            Some(o) => {
                let running = env!("CARGO_PKG_VERSION");
                let prev = crate::supervisor_of(app).and_then(|s| {
                    previous_version(read_history(&s.layout().data).as_ref(), running)
                });
                (Some(report_json(&f, o, prev.as_deref())), false)
            }
            None => (None, true),
        }
    };
    if body.is_some() || none {
        tell_core(app, body);
    }
}

fn set_state(app: &AppHandle, state: &'static str, progress: Option<f64>, error: Option<String>) {
    {
        let mut f = FLOW.lock().unwrap();
        f.state = Some(state);
        f.progress = progress;
        f.error = error;
    }
    report(app);
}

/// Check now, then every 6 hours, on a thread of its own. Also runs what the
/// person scheduled: Tonight, and a Restart now that is waiting for runs to end.
pub fn spawn(app: AppHandle) {
    let timer = app.clone();
    std::thread::spawn(move || loop {
        check(&timer);
        std::thread::sleep(EVERY);
    });
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        scheduled(&app);
    });
}

/// The tray's "Check for updates", or the card's.
pub fn check_now(app: AppHandle) {
    std::thread::spawn(move || check(&app));
}

fn set_line(app: &AppHandle, text: &str, enabled: bool) {
    if let Some(line) = app.try_state::<TrayLine>() {
        let _ = line.0.set_text(text);
        let _ = line.0.set_enabled(enabled);
    }
}

fn check(app: &AppHandle) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    run_check(app, None);
    CHECKING.store(false, Ordering::SeqCst);
}

/// Look for an update. `pin`: the exact version wanted (Go back).
fn run_check(app: &AppHandle, pin: Option<&str>) -> Option<Update> {
    let sup = crate::supervisor_of(app)?;
    // An install already under way is not interrupted.
    if INSTALLING.load(Ordering::SeqCst) {
        return None;
    }
    let bundled = sup
        .layout()
        .sidecar("core")
        .join("dist")
        .join("pro.js")
        .exists();
    let installed = if bundled { Edition::Pro } else { Edition::Free };
    let from_core = sup
        .service_token()
        .and_then(|t| ask_core(sup.layout().ports.core, t));
    let token = from_core.as_ref().and_then(|c| c.token.as_deref());
    let wanted = if wants_pro(bundled, token.is_some()) {
        Edition::Pro
    } else {
        Edition::Free
    };
    let channel = from_core
        .as_ref()
        .map(|c| c.channel.as_str())
        .unwrap_or("stable");
    let url = Url::parse(&endpoint(wanted, installed, channel, pin)).ok()?;
    // nvx.sh answers 204 when there is nothing to install, so any 200 is an
    // offer: the other edition of this version, or an older build after a rollback.
    let mut builder = match app.updater_builder().endpoints(vec![url]) {
        Ok(b) => b
            .timeout(Duration::from_secs(30))
            .version_comparator(|_current, _release| true),
        Err(e) => {
            log::info!("updates: endpoint not usable ({e})");
            return None;
        }
    };
    // The licence proves Pro; the server decides what a lapsed or missing one gets.
    if let Some(token) = token {
        match builder.header("Authorization", format!("Bearer {token}")) {
            Ok(b) => builder = b,
            Err(_) => return None,
        }
    }
    let updater = builder.build().ok()?;
    match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(update)) => {
            let edition = update
                .raw_json
                .get("edition")
                .and_then(|e| e.as_str())
                .map(str::to_owned);
            let downgrade = update
                .raw_json
                .get("downgrade")
                .and_then(|d| d.as_bool())
                .unwrap_or(false);
            let kind = classify(installed, edition.as_deref(), downgrade);
            let older = is_older(&update.version, &update.current_version);
            log::info!(
                "updates: {} is available ({kind:?}{})",
                update.version,
                if older { ", older" } else { "" }
            );
            let line = if older {
                older_text(&update.version, false)
            } else {
                tray_text(kind, &update.version)
            };
            set_line(app, &line, true);
            let offered = edition.as_deref().unwrap_or(installed.as_str());
            let offered = if offered == "pro" { "pro" } else { "free" };
            {
                let mut f = FLOW.lock().unwrap();
                // The same version again (the 6-hourly check): keep what the person chose.
                let same = f
                    .offered
                    .as_ref()
                    .map(|o| o.version == update.version)
                    .unwrap_or(false);
                if !same {
                    *f = Flow::default();
                }
                f.offered = Some(Offered {
                    version: update.version.clone(),
                    edition: offered.into(),
                    downgrade: kind == OfferKind::Downgrade,
                    older,
                    notes: update.body.clone().map(|b| b.chars().take(8000).collect()),
                });
                if f.state.is_none() {
                    f.state = Some("available");
                }
            }
            report(app);
            if let Some(w) = app.try_state::<Waiting>() {
                *w.0.lock().unwrap() = Some(update.clone());
            }
            Some(update)
        }
        Ok(None) => {
            log::info!("updates: this is the newest version");
            if let Some(w) = app.try_state::<Waiting>() {
                *w.0.lock().unwrap() = None;
            }
            if pin.is_none() {
                *FLOW.lock().unwrap() = Flow::default();
                set_line(app, "Up to date", false);
                tell_core(app, None);
            }
            None
        }
        // A 503 from nvx.sh, no network, or no server: try again at the next check.
        Err(e) => {
            log::info!("updates: could not check ({e})");
            None
        }
    }
}

/// Ask Core for a backup before an older build is installed over this data.
fn backup_first(app: &AppHandle) -> Result<(), String> {
    let sup = crate::supervisor_of(app).ok_or("NVX Ancile is not running")?;
    let token = sup.service_token().ok_or("no service token")?;
    let url = core_url(sup.layout().ports.core, "backup");
    ureq::post(&url)
        .set("authorization", &format!("Bearer {token}"))
        .set("content-type", "application/json")
        .timeout(Duration::from_secs(35 * 60))
        .send_string(r#"{"reason":"before-downgrade"}"#)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Download the update held in `Waiting`, with progress, trying again if it breaks.
/// Returns false when it could not be fetched (the card says why).
fn download(app: &AppHandle) -> bool {
    if FLOW.lock().unwrap().downloaded.is_some() {
        return true;
    }
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        // Another command is already fetching it: wait for that one.
        while DOWNLOADING.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(300));
        }
        return FLOW.lock().unwrap().downloaded.is_some();
    }
    let ok = download_inner(app);
    DOWNLOADING.store(false, Ordering::SeqCst);
    ok
}

fn download_inner(app: &AppHandle) -> bool {
    let Some(update) = app
        .try_state::<Waiting>()
        .and_then(|w| w.0.lock().unwrap().clone())
    else {
        set_state(
            app,
            "failed",
            None,
            Some("There is nothing to download. Check for updates first.".into()),
        );
        return false;
    };
    set_state(app, "downloading", Some(0.0), None);
    let mut attempt = 0;
    loop {
        let mut got: u64 = 0;
        let mut last = Instant::now();
        let handle = app.clone();
        let result = tauri::async_runtime::block_on(update.download(
            |chunk, total| {
                got += chunk as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    FLOW.lock().unwrap().size = Some(t);
                    if last.elapsed() > Duration::from_millis(900) {
                        last = Instant::now();
                        {
                            let mut f = FLOW.lock().unwrap();
                            f.state = Some("downloading");
                            f.progress = Some((got as f64 / t as f64).min(1.0));
                        }
                        report(&handle);
                    }
                }
            },
            || {},
        ));
        match result {
            Ok(bytes) => {
                {
                    let mut f = FLOW.lock().unwrap();
                    f.size = Some(bytes.len() as u64);
                    f.downloaded = Some((update.clone(), bytes));
                }
                set_state(app, "ready", Some(1.0), None);
                return true;
            }
            Err(e) => {
                log::warn!("updates: the download broke ({e})");
                match schedule::retry_delay(attempt) {
                    Some(wait) => {
                        attempt += 1;
                        std::thread::sleep(wait);
                    }
                    None => {
                        set_state(
                            app,
                            "failed",
                            None,
                            Some(
                                "The download did not finish. Check your connection and try again."
                                    .into(),
                            ),
                        );
                        return false;
                    }
                }
            }
        }
    }
}

/// Stop the services cleanly, install, and start again. The older-build backup
/// has been taken by the caller when it was needed.
fn install_now(app: &AppHandle) {
    let Some((update, bytes)) = FLOW.lock().unwrap().downloaded.take() else {
        return;
    };
    INSTALLING.store(true, Ordering::SeqCst);
    set_state(app, "installing", Some(1.0), None);
    set_line(
        app,
        &format!("Installing NVX Ancile {}…", update.version),
        false,
    );
    remember_history(app, &update);
    crate::shell::mark_quitting(app);
    if let Some(sup) = crate::supervisor_of(app) {
        sup.shutdown();
    }
    // On Windows a successful install ends this process after starting the installer.
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            log::error!("updates: the update could not be installed ({e})");
            // The services are stopped: start fresh, with the old version, rather than leave a blank app.
            app.restart();
        }
    }
}

fn remember_history(app: &AppHandle, update: &Update) {
    if let Some(sup) = crate::supervisor_of(app) {
        write_history(
            &sup.layout().data,
            &History {
                from: update.current_version.clone(),
                to: update.version.clone(),
                notes: update.body.clone().map(|b| b.chars().take(8000).collect()),
                reported: false,
            },
        );
    }
}

/// Before an older build goes in: the backup, through Core. False when it failed
/// (then nothing is installed).
fn back_up_for_older(app: &AppHandle) -> bool {
    let older = FLOW
        .lock()
        .unwrap()
        .offered
        .as_ref()
        .map(|o| o.older)
        .unwrap_or(false);
    if !older {
        return true;
    }
    set_line(app, "Backing up your data first…", false);
    match backup_first(app) {
        Ok(()) => true,
        Err(e) => {
            log::error!("updates: the backup before an older version failed ({e})");
            set_line(
                app,
                "The backup failed, so the older version was not installed",
                false,
            );
            set_state(
                app,
                "failed",
                None,
                Some("The backup failed, so the older version was not installed.".into()),
            );
            false
        }
    }
}

/// The live runs and approvals right now, from Core (None when it cannot be reached).
fn live(app: &AppHandle) -> Option<Activity> {
    crate::shell::activity_now(app)
}

/// "Restart now": fetch it, wait for the runs and approvals to end or be stopped, install.
fn restart_now(app: &AppHandle) {
    if !download(app) {
        return;
    }
    match live(app).and_then(|a| quit_prompt(&a, true)) {
        None => install_flow(app),
        Some(p) => {
            let handle = app.clone();
            crate::shell::ask(app, p.title, &p.message, p.stop, p.wait, move |stop| {
                if stop {
                    std::thread::spawn(move || install_flow(&handle));
                } else {
                    // Wait: the scheduler installs it the moment nothing is running.
                    FLOW.lock().unwrap().waiting_idle = true;
                    set_state(&handle, "waiting", Some(1.0), None);
                }
            });
        }
    }
}

/// The backup (for an older build), then the install: the order never changes.
fn install_flow(app: &AppHandle) {
    if back_up_for_older(app) {
        install_now(app);
    }
}

/// Install on a timer: Tonight, or a Restart now that waited for runs.
fn scheduled(app: &AppHandle) {
    if INSTALLING.load(Ordering::SeqCst) {
        return;
    }
    let (tonight, waiting) = {
        let f = FLOW.lock().unwrap();
        (f.tonight_at, f.waiting_idle)
    };
    if tonight.is_none() && !waiting {
        return;
    }
    let Some(act) = live(app) else {
        return;
    };
    let now = unix_now();
    let go = if waiting {
        schedule::idle(&act)
    } else {
        schedule::next(When::Tonight, tonight, now, &act) == schedule::Next::Install
    };
    if go && download(app) {
        install_flow(app);
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A command from the Cockpit through Core (or the tray's update line).
pub fn command(app: &AppHandle, name: &str) {
    let app = app.clone();
    let name = name.to_string();
    std::thread::spawn(move || match name.as_str() {
        "update.check" => check(&app),
        "update.restart_now" => {
            FLOW.lock().unwrap().tonight_at = None;
            restart_now(&app)
        }
        "update.on_quit" => {
            {
                let mut f = FLOW.lock().unwrap();
                f.when_quit = true;
                f.tonight_at = None;
                f.waiting_idle = false;
            }
            report(&app);
            download(&app);
        }
        "update.tonight" => {
            let at = schedule::tonight_after(unix_now(), schedule::local_offset_secs());
            {
                let mut f = FLOW.lock().unwrap();
                f.tonight_at = Some(at);
                f.when_quit = false;
                f.waiting_idle = false;
            }
            report(&app);
            download(&app);
        }
        "update.cancel" => {
            {
                let mut f = FLOW.lock().unwrap();
                f.tonight_at = None;
                f.when_quit = false;
                f.waiting_idle = false;
            }
            report(&app);
        }
        "update.go_back" => go_back(&app),
        other => log::info!("updates: no such command {other}"),
    });
}

// TODO(phase-0.1.1): Go back asks nvx.sh for `&pin=<version>`. The update server
// (ancile.nvx.sh/api/updates) must serve that exact build for a Pro licence; until it does,
// the check answers 204 and Go back reports nothing to install.
/// Pro: install the version this one replaced. Core only queues this for Pro;
/// the Cockpit has asked first, and the data is backed up before the older build goes in.
fn go_back(app: &AppHandle) {
    let Some(sup) = crate::supervisor_of(app) else {
        return;
    };
    let running = env!("CARGO_PKG_VERSION");
    let Some(prev) = previous_version(read_history(&sup.layout().data).as_ref(), running) else {
        log::info!("updates: there is no previous version to go back to");
        return;
    };
    let Some(_update) = run_check(app, Some(&prev)) else {
        // Say so on the card rather than do nothing.
        {
            let mut f = FLOW.lock().unwrap();
            *f = Flow::default();
            f.offered = Some(Offered {
                version: prev.clone(),
                edition: "pro".into(),
                downgrade: false,
                older: true,
                notes: None,
            });
        }
        set_state(
            app,
            "failed",
            None,
            Some(format!(
                "NVX Ancile {prev} could not be fetched to go back to. Nothing was changed."
            )),
        );
        return;
    };
    // The pinned build is older than this one, so the backup is taken first.
    restart_now(app);
}

/// The tray's update line: the same as "Restart now".
pub fn install(app: AppHandle) {
    command(&app, "update.restart_now");
}

/// As the app exits: the update the person chose for "When I quit". Services are
/// stopped by now. On Windows a successful install ends this process.
pub fn install_on_quit(app: &AppHandle) {
    let chosen = FLOW.lock().unwrap().when_quit;
    if !chosen {
        return;
    }
    let Some((update, bytes)) = FLOW.lock().unwrap().downloaded.take() else {
        return;
    };
    // An older build would need the backup, which needs Core: those wait for a restart.
    if FLOW
        .lock()
        .unwrap()
        .offered
        .as_ref()
        .map(|o| o.older)
        .unwrap_or(false)
    {
        return;
    }
    remember_history(app, &update);
    if let Err(e) = update.install(bytes) {
        log::error!("updates: the update could not be installed on quit ({e})");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify, endpoint, is_older, older_text, plain_version, previous_version, tray_text,
        wants_pro, Edition, History, OfferKind,
    };

    #[test]
    fn endpoint_names_edition_installed_and_channel() {
        assert_eq!(
            endpoint(Edition::Pro, Edition::Free, "beta", None),
            "https://ancile.nvx.sh/api/updates/{{target}}/{{arch}}/{{current_version}}?edition=pro&installed=free&channel=beta"
        );
        assert!(endpoint(Edition::Free, Edition::Free, "anything", None)
            .ends_with("?edition=free&installed=free&channel=stable"));
        assert!(endpoint(Edition::Pro, Edition::Pro, "stable", None)
            .ends_with("?edition=pro&installed=pro&channel=stable"));
    }

    #[test]
    fn go_back_pins_the_version_and_only_a_plain_one() {
        assert!(
            endpoint(Edition::Pro, Edition::Pro, "stable", Some("0.4.0"))
                .ends_with("&channel=stable&pin=0.4.0")
        );
        assert!(
            endpoint(Edition::Pro, Edition::Pro, "stable", Some("0.5.0-beta.2"))
                .ends_with("&pin=0.5.0-beta.2")
        );
        for odd in ["", "0.4.0&edition=free", "../x", "0.4 .0", "0.4.0/../../"] {
            assert!(
                !endpoint(Edition::Pro, Edition::Pro, "stable", Some(odd)).contains("pin="),
                "{odd:?}"
            );
        }
        assert!(plain_version("1.2.3"));
        assert!(!plain_version(&"1".repeat(41)));
    }

    #[test]
    fn pro_is_asked_for_when_installed_or_licensed() {
        assert!(
            wants_pro(true, false),
            "a Pro install with no token still asks for Pro"
        );
        assert!(
            wants_pro(false, true),
            "a free install holding a key's token asks for Pro"
        );
        assert!(
            !wants_pro(false, false),
            "a free install with no key never asks for Pro"
        );
    }

    #[test]
    fn offers_are_classified_against_what_is_installed() {
        assert_eq!(
            classify(Edition::Free, Some("pro"), false),
            OfferKind::CrossToPro
        );
        assert_eq!(
            classify(Edition::Pro, Some("free"), true),
            OfferKind::Downgrade
        );
        assert_eq!(classify(Edition::Pro, None, true), OfferKind::Downgrade);
        assert_eq!(
            classify(Edition::Pro, Some("pro"), false),
            OfferKind::Normal
        );
        assert_eq!(
            classify(Edition::Free, Some("free"), false),
            OfferKind::Normal
        );
        assert_eq!(
            classify(Edition::Free, None, false),
            OfferKind::Normal,
            "an older server: a plain update"
        );
        assert_eq!(
            classify(Edition::Free, Some("free"), true),
            OfferKind::Normal,
            "a free install has nothing to leave"
        );
    }

    #[test]
    fn an_older_build_is_told_apart_from_a_newer_one() {
        assert!(is_older("0.3.9", "0.4.0"));
        assert!(is_older("0.4.0-beta.2", "0.4.0"));
        assert!(is_older("0.9.0", "0.10.0"), "numbers, not text");
        assert!(
            !is_older("0.4.0", "0.4.0"),
            "the other edition of this version"
        );
        assert!(!is_older("0.4.1", "0.4.0"));
        assert!(!is_older("0.4.0", "0.4.0-beta.2"));
    }

    #[test]
    fn an_older_build_is_warned_about_before_it_is_installed() {
        assert_eq!(
            older_text("0.3.9", false),
            "NVX Ancile 0.3.9 is older than this version: read before installing"
        );
        assert_eq!(
            older_text("0.3.9", true),
            "Back up your data and install NVX Ancile 0.3.9"
        );
    }

    #[test]
    fn each_offer_has_its_own_tray_line() {
        assert_eq!(
            tray_text(OfferKind::CrossToPro, "0.4.0"),
            "Pro is ready. Install"
        );
        assert_eq!(
            tray_text(OfferKind::Downgrade, "0.4.0"),
            "Pro ended: switching to the free edition (your data stays)"
        );
        assert_eq!(
            tray_text(OfferKind::Normal, "0.4.0"),
            "Install NVX Ancile 0.4.0 and restart"
        );
    }

    #[test]
    fn the_previous_version_is_known_only_right_after_an_update() {
        let h = History {
            from: "0.3.0".into(),
            to: "0.4.0".into(),
            notes: None,
            reported: true,
        };
        assert_eq!(
            previous_version(Some(&h), "0.4.0").as_deref(),
            Some("0.3.0")
        );
        assert_eq!(
            previous_version(Some(&h), "0.5.0"),
            None,
            "a later version was installed some other way"
        );
        assert_eq!(previous_version(None, "0.4.0"), None);
        let same = History {
            from: "0.4.0".into(),
            to: "0.4.0".into(),
            notes: None,
            reported: false,
        };
        assert_eq!(
            previous_version(Some(&same), "0.4.0"),
            None,
            "the other edition of the same version"
        );
    }

    #[test]
    fn history_is_read_back_and_a_bad_file_is_ignored() {
        let dir = std::env::temp_dir().join(format!("ancile-hist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(super::read_history(&dir), None);
        let h = History {
            from: "0.3.0".into(),
            to: "0.4.0".into(),
            notes: Some("Fixes.".into()),
            reported: false,
        };
        super::write_history(&dir, &h);
        assert_eq!(super::read_history(&dir), Some(h));
        std::fs::write(super::history_path(&dir), "not json").unwrap();
        assert_eq!(super::read_history(&dir), None);
        std::fs::write(
            super::history_path(&dir),
            r#"{"from":"../..","to":"0.4.0"}"#,
        )
        .unwrap();
        assert_eq!(
            super::read_history(&dir),
            None,
            "a version that is not a version"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
