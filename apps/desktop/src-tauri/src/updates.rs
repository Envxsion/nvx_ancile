// ------------------------------------------------------------------
//  Title    |  Updates
//  Ref      |  NVX licensing and updates v2 §7 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  Ask nvx.sh whether a newer NVX Ancile exists, and
//           |  install it when the person chooses to.
//  How      |  Once the services are up, then every 24 hours:
//           |  GET https://ancile.nvx.sh/api/updates/{target}/{arch}/
//           |  {current_version}?edition=free|pro&channel=stable|beta.
//           |  The edition is Pro when Pro is bundled (pro.js beside
//           |  Core's main.js) or a licence token is held: a Pro
//           |  install whose licence lapsed was moved to the free build,
//           |  and asks for Pro again so a renewed licence brings Pro
//           |  back. Core tells us the channel and the token, sent as
//           |  the Authorization header; with no or a lapsed token the
//           |  server answers with the free build.
//           |  204: nothing newer. An update shows in the tray menu;
//           |  nothing installs without a click.
//  Note     |  No update server, or no network: fails quietly. The
//           |  token is never written to a log.
// ------------------------------------------------------------------

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const ENDPOINT: &str = "https://ancile.nvx.sh/api/updates/{{target}}/{{arch}}/{{current_version}}";
const EVERY: Duration = Duration::from_secs(24 * 3600);

/// The update found, waiting for the person to install it.
pub struct Waiting(pub Mutex<Option<Offer>>);

/// An update on offer. `free_for_pro`: the server offers the free edition to an
/// install that holds a licence (it lapsed): explained first, never installed
/// on the first click.
pub struct Offer {
    pub update: Update,
    pub free_for_pro: bool,
    pub explained: bool,
}

/// The server says which edition it offers ("edition" in its answer); the free
/// one, offered to an install holding a licence, means the licence lapsed.
pub fn free_offer_for_pro(token_held: bool, edition: Option<&str>) -> bool {
    token_held && edition == Some("free")
}

/// The tray line that offers it.
pub struct TrayLine(pub MenuItem<tauri::Wry>);

#[derive(serde::Deserialize)]
struct FromCore {
    channel: String,
    token: Option<String>,
}

/// Ask for the Pro edition when Pro is bundled, or when a licence token is
/// held (a lapsed Pro install on the free build, so renewal brings Pro back).
pub fn wants_pro(bundled: bool, has_token: bool) -> bool {
    bundled || has_token
}

/// The update endpoint for this install: its edition and channel in the query.
pub fn endpoint(pro: bool, channel: &str) -> String {
    let edition = if pro { "pro" } else { "free" };
    let channel = if channel == "beta" { "beta" } else { "stable" };
    format!("{ENDPOINT}?edition={edition}&channel={channel}")
}

fn ask_core(port: u16, service_token: &str) -> Option<FromCore> {
    ureq::get(&format!(
        "http://127.0.0.1:{port}/internal/v1/desktop/updates"
    ))
    .set("authorization", &format!("Bearer {service_token}"))
    .timeout(Duration::from_secs(5))
    .call()
    .ok()?
    .into_string()
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
}

/// Check now, then every day, on a thread of its own.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        check(&app);
        std::thread::sleep(EVERY);
    });
}

