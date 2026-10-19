// ------------------------------------------------------------------
//  Title    |  Closing and quitting
//  Ref      |  ROADMAP row DK1 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  What the close button does, what quitting checks first,
//           |  and the words for both, so a run in progress is never
//           |  lost without being asked about.
//  How      |  Pure decisions; shell.rs asks Core for the numbers and
//           |  shows the dialogs. Closing the window: the first time it
//           |  asks "Keep running in the tray" or "Quit" and
//           |  remembers; after that it does what was chosen
//           |  (Settings → Desktop changes it). Quitting from the tray,
//           |  Ctrl+Q or Cmd+Q looks at the runs working and the
//           |  approvals waiting: if there are any it asks "Stop and
//           |  quit" or "Wait".
//  Note     |  An operating system shutdown is never held up: no
//           |  question, no hiding. With no tray (some Linux desktops)
//           |  the close button quits, still after the check. Core
//           |  that cannot be reached (still starting) means there is
//           |  nothing to lose, so quitting does not ask.
// ------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Behaviour {
    Ask,
    Tray,
    Quit,
}

impl Behaviour {
    pub fn parse(s: &str) -> Behaviour {
        match s {
            "tray" => Behaviour::Tray,
            "quit" => Behaviour::Quit,
            _ => Behaviour::Ask,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Behaviour::Ask => "ask",
            Behaviour::Tray => "tray",
            Behaviour::Quit => "quit",
        }
    }
}

/// What the machine looks like right now.
#[derive(Clone, Copy, Debug)]
pub struct Env {
    /// The tray icon exists (not every Linux desktop has one).
    pub tray: bool,
    /// The operating system is shutting down or logging out.
    pub shutting_down: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnClose {
    /// Hide the window; everything keeps running.
    Hide,
    /// Leave now, with no question (the system is shutting down).
    QuitNow,
    /// Leave, after looking for runs and approvals.
    QuitChecked,
    /// Ask once: keep running in the tray, or quit.
    Ask,
}

pub fn on_close(b: Behaviour, env: Env) -> OnClose {
    if env.shutting_down {
        OnClose::QuitNow
    } else if !env.tray {
        OnClose::QuitChecked
    } else {
        match b {
            Behaviour::Ask => OnClose::Ask,
            Behaviour::Tray => OnClose::Hide,
            Behaviour::Quit => OnClose::QuitChecked,
        }
    }
}

/// What is going on that quitting would cut off.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Activity {
    pub runs: u32,
    pub approvals: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub title: &'static str,
    pub message: String,
    pub stop: &'static str,
    pub wait: &'static str,
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What is running and waiting, in a phrase ("2 runs in progress").
pub fn what(a: &Activity) -> Option<String> {
    match (a.runs, a.approvals) {
        (0, 0) => None,
        (r, 0) => Some(format!("{} in progress", plural(r, "run", "runs"))),
        (0, p) => Some(format!(
            "{} waiting for your answer",
            plural(p, "approval", "approvals")
        )),
        (r, p) => Some(format!(
            "{} in progress and {} waiting for your answer",
            plural(r, "run", "runs"),
            plural(p, "approval", "approvals")
        )),
    }
}

/// The question before quitting (or restarting to update), or None when nothing would be lost.
pub fn quit_prompt(a: &Activity, to_update: bool) -> Option<Prompt> {
    let what = what(a)?;
    Some(if to_update {
        Prompt {
            title: "Restart to update?",
            message: format!("{what}. Stop and restart now, or wait until they are done?"),
            stop: "Stop and restart",
            wait: "Wait",
        }
    } else {
        Prompt {
            title: "Quit NVX Ancile?",
            message: format!("{what}. Stop and quit, or wait until they are done?"),
            stop: "Stop and quit",
            wait: "Wait",
        }
    })
}

/// The one-time question on the first close.
pub struct FirstClose {
    pub title: &'static str,
    pub message: &'static str,
    pub tray: &'static str,
    pub quit: &'static str,
}

pub const FIRST_CLOSE: FirstClose = FirstClose {
    title: "Close NVX Ancile?",
    message: "NVX Ancile can keep running in the tray, so runs and schedules carry on, or quit and stop everything. You can change this later in Settings, under Desktop.",
    tray: "Keep running in the tray",
    quit: "Quit",
};

#[cfg(test)]
mod tests {
    use super::*;

