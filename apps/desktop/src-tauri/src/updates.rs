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
//           |    200 otherwise: a plain update
//           |    204: nothing newer (a lapsed Pro stays as it is)
//           |    503 or no answer: try again at the next check
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

/// Tell Core what is on offer (None: nothing), for Admin → Licence.
fn tell_core(app: &AppHandle, offer: Option<(&str, &str, bool)>) {
    let Some(sup) = crate::supervisor_of(app) else {
        return;
    };
    let Some(token) = sup.service_token() else {
        return;
    };
    let url = core_url(sup.layout().ports.core, "update-offer");
    let auth = format!("Bearer {token}");
    let sent = match offer {
        Some((version, edition, downgrade)) => ureq::post(&url)
            .set("authorization", &auth)
            .set("content-type", "application/json")
            .timeout(Duration::from_secs(5))
            .send_string(
                &serde_json::json!({ "version": version, "edition": edition, "downgrade": downgrade })
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
    let mut builder = match app.updater_builder().endpoints(vec![url]) {
        Ok(b) => b.timeout(Duration::from_secs(30)),
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
            log::info!("updates: {} is available ({kind:?})", update.version);
            set_line(app, &tray_text(kind, &update.version), true);
            let offered = edition.as_deref().unwrap_or(installed.as_str());
            let offered = if offered == "pro" { "pro" } else { "free" };
            tell_core(
                app,
                Some((&update.version, offered, kind == OfferKind::Downgrade)),
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

/// The tray's offer line: download, install, start again. One click, for
/// every kind of offer (Pro arriving, Pro ended, or a plain update).
pub fn install(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(update) = app
            .try_state::<Waiting>()
            .and_then(|w| w.0.lock().unwrap().take())
        else {
            return;
        };
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
    use super::{classify, endpoint, tray_text, wants_pro, Edition, OfferKind};

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