fn check(app: &AppHandle) {
    let Some(sup) = crate::supervisor_of(app) else {
        return;
    };
    let bundled = sup
        .layout()
        .sidecar("core")
        .join("dist")
        .join("pro.js")
        .exists();
    let from_core = sup
        .service_token()
        .and_then(|t| ask_core(sup.layout().ports.core, t));
    let token = from_core.as_ref().and_then(|c| c.token.as_deref());
    let pro = wants_pro(bundled, token.is_some());
    let channel = from_core
        .as_ref()
        .map(|c| c.channel.as_str())
        .unwrap_or("stable");
    let Ok(url) = Url::parse(&endpoint(pro, channel)) else {
        return;
    };
    let mut builder = match app.updater_builder().endpoints(vec![url]) {
        Ok(b) => b.timeout(Duration::from_secs(30)),
        Err(e) => {
            log::info!("updates: endpoint not usable ({e})");
            return;
        }
    };
    // The licence proves Pro; without a token, or with a lapsed one, the
    // server offers the free build.
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
            let edition = update.raw_json.get("edition").and_then(|e| e.as_str());
            let free_for_pro = free_offer_for_pro(token.is_some(), edition);
            log::info!("updates: {} is available (free for a Pro install: {free_for_pro})", update.version);
            if let Some(line) = app.try_state::<TrayLine>() {
                let _ = line.0.set_text(if free_for_pro {
                    "Pro licence lapsed: see your options".to_string()
                } else {
                    format!("Install NVX Ancile {} and restart", update.version)
                });
                let _ = line.0.set_enabled(true);
            }
            if let Some(w) = app.try_state::<Waiting>() {
                *w.0.lock().unwrap() = Some(Offer { update, free_for_pro, explained: false });
            }
        }
        Ok(None) => log::info!("updates: this is the newest version"),
        // No update server yet, offline, or a refusal: try again tomorrow.
        Err(e) => log::info!("updates: could not check ({e})"),
    }
}

/// The tray's "Install … and restart": download, install, start again.
pub fn install(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(offer) = app
            .try_state::<Waiting>()
            .and_then(|w| w.0.lock().unwrap().take())
        else {
            return;
        };
        // The free edition for a lapsed Pro install: the first click explains
        // (Renew, or install free anyway); only a second, deliberate click installs.
        if offer.free_for_pro && !offer.explained {
            let version = offer.update.version.clone();
            crate::open_route(&app, format!("/admin/license?lapsed_update={version}"));
            if let Some(line) = app.try_state::<TrayLine>() {
                let _ = line.0.set_text(format!(
                    "Install the free edition {version} anyway (Pro screens go, your data stays)"
                ));
            }
            if let Some(w) = app.try_state::<Waiting>() {
                *w.0.lock().unwrap() = Some(Offer { explained: true, ..offer });
            }
            return;
        }
        let update = offer.update;
        if let Some(line) = app.try_state::<TrayLine>() {
            let _ = line
                .0
                .set_text(format!("Installing NVX Ancile {}…", update.version));
            let _ = line.0.set_enabled(false);
        }
        match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
            Ok(()) => {
                if let Some(sup) = crate::supervisor_of(&app) {
                    sup.shutdown();
                }
                app.restart();
            }
            Err(e) => {
                log::error!("updates: the update could not be installed ({e})");
                if let Some(line) = app.try_state::<TrayLine>() {
                    let _ = line
                        .0
                        .set_text("The update did not install. Try again later");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{endpoint, free_offer_for_pro, wants_pro};

    #[test]
    fn endpoint_names_edition_and_channel() {
        assert_eq!(
            endpoint(true, "beta"),
            "https://ancile.nvx.sh/api/updates/{{target}}/{{arch}}/{{current_version}}?edition=pro&channel=beta"
        );
        assert!(endpoint(false, "anything").ends_with("?edition=free&channel=stable"));
    }

    #[test]
    fn pro_is_asked_for_when_bundled_or_licensed() {
        assert!(wants_pro(true, false), "a Pro install with no token still asks for Pro");
        assert!(wants_pro(false, true), "a lapsed Pro install on the free build asks for Pro again");
        assert!(!wants_pro(false, false), "a free install never asks for Pro");
    }

    #[test]
    fn a_free_offer_to_a_licensed_install_is_explained_not_installed() {
        assert!(free_offer_for_pro(true, Some("free")));
        assert!(!free_offer_for_pro(true, Some("pro")));
        assert!(!free_offer_for_pro(false, Some("free")), "a free install just updates");
        assert!(!free_offer_for_pro(true, None), "an older server without the field: a plain update");
    }
}
