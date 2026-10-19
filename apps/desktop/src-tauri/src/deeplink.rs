// ------------------------------------------------------------------
//  Title    |  Deep links
//  Ref      |  ROADMAP row DL1 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  Turn an ancile:// link into a place in the Cockpit,
//           |  and refuse anything that is not one.
//  How      |  ancile://thread/<id>, notebook/<id>, new?text=…&notebook=<id>,
//           |  approval/<id>, settings[/<group>], help[/<topic>],
//           |  activate?key=NVX-… and flow/<id>/run. `parse` reads the
//           |  link, `route` gives the path the window opens, on Core's
//           |  own address. A link also arrives with a second launch.
//  Note     |  A link only OPENS something. It never sends a message,
//           |  answers an approval, runs a flow or spends: the Cockpit
//           |  shows the place (a draft in the box, the approval's
//           |  dialog, a "Run this flow?" confirm) and a person clicks.
//           |  An id that is not a plain identifier, or text that is
//           |  too long, is refused here so it never reaches a path.
// ------------------------------------------------------------------

use tauri::Url;

const MAX_TEXT: usize = 4000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    Activate {
        key: String,
    },
    Thread {
        id: String,
    },
    Notebook {
        id: String,
    },
    New {
        text: Option<String>,
        notebook: Option<String>,
    },
    Approval {
        id: String,
    },
    Settings {
        group: Option<String>,
    },
    Help {
        topic: Option<String>,
    },
    /// Pro: opens a "Run this flow?" confirm. Never runs by itself.
    FlowRun {
        id: String,
    },
    Flow {
        id: String,
    },
    /// Any other ancile:// link: bring the window forward.
    Home,
}

/// A plain identifier (a ULID, a UUID, a prefixed id): letters, digits, `_` and `-`.
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A slug for a settings group or a help topic.
fn valid_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 48 && s.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

