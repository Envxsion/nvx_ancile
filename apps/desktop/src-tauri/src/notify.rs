// ------------------------------------------------------------------
//  Title    |  Native notifications
//  Ref      |  ROADMAP row NT1 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  When NVX Ancile is not the window in front, a waiting
//           |  approval or a long run that finished reaches you: a
//           |  system notification, the taskbar button flashing (or
//           |  the dock badge), and the window title "(2) NVX Ancile".
//  How      |  Core decides what deserves one (the category is set to
//           |  Desktop in Settings, a private notebook gives no body)
//           |  and the shell polls for them (shell.rs); this module
//           |  keeps what has been shown so none repeats, groups a
//           |  burst into one, counts what is unseen, and draws the
//           |  notification. Windows toasts can be clicked (the
//           |  window opens on that approval or thread) and can carry
//           |  Approve and Deny when Core sent them (Pro, ordinary
//           |  requests only). Linux does the same where the daemon
//           |  offers actions (notify-rust). macOS, and a Linux daemon
//           |  that ignores actions, has no click we can hear, so
//           |  coming back to the window within half a minute opens
//           |  the same place.
//  Note     |  Focus Assist (Windows) and Focus (macOS) are the
//           |  system's: a notification it holds back is not shown
//           |  until it lets it through. A click only opens a place
//           |  or presses a button the person pressed; nothing here
//           |  answers by itself.
// ------------------------------------------------------------------

use serde::Deserialize;
use std::collections::VecDeque;

/// More than this many at once become one notification.
const GROUP_OVER: usize = 3;
const REMEMBER: usize = 500;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Action {
    pub id: String,
    pub label: String,
}

/// One notification as Core sent it (contracts/desktop.ts DesktopNotification).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: Option<String>,
    pub href: String,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

/// What is drawn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Toast {
    pub title: String,
    pub body: Option<String>,
    pub href: String,
    pub approval_id: Option<String>,
    pub actions: Vec<Action>,
}

#[derive(Default)]
pub struct Notifier {
    shown: VecDeque<String>,
    /// Finished runs and notices shown while the window was away, not yet seen.
    unseen: u32,
}

impl Notifier {
    /// The ones not shown before; all of them are remembered, whether or not they are drawn.
    pub fn fresh(&mut self, items: Vec<Item>) -> Vec<Item> {
        let mut out = Vec::new();
        for it in items {
            if self.shown.iter().any(|s| *s == it.id) || out.iter().any(|o: &Item| o.id == it.id) {
                continue;
            }
            self.shown.push_back(it.id.clone());
            if self.shown.len() > REMEMBER {
                self.shown.pop_front();
            }
            out.push(it);
        }
        out
    }

    /// What to draw now. `away`: the window is hidden, minimised or not in front.
    /// With the window in front nothing is drawn: it is already looking at it.
    pub fn plan(&mut self, items: Vec<Item>, away: bool) -> Vec<Toast> {
        if !away || items.is_empty() {
            return Vec::new();
        }
        self.unseen += items.iter().filter(|i| i.kind != "approval").count() as u32;
        if items.len() > GROUP_OVER {
            return vec![Toast {
                title: format!("{} things need you", items.len()),
                body: Some("Open NVX Ancile to see them.".into()),
                href: "/".into(),
                approval_id: None,
                actions: Vec::new(),
            }];
        }
        items
            .into_iter()
            .map(|i| Toast {
                title: i.title,
                body: i.body,
                href: i.href,
                approval_id: i.approval_id,
                actions: i.actions,
            })
            .collect()
    }

    /// The window came to the front: everything is seen.
    pub fn seen(&mut self) {
        self.unseen = 0;
    }

    /// How many things are waiting for a look: approvals still open, and what finished while away.
    pub fn count(&self, approvals: u32) -> u32 {
        approvals + self.unseen
    }
}

/// "(2) NVX Ancile" while something waits, "NVX Ancile" otherwise.
pub fn window_title(count: u32) -> String {
    if count == 0 {
        "NVX Ancile".into()
    } else {
        format!("({count}) NVX Ancile")
    }
}