    const TRAY: Env = Env {
        tray: true,
        shutting_down: false,
    };

    #[test]
    fn the_first_close_asks_and_after_that_it_does_what_was_chosen() {
        assert_eq!(on_close(Behaviour::Ask, TRAY), OnClose::Ask);
        assert_eq!(on_close(Behaviour::Tray, TRAY), OnClose::Hide);
        assert_eq!(on_close(Behaviour::Quit, TRAY), OnClose::QuitChecked);
    }

    #[test]
    fn a_shutdown_is_never_held_up() {
        let down = Env {
            tray: true,
            shutting_down: true,
        };
        for b in [Behaviour::Ask, Behaviour::Tray, Behaviour::Quit] {
            assert_eq!(on_close(b, down), OnClose::QuitNow, "{b:?}");
        }
    }

    #[test]
    fn with_no_tray_closing_quits_after_the_check() {
        let none = Env {
            tray: false,
            shutting_down: false,
        };
        for b in [Behaviour::Ask, Behaviour::Tray, Behaviour::Quit] {
            assert_eq!(on_close(b, none), OnClose::QuitChecked, "{b:?}");
        }
    }

    #[test]
    fn the_choice_is_read_and_written_as_core_keeps_it() {
        for b in [Behaviour::Ask, Behaviour::Tray, Behaviour::Quit] {
            assert_eq!(Behaviour::parse(b.as_str()), b);
        }
        assert_eq!(Behaviour::parse("something else"), Behaviour::Ask);
        assert_eq!(Behaviour::parse(""), Behaviour::Ask);
    }

    #[test]
    fn quitting_with_nothing_going_on_does_not_ask() {
        assert_eq!(quit_prompt(&Activity::default(), false), None);
        assert_eq!(quit_prompt(&Activity::default(), true), None);
    }

    #[test]
    fn the_question_counts_runs_and_approvals_in_plain_words() {
        let q = |r, p, u| {
            quit_prompt(
                &Activity {
                    runs: r,
                    approvals: p,
                },
                u,
            )
            .unwrap()
        };
        assert_eq!(
            q(2, 0, false).message,
            "2 runs in progress. Stop and quit, or wait until they are done?"
        );
        assert_eq!(
            q(1, 0, false).message,
            "1 run in progress. Stop and quit, or wait until they are done?"
        );
        assert_eq!(
            q(0, 3, false).message,
            "3 approvals waiting for your answer. Stop and quit, or wait until they are done?"
        );
        assert_eq!(
            q(1, 1, false).message,
            "1 run in progress and 1 approval waiting for your answer. Stop and quit, or wait until they are done?"
        );
        assert_eq!(
            (q(2, 0, false).stop, q(2, 0, false).wait),
            ("Stop and quit", "Wait")
        );
    }

    #[test]
    fn restarting_to_update_says_so() {
        let p = quit_prompt(
            &Activity {
                runs: 2,
                approvals: 0,
            },
            true,
        )
        .unwrap();
        assert_eq!(p.title, "Restart to update?");
        assert_eq!(p.stop, "Stop and restart");
        assert!(p.message.starts_with("2 runs in progress."));
    }

    #[test]
    fn the_words_follow_the_house_style() {
        // Sentence case, British spelling, no em dashes.
        for text in [
            FIRST_CLOSE.title,
            FIRST_CLOSE.message,
            FIRST_CLOSE.tray,
            FIRST_CLOSE.quit,
        ] {
            assert!(!text.contains('\u{2014}'), "{text}");
        }
        assert_eq!(FIRST_CLOSE.tray, "Keep running in the tray");
    }
}
