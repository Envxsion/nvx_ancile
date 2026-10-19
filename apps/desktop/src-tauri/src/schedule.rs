// ------------------------------------------------------------------
//  Title    |  Update scheduling
//  Ref      |  ROADMAP row UP1 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  When a downloaded update installs: now, when the
//           |  person quits, or tonight. Never in the middle of a
//           |  run or over a question that is waiting.
//  How      |  Pure functions; updates.rs keeps the choice and asks
//           |  `next` on a timer. "Tonight" is the next 03:00 on this
//           |  computer's clock. Restart now and Tonight wait for the
//           |  runs and approvals in `closing::Activity` to be done
//           |  (or the person to stop them); When I quit installs as
//           |  the app exits, after the quit check has been answered.
//  Note     |  Nothing downloads on its own, so a metered connection
//           |  is always asked first: the update card shows the size
//           |  and the person presses the button.
// ------------------------------------------------------------------

use crate::closing::Activity;
use std::time::Duration;

/// The hour "Tonight" means, local time.
pub const TONIGHT_HOUR: i64 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    /// Nothing chosen yet.
    Unset,
    /// Install as the app quits.
    OnQuit,
    /// Install at the next 03:00, once nothing is running.
    Tonight,
}

impl When {
    pub fn as_str(self) -> &'static str {
        match self {
            When::Unset => "none",
            When::OnQuit => "quit",
            When::Tonight => "tonight",
        }
    }
}

/// Seconds since the Unix epoch of the next 03:00 local time after `now`.
/// `utc_offset` is the local zone's offset in seconds (east is positive).
pub fn tonight_after(now: i64, utc_offset: i32) -> i64 {
    let off = utc_offset as i64;
    let local = now + off;
    let day = local.div_euclid(86_400);
    let mut target = day * 86_400 + TONIGHT_HOUR * 3600;
    if target <= local {
        target += 86_400;
    }
    target - off
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// Not yet.
    Wait,
    /// The time has come but something is running: look again soon.
    WaitForLive,
    /// Install and restart now.
    Install,
}

pub fn next(when: When, scheduled_at: Option<i64>, now: i64, live: &Activity) -> Next {
    match when {
        When::Unset | When::OnQuit => Next::Wait,
        When::Tonight => match scheduled_at {
            Some(at) if now >= at => {
                if live.runs > 0 || live.approvals > 0 {
                    Next::WaitForLive
                } else {
                    Next::Install
                }
            }
            _ => Next::Wait,
        },
    }
}

/// "Restart now" with something running: install only when nothing is.
pub fn idle(live: &Activity) -> bool {
    live.runs == 0 && live.approvals == 0
}

/// How long to wait before trying a download again, or None to stop and say so.
pub fn retry_delay(attempt: u32) -> Option<Duration> {
    match attempt {
        0 => Some(Duration::from_secs(2)),
        1 => Some(Duration::from_secs(5)),
        2 => Some(Duration::from_secs(15)),
        _ => None,
    }
}

/// An ISO 8601 UTC time (`2026-10-20T03:00:00Z`) from Unix seconds, for the card.
pub fn iso_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// This computer's offset from UTC now, in seconds (0 when it cannot be read).
pub fn local_offset_secs() -> i32 {
    time::UtcOffset::current_local_offset()
        .map(|o| o.whole_seconds())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-19T12:00:00Z
    const NOON: i64 = 1_792_411_200;

    #[test]
    fn iso_times_are_right() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(NOON), "2026-10-19T12:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(-1), "1969-12-31T23:59:59Z");
    }

    #[test]
    fn tonight_is_the_next_three_in_the_morning_on_this_clock() {
        // Noon UTC with a UTC clock: tomorrow 03:00.
        assert_eq!(iso_utc(tonight_after(NOON, 0)), "2026-10-20T03:00:00Z");
        // 01:00 UTC: the same night.
        let one_am = NOON - 11 * 3600;
        assert_eq!(iso_utc(tonight_after(one_am, 0)), "2026-10-19T03:00:00Z");
        // Exactly 03:00 asks for the next one.
        let three = NOON - 9 * 3600;
        assert_eq!(iso_utc(tonight_after(three, 0)), "2026-10-20T03:00:00Z");
    }

    #[test]
    fn tonight_follows_the_local_zone() {
        // Melbourne in October is UTC+11. 12:00 UTC is 23:00 there, so 03:00 local is 16:00 UTC.
        assert_eq!(
            iso_utc(tonight_after(NOON, 11 * 3600)),
            "2026-10-19T16:00:00Z"
        );
        // New York at UTC-4: 12:00 UTC is 08:00 local, so the next 03:00 is 07:00 UTC tomorrow.
        assert_eq!(
            iso_utc(tonight_after(NOON, -4 * 3600)),
            "2026-10-20T07:00:00Z"
        );
        // Always in the future, and under a day and a bit away.
        for off in [-12 * 3600, -3600, 0, 5 * 1800, 14 * 3600] {
            let t = tonight_after(NOON, off);
            assert!(t > NOON && t - NOON <= 86_400, "{off}");
        }
    }

    #[test]
    fn nothing_installs_before_its_time_or_while_something_runs() {
        let quiet = Activity::default();
        let busy = Activity {
            runs: 1,
            approvals: 0,
        };
        let waiting = Activity {
            runs: 0,
            approvals: 2,
        };
        let at = Some(1000);
        assert_eq!(next(When::Tonight, at, 999, &quiet), Next::Wait);
        assert_eq!(next(When::Tonight, at, 1000, &quiet), Next::Install);
        assert_eq!(next(When::Tonight, at, 5000, &busy), Next::WaitForLive);
        assert_eq!(next(When::Tonight, at, 5000, &waiting), Next::WaitForLive);
        assert_eq!(next(When::Tonight, None, 5000, &quiet), Next::Wait);
    }

    #[test]
    fn when_i_quit_and_unset_never_install_on_a_timer() {
        let quiet = Activity::default();
        assert_eq!(next(When::OnQuit, Some(0), 99, &quiet), Next::Wait);
        assert_eq!(next(When::Unset, Some(0), 99, &quiet), Next::Wait);
    }

    #[test]
    fn restart_now_waits_for_an_idle_moment() {
        assert!(idle(&Activity::default()));
        assert!(!idle(&Activity {
            runs: 1,
            approvals: 0
        }));
        assert!(!idle(&Activity {
            runs: 0,
            approvals: 1
        }));
    }

    #[test]
    fn an_interrupted_download_is_tried_again_a_few_times_then_reported() {
        assert_eq!(retry_delay(0), Some(Duration::from_secs(2)));
        assert_eq!(retry_delay(2), Some(Duration::from_secs(15)));
        assert_eq!(retry_delay(3), None);
    }

    #[test]
    fn choices_are_named_as_core_keeps_them() {
        assert_eq!(When::Unset.as_str(), "none");
        assert_eq!(When::OnQuit.as_str(), "quit");
        assert_eq!(When::Tonight.as_str(), "tonight");
    }
}
