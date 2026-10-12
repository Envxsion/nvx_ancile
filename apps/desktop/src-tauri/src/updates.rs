// ------------------------------------------------------------------
//  Title    |  Updates
//  Ref      |  NVX licensing and updates v2 §7 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  Ask nvx.sh whether a newer NVX Ancile exists, and
//           |  install it when the person chooses to. Pro arrives and
//           |  leaves only this way: there is no separate Pro download.
//  How      |  Once the services are up, then every 6 hours, and on
//           |  the tray's "Check for updates":
//           |  GET https://ancile.nvx.sh/api/updates/{target}/{arch}/
//           |  {current_version}?edition=free|pro&installed=free|pro
//           |  &channel=stable|beta. `installed` is this build (Pro
//           |  when pro.js is beside Core's main.js); `edition` asks
//           |  for Pro when Pro is installed or a licence token is
//           |  held (a free install that turned a key on). Core gives
//           |  the channel and the token, sent as the Authorization
//           |  header. The answer:
//           |    200 "edition":"pro" to a free install: Pro is ready
//           |    200 "downgrade":true: Pro ended (90+ days, revoked):
//           |      one notice, one click, back to the free edition
//           |    200 otherwise: a plain update, or an older build
//           |      after a release was pulled (a rollback)
//           |    204: nothing newer (a lapsed Pro stays as it is)
//           |    503 or no answer: try again at the next check
//           |  Any 200 is an offer (nvx.sh decides, so the same version
//           |  in the other edition, or an older one, is offered too).
//           |  An older build would start on a database a newer one
//           |  updated: the tray warns first, a second click asks Core
//           |  for a backup, and only then installs. That older build
//           |  then offers the backup from before the update (Core's
//           |  start-up screen).
//           |  What is on offer is told to Core (POST /internal/v1/
//           |  desktop/update-offer) so Admin → Licence can say so.
//           |  Nothing installs without a click in the tray menu.
//  Note     |  The token is never written to a log.
// ------------------------------------------------------------------

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const ENDPOINT: &str = "https://ancile.nvx.sh/api/updates/{{target}}/{{arch}}/{{current_version}}";
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// One check at a time (the timer and the tray item may meet).
static CHECKING: AtomicBool = AtomicBool::new(false);
/// An install is under way: no check changes the tray line under it.
static INSTALLING: AtomicBool = AtomicBool::new(false);
/// The older build on offer was clicked once: the next click backs up and installs.
static ARMED: AtomicBool = AtomicBool::new(false);

/// The update found, waiting for the person to install it.
pub struct Waiting(pub Mutex<Option<Update>>);

/// The tray line that offers it.
pub struct TrayLine(pub MenuItem<tauri::Wry>);

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
/// installed, and the channel.
pub fn endpoint(wanted: Edition, installed: Edition, channel: &str) -> String {
    let channel = if channel == "beta" { "beta" } else { "stable" };
    format!(
        "{ENDPOINT}?edition={}&installed={}&channel={channel}",
        wanted.as_str(),
        installed.as_str()
    )
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

/// Tell Core what is on offer (None: nothing), for Admin → Licence:
/// (version, edition, downgrade, older).
fn tell_core(app: &AppHandle, offer: Option<(&str, &str, bool, bool)>) {
    let Some(sup) = crate::supervisor_of(app) else {
        return;
    };
    let Some(token) = sup.service_token() else {
        return;
    };
    let url = core_url(sup.layout().ports.core, "update-offer");
    let auth = format!("Bearer {token}");
    let sent = match offer {
        Some((version, edition, downgrade, older)) => ureq::post(&url)
            .set("authorization", &auth)
            .set("content-type", "application/json")
            .timeout(Duration::from_secs(5))
            .send_string(
                &serde_json::json!({
                    "version": version,
                    "edition": edition,
                    "downgrade": downgrade,
                    "older": older
                })
                .to_string(),
            ),
        None => ureq::delete(&url)
            .set("authorization", &auth)
            .timeout(Duration::from_secs(5))
            .call(),
    };
    if let Err(e) = sent {
        log::info!("updates: could not tell Core about the offer ({e})");
    }
}

/// Check now, then every 6 hours, on a thread of its own.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        check(&app);
        std::thread::sleep(EVERY);
    });
}

/// The tray's "Check for updates".
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
    run_check(app);
    CHECKING.store(false, Ordering::SeqCst);
}

