// ------------------------------------------------------------------
//  Title    |  Core's desktop API
//  Ref      |  packages/contracts/src/desktop.ts · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  The shell's short, plain-HTTP conversation with Core on
//           |  127.0.0.1: the regular poll, the window report, the
//           |  close choice, and the one button press on a
//           |  notification.
//  How      |  Every call under /internal/v1 carries the service token,
//           |  which only this host holds, and a short timeout: Core being slow or
//           |  not started yet is an answer ("not now"), never a
//           |  hang. Nothing here is a model call or leaves the
//           |  machine, so it does not go through the resilience
//           |  layer's retry (the next poll is the retry).
//           |  The window itself is connected to Core the same way
//           |  `pnpm pair` connects a browser: pair_address() asks for
//           |  a one-time code with the install key (the file
//           |  local-api.key that Core keeps in this app's data
//           |  folder) and returns the address that spends it. Core
//           |  sets the window's session cookie and redirects to the
//           |  Cockpit, so the key never goes into an address, a log,
//           |  the window's scripts or a child process.
//  Note     |  The token and the key are never logged.
// ------------------------------------------------------------------

use crate::notify::Item;
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use tauri::Url;

/// The file in Core's data folder that holds the install key (packages/contracts/src/session.ts).
const LOCAL_KEY_FILE: &str = "local-api.key";

#[derive(Deserialize)]
struct PairCode {
    code: String,
}

/// The install key, if Core has made it: 32 bytes as 43 base64url characters.
fn read_key(data: &Path) -> Result<String, String> {
    let key = std::fs::read_to_string(data.join(LOCAL_KEY_FILE))
        .map_err(|_| "Core has not made its install key yet".to_string())?;
    let key = key.trim();
    if key.len() == 43
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Ok(key.to_string())
    } else {
        Err("the install key file is not a key".to_string())
    }
}

/// The address that connects this window to Core, then goes on to `next` (a path on Core's site).
/// The one-time code in it is good for 60 seconds, once. The key itself is not in it.
pub fn pair_address(data: &Path, port: u16, next: &str) -> Result<String, String> {
    let key = read_key(data)?;
    let base = format!("http://127.0.0.1:{port}");
    let body = ureq::post(&format!("{base}/api/v1/session/pair-codes"))
        .set("authorization", &format!("Bearer {key}"))
        .timeout(Duration::from_secs(4))
        .call()
        .map_err(|e| match e {
            // The status only: never the request, which carries the key.
            ureq::Error::Status(code, _) => format!("Core answered {code} to the pairing request"),
            _ => "Core did not answer the pairing request".to_string(),
        })?
        .into_string()
        .map_err(|e| e.to_string())?;
    let PairCode { code } = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut url = Url::parse(&format!("{base}/api/v1/session/pair")).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("code", &code);
        if next != "/" && next.starts_with('/') {
            q.append_pair("next", next);
        }
    }
    Ok(url.to_string())
}

#[derive(Clone, Debug, Deserialize)]
pub struct Command {
    pub command: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Poll {
    pub seq: u64,
    #[serde(default)]
    pub notifications: Vec<Item>,
    #[serde(default)]
    pub commands: Vec<Command>,
    #[serde(default)]
    pub close: String,
    #[serde(default)]
    pub approvals: u32,
    #[serde(default)]
    pub runs: u32,
    #[serde(default)]
    pub background: bool,
}

#[derive(Clone)]
pub struct Core {
    port: u16,
    token: String,
}

impl Core {
    pub fn new(port: u16, token: &str) -> Core {
        Core {
            port,
            token: token.to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}/internal/v1/desktop/{path}", self.port)
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// What is new since `after`: notifications and commands, and the counts.
    pub fn poll(&self, after: u64) -> Result<Poll, String> {
        self.poll_with(&format!("poll?after={after}"))
    }

    /// Only the counts (runs working, approvals waiting): the quit check.
    pub fn counts(&self) -> Result<Poll, String> {
        self.poll_with("poll?counts=1")
    }

    fn poll_with(&self, path: &str) -> Result<Poll, String> {
        let body = ureq::get(&self.url(path))
            .set("authorization", &self.auth())
            .timeout(Duration::from_secs(4))
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&body).map_err(|e| e.to_string())
    }