/// A place inside the Cockpit and nothing else: it starts with one slash, names no
/// other site, and holds no control characters. Core sends these; a window opens on
/// them, so they are checked here as well.
pub fn safe_href(href: &str) -> bool {
    href.starts_with('/')
        && !href.starts_with("//")
        && !href.starts_with("/\\")
        && !href.contains("://")
        && !href.contains('\\')
        && href.len() <= 400
        && !href.chars().any(|c| c.is_control())
}

/// What a click on a notification means.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Click {
    /// The notification itself: open this place.
    Open(String),
    /// A button: Approve or Deny on this request.
    Button { approval_id: String, approve: bool },
}

/// Read the argument a Windows toast button sent back ("approve:apr_1"); anything else is a click on the toast.
pub fn click_of(arg: Option<&str>, href: &str) -> Click {
    if let Some(a) = arg {
        if let Some((verb, id)) = a.split_once(':') {
            if !id.is_empty() && id.len() <= 64 {
                match verb {
                    "approve" => {
                        return Click::Button {
                            approval_id: id.into(),
                            approve: true,
                        }
                    }
                    "deny" => {
                        return Click::Button {
                            approval_id: id.into(),
                            approve: false,
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Click::Open(href.into())
}

#[cfg(windows)]
pub fn show(app: &tauri::AppHandle, toast: &Toast, on_click: impl Fn(Click) + Send + 'static) {
    use tauri_winrt_notification::Toast as Win;
    // A development build has no installed shortcut of its own: borrow PowerShell's identity.
    let app_id = if cfg!(debug_assertions) {
        Win::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let mut t = Win::new(&app_id).title(&toast.title);
    if let Some(body) = &toast.body {
        t = t.text1(body);
    }
    if let Some(id) = &toast.approval_id {
        for a in &toast.actions {
            t = t.add_button(&a.label, &format!("{}:{}", a.id, id));
        }
    }
    let href = toast.href.clone();
    let t = t.on_activated(move |arg| {
        on_click(click_of(arg.as_deref(), &href));
        Ok(())
    });
    if let Err(e) = t.show() {
        log::warn!("could not show a notification: {e}");
    }
}

/// The buttons a toast carries, as (argument, label) pairs: "approve:apr_1" and "deny:apr_1".
/// None without an approval id, so a toast that is not a request never gets a button.
pub fn button_args(toast: &Toast) -> Vec<(String, String)> {
    match &toast.approval_id {
        Some(id) => toast
            .actions
            .iter()
            .map(|a| (format!("{}:{}", a.id, id), a.label.clone()))
            .collect(),
        None => Vec::new(),
    }
}

/// What came of a pressed button, from Core's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Core took the answer.
    Answered,
    /// The request was already answered in the app (or elsewhere): do nothing, and say so.
    AlreadyAnswered,
    /// Refused for any other reason (a critical request, no longer Pro): open it in the app.
    OpenInApp,
}

/// Read Core's reply to `approval_action` (Ok, or "409: {...desktop.already_answered...}").
pub fn outcome_of(result: &Result<(), String>) -> Outcome {
    match result {
        Ok(()) => Outcome::Answered,
        Err(e) if e.starts_with("409") || e.contains("desktop.already_answered") => {
            Outcome::AlreadyAnswered
        }
        Err(_) => Outcome::OpenInApp,
    }
}

/// A plain note with no buttons and no click: "That request was already answered".
pub fn note(app: &tauri::AppHandle, title: &str, body: &str) {
    let toast = Toast {
        title: title.into(),
        body: Some(body.into()),
        href: "/".into(),
        approval_id: None,
        actions: Vec::new(),
    };
    show(app, &toast, |_| {});
}

// Limits, plainly. Approve and Deny in the notification (Pro, ordinary requests only):
//   Windows  yes: toast buttons, heard through tauri-winrt-notification.
//   Linux    yes where the notification daemon offers actions (checked per run); a daemon that
//            ignores them still shows the notification, and coming back to the window within
//            half a minute opens the place. Uses notify-rust (MIT or Apache-2.0), the crate
//            the notification plugin already builds on.
//   macOS    no. The plugin's desktop backend (notify-rust, mac-notification-sys) draws no action
//            buttons and hears no click, and banners only show one button under the alert style.
//            Returning to the window opens the place, as before.
// TODO(phase-0.2.0): macOS buttons through UNUserNotificationCenter action categories
// (objc2-user-notifications), which needs a signed, notarised bundle to test honestly.
// See docs/desktop.md.
#[cfg(target_os = "linux")]
pub fn show(_app: &tauri::AppHandle, toast: &Toast, on_click: impl Fn(Click) + Send + 'static) {
    use notify_rust::Notification;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::OnceLock;

    /// Waiting threads alive at once; past this a toast is shown without waiting.
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static ACTIONS: OnceLock<bool> = OnceLock::new();
    let daemon_has_actions = *ACTIONS.get_or_init(|| {
        notify_rust::get_capabilities()
            .map(|c| c.iter().any(|x| x == "actions"))
            .unwrap_or(false)
    });

    let mut n = Notification::new();
    n.appname("NVX Ancile").summary(&toast.title);
    if let Some(body) = &toast.body {
        n.body(body);
    }
    if daemon_has_actions {
        // "default" is the body click on daemons that send it; the rest are the buttons.
        n.action("default", "Open");
        for (arg, label) in button_args(toast) {
            n.action(&arg, &label);
        }
    }
    let href = toast.href.clone();
    let wait = daemon_has_actions && LIVE.load(Ordering::SeqCst) < 16;
    if wait {
        LIVE.fetch_add(1, Ordering::SeqCst);
    }
    std::thread::spawn(move || {
        match n.show() {
            Ok(handle) if wait => {
                handle.wait_for_action(|action| {
                    if action != "__closed" {
                        on_click(click_of(Some(action), &href));
                    }
                });
            }
            Ok(_) => {}
            Err(e) => log::warn!("could not show a notification: {e}"),
        }
        if wait {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
    });
}

#[cfg(all(not(windows), not(target_os = "linux")))]
pub fn show(app: &tauri::AppHandle, toast: &Toast, _on_click: impl Fn(Click) + Send + 'static) {
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(&toast.title);
    if let Some(body) = &toast.body {
        n = n.body(body);
    }
    if let Err(e) = n.show() {
        log::warn!("could not show a notification: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: &str) -> Item {
        Item {
            id: id.into(),
            kind: kind.into(),
            title: format!("Title {id}"),
            body: Some("Body".into()),
            href: format!("/open/{id}"),
            approval_id: (kind == "approval").then(|| id.into()),
            actions: vec![],
        }
    }

    #[test]
    fn none_is_shown_twice() {
        let mut n = Notifier::default();
        assert_eq!(n.fresh(vec![item("a", "run"), item("b", "run")]).len(), 2);
        assert!(
            n.fresh(vec![item("a", "run")]).is_empty(),
            "a repeat from Core"
        );
        let again = n.fresh(vec![item("b", "run"), item("c", "run"), item("c", "run")]);
        assert_eq!(
            again.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["c"]
        );
    }

    #[test]
    fn the_memory_is_bounded_but_recent_ones_hold() {
        let mut n = Notifier::default();
        for i in 0..(REMEMBER + 50) {
            n.fresh(vec![item(&format!("x{i}"), "run")]);
        }
        assert!(n.shown.len() <= REMEMBER);
        assert!(n
            .fresh(vec![item(&format!("x{}", REMEMBER + 49), "run")])
            .is_empty());
    }

    #[test]
    fn with_the_window_in_front_nothing_is_drawn_but_it_is_not_repeated_later() {
        let mut n = Notifier::default();
        let fresh = n.fresh(vec![item("a", "approval")]);
        assert!(n.plan(fresh, false).is_empty());
        // The person leaves the window: the same id does not come back.
        assert!(n.fresh(vec![item("a", "approval")]).is_empty());
        assert_eq!(n.count(0), 0);
    }

    #[test]
    fn away_each_one_is_drawn_with_its_words_and_place() {
        let mut n = Notifier::default();
        let fresh = n.fresh(vec![item("a", "approval"), item("r", "run")]);
        let toasts = n.plan(fresh, true);
        assert_eq!(toasts.len(), 2);
        assert_eq!(toasts[0].title, "Title a");
        assert_eq!(toasts[0].href, "/open/a");
        assert_eq!(toasts[0].approval_id.as_deref(), Some("a"));
        assert_eq!(toasts[1].approval_id, None);
    }

    #[test]
    fn a_burst_becomes_one_notification() {
        let mut n = Notifier::default();
        let items: Vec<_> = (0..5).map(|i| item(&format!("a{i}"), "approval")).collect();
        let toasts = n.plan(items, true);
        assert_eq!(toasts.len(), 1);
        assert_eq!(toasts[0].title, "5 things need you");
        assert_eq!(toasts[0].href, "/");
        assert!(toasts[0].actions.is_empty() && toasts[0].approval_id.is_none());
        // Three is still three.
        let three: Vec<_> = (0..3).map(|i| item(&format!("b{i}"), "approval")).collect();
        assert_eq!(n.plan(three, true).len(), 3);
    }

    #[test]
    fn the_count_is_open_approvals_plus_what_finished_while_away() {
        let mut n = Notifier::default();
        let fresh = n.fresh(vec![
            item("r1", "run"),
            item("n1", "notice"),
            item("a1", "approval"),
        ]);
        n.plan(fresh, true);
        assert_eq!(n.count(1), 3);
        assert_eq!(n.count(0), 2, "the approval was answered elsewhere");
        n.seen();
        assert_eq!(n.count(1), 1, "looking at the window clears what finished");
    }

    #[test]
    fn the_title_carries_the_count() {
        assert_eq!(window_title(0), "NVX Ancile");
        assert_eq!(window_title(2), "(2) NVX Ancile");
    }

    #[test]
    fn a_body_click_opens_the_place_and_a_button_is_a_button() {
        assert_eq!(click_of(None, "/t/abc"), Click::Open("/t/abc".into()));
        assert_eq!(click_of(Some(""), "/t/abc"), Click::Open("/t/abc".into()));
        assert_eq!(
            click_of(Some("approve:apr_1"), "/x"),
            Click::Button {
                approval_id: "apr_1".into(),
                approve: true
            }
        );
        assert_eq!(
            click_of(Some("deny:apr_1"), "/x"),
            Click::Button {
                approval_id: "apr_1".into(),
                approve: false
            }
        );
    }

    #[test]
    fn an_argument_that_is_not_ours_only_opens_the_place() {
        for odd in ["delete:apr_1", "approve:", "approve", ":apr"] {
            assert_eq!(
                click_of(Some(odd), "/t/abc"),
                Click::Open("/t/abc".into()),
                "{odd}"
            );
        }
        let long = format!("approve:{}", "a".repeat(65));
        assert_eq!(
            click_of(Some(&long), "/t/abc"),
            Click::Open("/t/abc".into())
        );
    }

    #[test]
    fn only_a_place_in_the_cockpit_can_be_opened_from_a_notification() {
        for good in ["/", "/t/abc", "/open/approval/apr_1", "/n/x?y=1"] {
            assert!(safe_href(good), "{good}");
        }
        for bad in [
            "",
            "t/abc",
            "//evil.example/x",
            "https://evil.example",
            "/redirect?to=https://evil.example",
            "/\\evil",
            "/a\nb",
            "javascript:alert(1)",
        ] {
            assert!(!safe_href(bad), "{bad:?}");
        }
        assert!(!safe_href(&format!("/{}", "a".repeat(400))));
    }

    #[test]
    fn buttons_only_on_a_request() {
        let with = Toast {
            title: "t".into(),
            body: None,
            href: "/".into(),
            approval_id: Some("apr_1".into()),
            actions: vec![
                Action {
                    id: "approve".into(),
                    label: "Approve".into(),
                },
                Action {
                    id: "deny".into(),
                    label: "Deny".into(),
                },
            ],
        };
        let args = button_args(&with);
        assert_eq!(
            args[0],
            ("approve:apr_1".to_string(), "Approve".to_string())
        );
        assert_eq!(args[1].0, "deny:apr_1");
        let without = Toast {
            approval_id: None,
            ..with
        };
        assert!(button_args(&without).is_empty());
    }

    #[test]
    fn a_pressed_button_is_read_back_from_core() {
        assert_eq!(outcome_of(&Ok(())), Outcome::Answered);
        assert_eq!(
            outcome_of(&Err("409: {\"code\":\"desktop.already_answered\"}".into())),
            Outcome::AlreadyAnswered
        );
        assert_eq!(
            outcome_of(&Err("403: {\"code\":\"desktop.critical_in_app\"}".into())),
            Outcome::OpenInApp
        );
        assert_eq!(
            outcome_of(&Err("connection refused".into())),
            Outcome::OpenInApp
        );
    }
}