fn run_check(app: &AppHandle) {
    let Some(sup) = crate::supervisor_of(app) else {
        return;
    };
    // An install already under way is not interrupted.
    if INSTALLING.load(Ordering::SeqCst) {
        return;
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
    let Ok(url) = Url::parse(&endpoint(wanted, installed, channel)) else {
        return;
    };
    // nvx.sh answers 204 when there is nothing to install, so any 200 is an
    // offer: the other edition of this version, or an older build after a rollback.
    let mut builder = match app.updater_builder().endpoints(vec![url]) {
        Ok(b) => b
            .timeout(Duration::from_secs(30))
            .version_comparator(|_current, _release| true),
        Err(e) => {
            log::info!("updates: endpoint not usable ({e})");
            return;
        }
    };
    // The licence proves Pro; the server decides what a lapsed or missing one gets.
    if let Some(token) = token {
        match builder.header("Authorization", format!("Bearer {token}")) {
            Ok(b) => builder = b,
            Err(_) => return,
        }
    }
    let Ok(updater) = builder.build() else {
        return;
    };
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
            ARMED.store(false, Ordering::SeqCst);
            let line = if older {
                older_text(&update.version, false)
            } else {
                tray_text(kind, &update.version)
            };
            set_line(app, &line, true);
            let offered = edition.as_deref().unwrap_or(installed.as_str());
            let offered = if offered == "pro" { "pro" } else { "free" };
            tell_core(
                app,
                Some((
                    &update.version,
                    offered,
                    kind == OfferKind::Downgrade,
                    older,
                )),
            );
            if let Some(w) = app.try_state::<Waiting>() {
                *w.0.lock().unwrap() = Some(update);
            }
        }
        Ok(None) => {
            log::info!("updates: this is the newest version");
            if let Some(w) = app.try_state::<Waiting>() {
                *w.0.lock().unwrap() = None;
            }
            set_line(app, "Up to date", false);
            tell_core(app, None);
        }
        // A 503 from nvx.sh, no network, or no server: try again at the next check.
        Err(e) => log::info!("updates: could not check ({e})"),
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

/// The tray's offer line: download, install, start again. One click for
/// Pro arriving, Pro ended or a plain update. An older build takes two: the
/// first warns, the second backs up the database and then installs.
pub fn install(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(update) = app
            .try_state::<Waiting>()
            .and_then(|w| w.0.lock().unwrap().take())
        else {
            return;
        };
        if is_older(&update.version, &update.current_version) {
            if !ARMED.swap(true, Ordering::SeqCst) {
                set_line(&app, &older_text(&update.version, true), true);
                crate::show_main(&app);
                if let Some(w) = app.try_state::<Waiting>() {
                    *w.0.lock().unwrap() = Some(update);
                }
                return;
            }
            ARMED.store(false, Ordering::SeqCst);
            set_line(&app, "Backing up your data first…", false);
            if let Err(e) = backup_first(&app) {
                log::error!("updates: the backup before an older version failed ({e})");
                set_line(
                    &app,
                    "The backup failed, so the older version was not installed",
                    false,
                );
                return;
            }
        }
        INSTALLING.store(true, Ordering::SeqCst);
        set_line(
            &app,
            &format!("Installing NVX Ancile {}…", update.version),
            false,
        );
        match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
            Ok(()) => {
                if let Some(sup) = crate::supervisor_of(&app) {
                    sup.shutdown();
                }
                app.restart();
            }
            Err(e) => {
                log::error!("updates: the update could not be installed ({e})");
                INSTALLING.store(false, Ordering::SeqCst);
                set_line(&app, "The update did not install. Try again later", false);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        classify, endpoint, is_older, older_text, tray_text, wants_pro, Edition, OfferKind,
    };

    #[test]
    fn endpoint_names_edition_installed_and_channel() {
        assert_eq!(
            endpoint(Edition::Pro, Edition::Free, "beta"),
            "https://ancile.nvx.sh/api/updates/{{target}}/{{arch}}/{{current_version}}?edition=pro&installed=free&channel=beta"
        );
        assert!(endpoint(Edition::Free, Edition::Free, "anything")
            .ends_with("?edition=free&installed=free&channel=stable"));
        assert!(endpoint(Edition::Pro, Edition::Pro, "stable")
            .ends_with("?edition=pro&installed=pro&channel=stable"));
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
}