fn clean_text(s: &str) -> Option<String> {
    let t: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(MAX_TEXT)
        .collect();
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// None: not an ancile link, or one with an id or key that is not valid.
pub fn parse(url: &Url) -> Option<Link> {
    if url.scheme() != "ancile" {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(h) = url.host_str() {
        if !h.is_empty() {
            parts.push(h.to_ascii_lowercase());
        }
    }
    // One leading and one trailing slash are fine; an empty segment inside is not ("flow//run").
    let path = url.path();
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_suffix('/').unwrap_or(path);
    if !path.is_empty() {
        let segments: Vec<&str> = path.split('/').collect();
        if segments.iter().any(|s| s.is_empty()) {
            return None;
        }
        parts.extend(segments.into_iter().map(str::to_string));
    }
    let query = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    let what = parts.first().map(|s| s.to_ascii_lowercase());
    let second = parts.get(1).map(String::as_str);
    let third = parts.get(2).map(|s| s.to_ascii_lowercase());
    match what.as_deref() {
        Some("activate") => {
            let key = query("key")?.to_uppercase();
            let valid = key.len() == 18
                && key.starts_with("NVX-")
                && key[4..]
                    .split('-')
                    .all(|p| p.len() == 4 && p.chars().all(|c| c.is_ascii_alphanumeric()));
            valid.then_some(Link::Activate { key })
        }
        Some("thread") => valid_id(second?).then(|| Link::Thread {
            id: second.unwrap().into(),
        }),
        Some("notebook") => valid_id(second?).then(|| Link::Notebook {
            id: second.unwrap().into(),
        }),
        Some("approval") => valid_id(second?).then(|| Link::Approval {
            id: second.unwrap().into(),
        }),
        Some("new") => {
            let notebook = match query("notebook") {
                Some(n) if valid_id(&n) => Some(n),
                Some(_) => return None,
                None => None,
            };
            Some(Link::New {
                text: query("text").as_deref().and_then(clean_text),
                notebook,
            })
        }
        Some("settings") => match second {
            None => Some(Link::Settings { group: None }),
            Some(g) if valid_slug(g) => Some(Link::Settings {
                group: Some(g.into()),
            }),
            Some(_) => None,
        },
        Some("help") => match second {
            None => Some(Link::Help { topic: None }),
            Some(t) if valid_slug(t) => Some(Link::Help {
                topic: Some(t.into()),
            }),
            Some(_) => None,
        },
        Some("flow") => {
            let id = second.filter(|s| valid_id(s))?.to_string();
            match third.as_deref() {
                Some("run") if parts.len() == 3 => Some(Link::FlowRun { id }),
                None => Some(Link::Flow { id }),
                _ => None,
            }
        }
        _ => Some(Link::Home),
    }
}

/// The path to open in the Cockpit (always starting with `/`).
pub fn route(link: &Link) -> String {
    let enc = |s: &str| {
        let mut u = Url::parse("http://x/").expect("static url");
        u.query_pairs_mut().append_pair("v", s);
        u.query()
            .unwrap_or("v=")
            .trim_start_matches("v=")
            .to_string()
    };
    match link {
        Link::Activate { key } => format!("/admin/license?key={key}"),
        Link::Thread { id } => format!("/t/{id}"),
        Link::Notebook { id } => format!("/n/{id}"),
        Link::Approval { id } => format!("/open/approval/{id}"),
        Link::New { text, notebook } => match (text, notebook) {
            (None, None) => "/".into(),
            (None, Some(n)) => format!("/?notebook={n}"),
            (Some(t), None) => format!("/open/new?text={}", enc(t)),
            (Some(t), Some(n)) => format!("/open/new?text={}&notebook={n}", enc(t)),
        },
        Link::Settings { group: None } => "/settings".into(),
        Link::Settings { group: Some(g) } => format!("/settings/{g}"),
        Link::Help { topic: None } => "/open/help".into(),
        Link::Help { topic: Some(t) } => format!("/open/help?topic={t}"),
        Link::FlowRun { id } => format!("/open/flow/{id}/run"),
        Link::Flow { id } => format!("/flows/{id}"),
        Link::Home => "/".into(),
    }
}

/// The route for a link, or None when it is not one of ours or is not valid.
pub fn route_for(url: &Url) -> Option<String> {
    parse(url).map(|l| route(&l))
}

/// The ancile links in a command line (a second launch passes the link as an argument).
pub fn links_in_args(args: &[String]) -> Vec<Url> {
    args.iter()
        .filter(|a| a.len() <= 8192 && a.to_ascii_lowercase().starts_with("ancile:"))
        .filter_map(|a| Url::parse(a).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> Option<String> {
        route_for(&Url::parse(s).unwrap())
    }

    #[test]
    fn a_thread_a_notebook_and_an_approval_open_where_they_live() {
        assert_eq!(
            r("ancile://thread/01HZX3K9").as_deref(),
            Some("/t/01HZX3K9")
        );
        assert_eq!(
            r("ancile://notebook/nb_abc-1").as_deref(),
            Some("/n/nb_abc-1")
        );
        assert_eq!(
            r("ancile://approval/apr_01HZX").as_deref(),
            Some("/open/approval/apr_01HZX")
        );
        assert_eq!(r("ANCILE://Thread/abc123").as_deref(), Some("/t/abc123"));
    }

    #[test]
    fn a_new_message_is_a_draft_in_the_box_never_sent() {
        assert_eq!(
            r("ancile://new?text=Summarise%20my%20notes&notebook=nb_1").as_deref(),
            Some("/open/new?text=Summarise+my+notes&notebook=nb_1")
        );
        assert_eq!(
            r("ancile://new?notebook=nb_1").as_deref(),
            Some("/?notebook=nb_1")
        );
        assert_eq!(r("ancile://new").as_deref(), Some("/"));
        assert_eq!(
            r("ancile://new?text=a%26b%3Dc%23d").as_deref(),
            Some("/open/new?text=a%26b%3Dc%23d")
        );
    }

    #[test]
    fn new_text_is_cleaned_and_capped() {
        let long = "x".repeat(10_000);
        let Some(Link::New { text: Some(t), .. }) =
            parse(&Url::parse(&format!("ancile://new?text={long}")).unwrap())
        else {
            panic!("a new link");
        };
        assert_eq!(t.len(), MAX_TEXT);
        // Control characters are dropped; an empty text is no text.
        assert_eq!(
            parse(&Url::parse("ancile://new?text=%07%00%1b").unwrap()),
            Some(Link::New {
                text: None,
                notebook: None
            })
        );
    }

    #[test]
    fn settings_and_help_open_a_group_or_a_topic() {
        assert_eq!(r("ancile://settings").as_deref(), Some("/settings"));
        assert_eq!(
            r("ancile://settings/notifications").as_deref(),
            Some("/settings/notifications")
        );
        assert_eq!(r("ancile://help").as_deref(), Some("/open/help"));
        assert_eq!(
            r("ancile://help/permissions").as_deref(),
            Some("/open/help?topic=permissions")
        );
        assert_eq!(r("ancile://settings/..%2Fadmin"), None);
        assert_eq!(r("ancile://help/UPPER"), None);
    }

    #[test]
    fn the_licence_link_fills_the_key_and_nothing_else() {
        assert_eq!(
            r("ancile://activate?key=nvx-ab12-cd34-ef56").as_deref(),
            Some("/admin/license?key=NVX-AB12-CD34-EF56")
        );
        assert_eq!(r("ancile://activate?key=NVX-AB12-CD34-EF56%26x%3D1"), None);
        assert_eq!(r("ancile://activate"), None);
        assert_eq!(
            r("https://example.com/activate?key=NVX-AB12-CD34-EF56"),
            None
        );
    }

    #[test]
    fn a_flow_link_opens_a_confirm_it_does_not_run() {
        assert_eq!(
            r("ancile://flow/flw_01HZ/run").as_deref(),
            Some("/open/flow/flw_01HZ/run")
        );
        assert_eq!(
            r("ancile://flow/flw_01HZ").as_deref(),
            Some("/flows/flw_01HZ")
        );
        assert_eq!(r("ancile://flow/flw_01HZ/delete"), None);
        assert_eq!(r("ancile://flow/flw_01HZ/run/now"), None);
        assert_eq!(r("ancile://flow//run"), None);
    }

    #[test]
    fn ids_that_could_escape_a_path_are_refused() {
        for bad in [
            "ancile://thread/..%2F..%2Fadmin",
            "ancile://thread/a%2Fb",
            "ancile://thread/a%20b",
            "ancile://thread/a?x=1",
            "ancile://thread/%3Cscript%3E",
            "ancile://notebook/",
            "ancile://thread",
            "ancile://approval/id;drop",
            "ancile://new?notebook=a%2Fb",
        ] {
            let got = r(bad);
            // A query on an otherwise valid id is simply ignored; everything else is refused.
            if bad == "ancile://thread/a?x=1" {
                assert_eq!(got.as_deref(), Some("/t/a"));
            } else {
                assert_eq!(got, None, "{bad}");
            }
        }
        assert!(!valid_id(&"a".repeat(65)));
        assert!(valid_id(&"a".repeat(64)));
    }

    #[test]
    fn an_unknown_ancile_link_only_brings_the_window_forward() {
        assert_eq!(r("ancile://nothing-we-know").as_deref(), Some("/"));
        assert_eq!(r("ancile://").as_deref(), Some("/"));
    }

    #[test]
    fn other_schemes_are_not_ours() {
        assert_eq!(r("https://example.com/thread/abc"), None);
        assert_eq!(r("file:///C:/Windows/System32/calc.exe"), None);
        assert_eq!(r("javascript:alert(1)"), None);
    }

    #[test]
    fn a_link_never_sends_approves_runs_or_spends() {
        // Every route is a place to look at. None carries an instruction, and none leaves the app.
        let links = [
            "ancile://thread/abc",
            "ancile://notebook/abc",
            "ancile://approval/abc",
            "ancile://new?text=send%20this%20now&notebook=abc",
            "ancile://settings/permissions",
            "ancile://help/permissions",
            "ancile://flow/abc/run",
            "ancile://activate?key=NVX-AB12-CD34-EF56",
            "ancile://approval/abc?decision=approve&scope=always&send=1&run=1&confirm=1",
        ];
        for l in links {
            let route = r(l).unwrap_or_else(|| panic!("{l}"));
            assert!(route.starts_with('/'), "{route}");
            assert!(!route.contains("://"), "{route}");
            for word in [
                "approve", "decision", "send=", "run=", "confirm", "auto", "submit",
            ] {
                assert!(!route.contains(word), "{l} -> {route} contains {word}");
            }
        }
        // The approval route is the dialog, whatever else the link says.
        assert_eq!(
            r("ancile://approval/abc?decision=approve&scope=always").as_deref(),
            Some("/open/approval/abc")
        );
    }

    #[test]
    fn a_second_launch_passes_the_link_as_an_argument() {
        let args: Vec<String> = [
            "C:\\Program Files\\NVX Ancile\\ancile.exe",
            "ancile://thread/abc",
            "--flag",
            "https://example.com",
            "ANCILE://settings",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let got: Vec<_> = links_in_args(&args).iter().filter_map(route_for).collect();
        assert_eq!(got, vec!["/t/abc".to_string(), "/settings".to_string()]);
    }
}
