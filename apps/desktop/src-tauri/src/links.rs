// ------------------------------------------------------------------
//  Title    |  Links out of the window
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  Decide what a click on a link does in the Cockpit
//           |  window: stay (the Cockpit and the start-up screen),
//           |  open in the system browser (http, https, mailto), or
//           |  nothing at all (every other scheme).
//  How      |  main.rs calls decide() from the webview's navigation
//           |  and new-window handlers, and opens external links with
//           |  the opener plugin from Rust. The Cockpit never gets the
//           |  plugin's commands: capabilities/default.json is unchanged.
//  Note     |  Without a new-window handler WebView2 swallows every
//           |  target="_blank" click, which is why links did nothing.
// ------------------------------------------------------------------

use tauri::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Load it in this window: the Cockpit or the start-up screen.
    Stay,
    /// Hand it to the system browser or mail client.
    External,
    /// Do nothing.
    Refuse,
}

/// `core` is Core's origin, e.g. `http://127.0.0.1:8787`.
pub fn decide(url: &Url, core: &str) -> Action {
    match url.scheme() {
        // The bundled start-up screen (tauri://localhost on macOS and Linux,
        // http://tauri.localhost on Windows).
        "tauri" => Action::Stay,
        "about" if url.as_str() == "about:blank" => Action::Stay,
        "http" | "https" => {
            let origin = url.origin().ascii_serialization();
            if origin == core.trim_end_matches('/') || url.host_str() == Some("tauri.localhost") {
                Action::Stay
            } else {
                Action::External
            }
        }
        "mailto" => Action::External,
        _ => Action::Refuse,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CORE: &str = "http://127.0.0.1:8787";
    fn d(s: &str) -> Action {
        decide(&Url::parse(s).unwrap(), CORE)
    }

    #[test]
    fn the_cockpit_and_the_start_up_screen_stay() {
        assert_eq!(d("http://127.0.0.1:8787/notebooks/abc"), Action::Stay);
        assert_eq!(d("http://tauri.localhost/index.html"), Action::Stay);
        assert_eq!(d("tauri://localhost/index.html"), Action::Stay);
        assert_eq!(d("about:blank"), Action::Stay);
    }

    #[test]
    fn web_and_mail_links_open_outside() {
        assert_eq!(d("https://nvx.sh/docs"), Action::External);
        assert_eq!(d("http://example.com"), Action::External);
        assert_eq!(d("mailto:hello@nvx.sh"), Action::External);
        // Another port on this machine is not the Cockpit.
        assert_eq!(d("http://127.0.0.1:9999/"), Action::External);
    }

    #[test]
    fn other_schemes_do_nothing() {
        assert_eq!(d("file:///C:/Windows/System32/calc.exe"), Action::Refuse);
        assert_eq!(d("javascript:alert(1)"), Action::Refuse);
        assert_eq!(d("ms-settings:privacy"), Action::Refuse);
        assert_eq!(d("data:text/html,hi"), Action::Refuse);
    }
}
