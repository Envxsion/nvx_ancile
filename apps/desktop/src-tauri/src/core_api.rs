// ------------------------------------------------------------------
//  Title    |  Core's desktop API
//  Ref      |  packages/contracts/src/desktop.ts · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  The shell's short, plain-HTTP conversation with Core on
//           |  127.0.0.1: the regular poll, the window report, the
//           |  close choice, and the one button press on a
//           |  notification.
//  How      |  Every call carries the service token, which only this
//           |  host holds, and a short timeout: Core being slow or
//           |  not started yet is an answer ("not now"), never a
//           |  hang. Nothing here is a model call or leaves the
//           |  machine, so it does not go through the resilience
//           |  layer's retry (the next poll is the retry).
//  Note     |  The token is never logged.
// ------------------------------------------------------------------

use crate::notify::Item;
use serde::Deserialize;
use std::time::Duration;

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
    fn an_old_core_with_less_to_say_still_parses() {
        let p: Poll = serde_json::from_str(r#"{"seq":0}"#).unwrap();
        assert!(p.notifications.is_empty() && p.commands.is_empty());
        assert_eq!(p.close, "");
    }
}