    fn send(&self, method: &str, path: &str, body: serde_json::Value) -> Result<String, String> {
        ureq::request(method, &self.url(path))
            .set("authorization", &self.auth())
            .set("content-type", "application/json")
            .timeout(Duration::from_secs(5))
            .send_string(&body.to_string())
            .map_err(|e| match e {
                // Core's own words for a refusal (title and hint), without the token.
                ureq::Error::Status(code, r) => {
                    let text = r.into_string().unwrap_or_default();
                    format!("{code}: {text}")
                }
                other => other.to_string(),
            })?
            .into_string()
            .map_err(|e| e.to_string())
    }

    /// The person's answer to "Keep running in the tray or Quit".
    pub fn put_close(&self, close: &str) -> Result<(), String> {
        self.send("PUT", "close", serde_json::json!({ "close": close }))
            .map(|_| ())
    }

    /// What the window is doing, and what is still warming up.
    pub fn window(&self, visible: bool, focused: bool, warming: &[String]) -> Result<(), String> {
        self.send(
            "POST",
            "window",
            serde_json::json!({ "visible": visible, "focused": focused, "warming": warming }),
        )
        .map(|_| ())
    }

    /// The app started on a version it was not before.
    #[cfg_attr(not(feature = "updater"), allow(dead_code))]
    pub fn updated(&self, from: &str, to: &str, notes: Option<&str>) -> Result<(), String> {
        self.send(
            "POST",
            "updated",
            serde_json::json!({ "from": from, "to": to, "notes": notes }),
        )
        .map(|_| ())
    }

    /// Approve or Deny pressed on a notification (Pro). Core decides whether that is allowed.
    pub fn approval_action(&self, approval_id: &str, approve: bool) -> Result<(), String> {
        self.send(
            "POST",
            "approval-action",
            serde_json::json!({
                "approval_id": approval_id,
                "action": if approve { "approve" } else { "deny" }
            }),
        )
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_poll_reads_what_core_sends_and_tolerates_what_it_adds() {
        let json = r#"{
            "seq": 7,
            "notifications": [
              {"seq":6,"id":"approval:apr_1","kind":"approval","title":"A request needs your go-ahead",
               "body":null,"href":"/open/approval/apr_1","approval_id":"apr_1",
               "actions":[{"id":"approve","label":"Approve"},{"id":"deny","label":"Deny"}],"extra":1}
            ],
            "commands": [{"seq":7,"command":"update.tonight"}],
            "close": "tray", "approvals": 1, "runs": 2, "background": true, "future_field": []
        }"#;
        let p: Poll = serde_json::from_str(json).unwrap();
        assert_eq!(p.seq, 7);
        assert_eq!(p.notifications[0].actions.len(), 2);
        assert_eq!(p.notifications[0].body, None);
        assert_eq!(p.commands[0].command, "update.tonight");
        assert_eq!(
            (p.close.as_str(), p.approvals, p.runs, p.background),
            ("tray", 1, 2, true)
        );
    }

    #[test]
    fn the_install_key_is_read_only_when_it_is_a_key() {
        let dir = std::env::temp_dir().join(format!("ancile-key-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_key(&dir).is_err(), "no file yet");
        std::fs::write(dir.join(LOCAL_KEY_FILE), "not a key\n").unwrap();
        assert!(read_key(&dir).is_err(), "wrong shape");
        let key = "A".repeat(43);
        std::fs::write(dir.join(LOCAL_KEY_FILE), format!("{key}\n")).unwrap();
        assert_eq!(read_key(&dir).unwrap(), key);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_refused_pairing_never_repeats_the_key() {
        let dir = std::env::temp_dir().join(format!("ancile-pair-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = "B".repeat(43);
        std::fs::write(dir.join(LOCAL_KEY_FILE), &key).unwrap();
        // Nothing listens on port 9: the error says Core did not answer, and carries no secret.
        let err = pair_address(&dir, 9, "/").unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        assert!(!err.contains(&key));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_old_core_with_less_to_say_still_parses() {
        let p: Poll = serde_json::from_str(r#"{"seq":0}"#).unwrap();
        assert!(p.notifications.is_empty() && p.commands.is_empty());
        assert_eq!(p.close, "");
    }
}
