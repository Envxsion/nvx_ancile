// ------------------------------------------------------------------
//  Title    |  Window state
//  Ref      |  ROADMAP row DK2 · docs/desktop.md
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  The window opens where it was left: same size, same
//           |  place, same monitor, maximised or full screen as it was,
//           |  and never off the screen or too small to use.
//  How      |  The bounds are saved to window-state.json in the data
//           |  folder (so they belong to this device, not the account)
//           |  a moment after each move or resize, and on close. At
//           |  start `plan` turns the saved bounds and the monitors
//           |  connected now into where to open, before the window is
//           |  shown, so nothing jumps. The size is kept in logical
//           |  pixels, so a different scale (DPI) keeps the same
//           |  apparent size; the position is in physical pixels, to
//           |  find the monitor it was on.
//  Note     |  A monitor that is gone puts the window in the middle of
//           |  the main one. A size below the minimum, a file that is
//           |  not JSON, or numbers that make no sense, fall back to
//           |  the default size in the middle. While the window is
//           |  maximised, full screen or minimised the normal bounds
//           |  are kept, so un-maximising returns to them.
// ------------------------------------------------------------------

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_SIZE: (f64, f64) = (1280.0, 820.0);
pub const MIN_SIZE: (f64, f64) = (900.0, 600.0);
/// Windows parks a minimised window far off screen; never save that.
const MINIMISED_AT: i32 = -30_000;

/// What is kept: the normal (not maximised) bounds and how the window was.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    /// Outer position, physical pixels.
    pub x: i32,
    pub y: i32,
    /// Inner size, logical pixels.
    pub width: f64,
    pub height: f64,
    /// The monitor's scale when it was saved.
    pub scale: f64,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// A connected monitor, physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Monitor {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

impl Monitor {
    fn logical(&self) -> (f64, f64) {
        (
            self.width as f64 / self.scale,
            self.height as f64 / self.scale,
        )
    }
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x as f64
            && px < self.x as f64 + self.width as f64
            && py >= self.y as f64
            && py < self.y as f64 + self.height as f64
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Spot {
    /// The middle of the main monitor.
    Centre,
    /// The outer top-left corner, physical pixels.
    At { x: i32, y: i32 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plan {
    /// Inner size, logical pixels.
    pub width: f64,
    pub height: f64,
    pub spot: Spot,
    pub maximized: bool,
    pub fullscreen: bool,
}

impl Saved {
    /// Numbers a window could really have had.
    pub fn is_sane(&self) -> bool {
        let ok = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
        ok(self.width, 100.0, 20_000.0)
            && ok(self.height, 100.0, 20_000.0)
            && ok(self.scale, 0.25, 10.0)
            && self.x.abs() < 100_000
            && self.y.abs() < 100_000
    }
}

fn default_plan(primary: Option<&Monitor>) -> Plan {
    let (mut w, mut h) = DEFAULT_SIZE;
    if let Some(m) = primary {
        let (mw, mh) = m.logical();
        // A small screen: leave room for the taskbar and the title bar.
        w = w.min((mw - 40.0).max(MIN_SIZE.0.min(mw)));
        h = h.min((mh - 80.0).max(MIN_SIZE.1.min(mh)));
    }
    Plan {
        width: w,
        height: h,
        spot: Spot::Centre,
        maximized: false,
        fullscreen: false,
    }
}

/// Where to open: the saved bounds, fitted to the monitors connected now.
pub fn plan(saved: Option<&Saved>, monitors: &[Monitor], primary: usize) -> Plan {
    let main = monitors.get(primary).or_else(|| monitors.first());
    let Some(s) = saved.filter(|s| s.is_sane()) else {
        return default_plan(main);
    };
    let Some(main) = main else {
        // No monitor information: keep the size, let the system place it.
        return Plan {
            width: s.width.max(MIN_SIZE.0),
            height: s.height.max(MIN_SIZE.1),
            spot: Spot::Centre,
            maximized: s.maximized,
            fullscreen: s.fullscreen,
        };
    };
    // Which monitor was it on? The one holding the middle of the window.
    let cx = s.x as f64 + s.width * s.scale / 2.0;
    let cy = s.y as f64 + s.height * s.scale / 2.0;
    let found = monitors.iter().find(|m| m.contains(cx, cy));
    let m = found.unwrap_or(main);
    let (mw, mh) = m.logical();
    // Not below the minimum, and not larger than the monitor it is going to.
    let w = s.width.max(MIN_SIZE.0).min(mw);
    let h = s.height.max(MIN_SIZE.1).min(mh);
    let spot = if found.is_none() {
        Spot::Centre
    } else {
        let pw = (w * m.scale).round() as i64;
        let ph = (h * m.scale).round() as i64;
        let max_x = (m.x as i64 + m.width as i64 - pw).max(m.x as i64);
        let max_y = (m.y as i64 + m.height as i64 - ph).max(m.y as i64);
        Spot::At {
            x: (s.x as i64).clamp(m.x as i64, max_x) as i32,
            y: (s.y as i64).clamp(m.y as i64, max_y) as i32,
        }
    };
    Plan {
        width: w,
        height: h,
        spot,
        maximized: s.maximized,
        fullscreen: s.fullscreen,
    }
}

/// What the window looks like right now.
#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub x: i32,
    pub y: i32,
    /// Inner size, physical pixels.
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub maximized: bool,
    pub fullscreen: bool,
    pub minimized: bool,
}

/// Fold the window as it is into what was saved. While it is maximised, full
/// screen or minimised the normal bounds stay as they were.
pub fn merge(prev: Option<&Saved>, now: &Snapshot) -> Option<Saved> {
    let offscreen = now.x <= MINIMISED_AT || now.y <= MINIMISED_AT;
    let moving = !now.maximized && !now.fullscreen && !now.minimized && !offscreen;
    if moving && now.scale > 0.0 && now.width > 0 && now.height > 0 {
        return Some(Saved {
            x: now.x,
            y: now.y,
            width: now.width as f64 / now.scale,
            height: now.height as f64 / now.scale,
            scale: now.scale,
            maximized: false,
            fullscreen: false,
        });
    }
    if now.minimized || offscreen {
        return prev.cloned();
    }
    // Maximised or full screen: keep the normal bounds; with none yet, a sensible size.
    let base = prev.cloned().unwrap_or(Saved {
        x: 0,
        y: 0,
        width: DEFAULT_SIZE.0,
        height: DEFAULT_SIZE.1,
        scale: now.scale.max(1.0),
        maximized: false,
        fullscreen: false,
    });
    Some(Saved {
        maximized: now.maximized,
        fullscreen: now.fullscreen,
        ..base
    })
}

/// The saved bounds, or None for no file, a file that is not JSON, or numbers that make no sense.
pub fn load(path: &Path) -> Option<Saved> {
    let text = std::fs::read_to_string(path).ok()?;
    let saved: Saved = serde_json::from_str(&text).ok()?;
    saved.is_sane().then_some(saved)
}

/// Write it whole to a temporary file and rename, so a crash never leaves half a file.
pub fn save(path: &Path, saved: &Saved) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(saved).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, y: i32, w: u32, h: u32, scale: f64) -> Monitor {
        Monitor {
            x,
            y,
            width: w,
            height: h,
            scale,
        }
    }
    fn saved(x: i32, y: i32, w: f64, h: f64, scale: f64) -> Saved {
        Saved {
            x,
            y,
            width: w,
            height: h,
            scale,
            maximized: false,
            fullscreen: false,
        }
    }
    const HD: (u32, u32) = (1920, 1080);

    #[test]
    fn with_nothing_saved_it_opens_at_the_default_size_in_the_middle() {
        let p = plan(None, &[mon(0, 0, HD.0, HD.1, 1.0)], 0);
        assert_eq!((p.width, p.height), DEFAULT_SIZE);
        assert_eq!(p.spot, Spot::Centre);
        assert!(!p.maximized && !p.fullscreen);
    }

    #[test]
    fn it_returns_to_the_same_size_and_place() {
        let s = saved(300, 120, 1100.0, 700.0, 1.0);
        let p = plan(Some(&s), &[mon(0, 0, HD.0, HD.1, 1.0)], 0);
        assert_eq!((p.width, p.height), (1100.0, 700.0));
        assert_eq!(p.spot, Spot::At { x: 300, y: 120 });
    }

    #[test]
    fn it_returns_to_the_second_monitor_when_it_is_still_there() {
        let monitors = [mon(0, 0, 1920, 1080, 1.0), mon(1920, 0, 2560, 1440, 1.0)];
        let s = saved(2200, 200, 1280.0, 820.0, 1.0);
        assert_eq!(
            plan(Some(&s), &monitors, 0).spot,
            Spot::At { x: 2200, y: 200 }
        );
    }

    #[test]
    fn a_monitor_that_was_unplugged_brings_it_back_to_the_main_one() {
        let s = saved(2200, 200, 1280.0, 820.0, 1.0);
        let p = plan(Some(&s), &[mon(0, 0, 1920, 1080, 1.0)], 0);
        assert_eq!(p.spot, Spot::Centre);
        assert_eq!((p.width, p.height), (1280.0, 820.0));
    }

    #[test]
    fn a_monitor_to_the_left_with_negative_coordinates_is_found() {
        let monitors = [mon(0, 0, 1920, 1080, 1.0), mon(-1920, 0, 1920, 1080, 1.0)];
        let s = saved(-1500, 100, 1000.0, 700.0, 1.0);
        assert_eq!(
            plan(Some(&s), &monitors, 0).spot,
            Spot::At { x: -1500, y: 100 }
        );
    }

    #[test]
    fn a_lower_resolution_shrinks_and_moves_it_back_on_screen() {
        // It was 1600 wide at the right edge of a big screen; the screen is now 1366 by 768.
        let s = saved(1300, 400, 1600.0, 900.0, 1.0);
        let p = plan(Some(&s), &[mon(0, 0, 1366, 768, 1.0)], 0);
        // The middle of the old window (2100, 850) is off this screen: back to the middle.
        assert_eq!(p.spot, Spot::Centre);
        assert!(p.width <= 1366.0 && p.height <= 768.0);
        // Same monitor, smaller: it is pulled inside.
        let s2 = saved(500, 100, 1200.0, 650.0, 1.0);
        let p2 = plan(Some(&s2), &[mon(0, 0, 1366, 768, 1.0)], 0);
        assert_eq!(p2.spot, Spot::At { x: 166, y: 100 });
    }

    #[test]
    fn a_different_scale_keeps_the_apparent_size() {
        // Saved at 100%, the monitor is now 150%: same logical size, more physical pixels.
        let s = saved(100, 100, 1200.0, 800.0, 1.0);
        let m = mon(0, 0, 3840, 2160, 1.5);
        let p = plan(Some(&s), &[m], 0);
        assert_eq!((p.width, p.height), (1200.0, 800.0));
        assert!(matches!(p.spot, Spot::At { .. }));
        // And a 150% window on a 100% screen is not left oversized.
        let big = saved(0, 0, 1800.0, 1200.0, 1.5);
        let q = plan(Some(&big), &[mon(0, 0, 1920, 1080, 1.0)], 0);
        assert!(q.width <= 1920.0 && q.height <= 1080.0);
    }

    #[test]
    fn a_size_below_the_minimum_is_raised_to_it() {
        let s = saved(100, 100, 300.0, 200.0, 1.0);
        let p = plan(Some(&s), &[mon(0, 0, HD.0, HD.1, 1.0)], 0);
        assert_eq!((p.width, p.height), MIN_SIZE);
    }

    #[test]
    fn a_screen_smaller_than_the_minimum_still_fits_the_window() {
        let s = saved(0, 0, 900.0, 600.0, 1.0);
        let p = plan(Some(&s), &[mon(0, 0, 800, 480, 1.0)], 0);
        assert_eq!((p.width, p.height), (800.0, 480.0));
    }

    #[test]
    fn nonsense_in_the_file_means_the_default() {
        for bad in [
            saved(0, 0, f64::NAN, 700.0, 1.0),
            saved(0, 0, 1000.0, 700.0, 0.0),
            saved(0, 0, -5.0, 700.0, 1.0),
            saved(5_000_000, 0, 1000.0, 700.0, 1.0),
            saved(0, 0, 1000.0, 700.0, f64::INFINITY),
        ] {
            let p = plan(Some(&bad), &[mon(0, 0, HD.0, HD.1, 1.0)], 0);
            assert_eq!((p.width, p.height), DEFAULT_SIZE, "{bad:?}");
            assert_eq!(p.spot, Spot::Centre);
        }
    }

    #[test]
    fn maximised_and_full_screen_are_remembered() {
        let mut s = saved(100, 100, 1200.0, 800.0, 1.0);
        s.maximized = true;
        let p = plan(Some(&s), &[mon(0, 0, HD.0, HD.1, 1.0)], 0);
        assert!(p.maximized && !p.fullscreen);
        s.maximized = false;
        s.fullscreen = true;
        assert!(plan(Some(&s), &[mon(0, 0, HD.0, HD.1, 1.0)], 0).fullscreen);
    }

    #[test]
    fn without_monitor_information_the_size_is_kept_and_the_system_places_it() {
        let s = saved(100, 100, 1200.0, 800.0, 1.0);
        let p = plan(Some(&s), &[], 0);
        assert_eq!((p.width, p.height, p.spot), (1200.0, 800.0, Spot::Centre));
    }

    fn snap(x: i32, y: i32, w: u32, h: u32) -> Snapshot {
        Snapshot {
            x,
            y,
            width: w,
            height: h,
            scale: 1.25,
            maximized: false,
            fullscreen: false,
            minimized: false,
        }
    }

    #[test]
    fn moving_or_resizing_saves_the_new_bounds_in_logical_pixels() {
        let s = merge(None, &snap(200, 150, 1500, 1000)).unwrap();
        assert_eq!(
            (s.x, s.y, s.width, s.height, s.scale),
            (200, 150, 1200.0, 800.0, 1.25)
        );
    }

    #[test]
    fn maximising_keeps_the_normal_bounds_and_notes_the_state() {
        let normal = merge(None, &snap(200, 150, 1500, 1000)).unwrap();
        let mut now = snap(0, 0, 1920, 1080);
        now.maximized = true;
        let s = merge(Some(&normal), &now).unwrap();
        assert!(s.maximized);
        assert_eq!((s.x, s.y, s.width, s.height), (200, 150, 1200.0, 800.0));
        // Restoring clears the flag and takes the new bounds.
        let back = merge(Some(&s), &snap(210, 160, 1500, 1000)).unwrap();
        assert!(!back.maximized);
        assert_eq!((back.x, back.y), (210, 160));
    }

    #[test]
    fn a_minimised_window_is_never_saved_at_its_parking_place() {
        let normal = merge(None, &snap(200, 150, 1500, 1000)).unwrap();
        let mut now = snap(-32000, -32000, 160, 28);
        now.minimized = true;
        assert_eq!(merge(Some(&normal), &now).unwrap(), normal);
        assert_eq!(merge(None, &now), None);
        // Even when the system does not say minimised.
        now.minimized = false;
        assert_eq!(merge(Some(&normal), &now).unwrap(), normal);
    }

    #[test]
    fn maximised_on_the_very_first_run_still_has_a_size_to_return_to() {
        let mut now = snap(0, 0, 1920, 1080);
        now.maximized = true;
        let s = merge(None, &now).unwrap();
        assert!(s.maximized);
        assert_eq!((s.width, s.height), DEFAULT_SIZE);
    }

    #[test]
    fn the_file_round_trips_and_a_bad_one_is_ignored() {
        let dir = std::env::temp_dir().join(format!("ancile-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("window-state.json");
        assert_eq!(load(&path), None, "no file");
        let s = saved(10, 20, 1111.0, 777.0, 1.5);
        save(&path, &s).unwrap();
        assert_eq!(load(&path), Some(s));
        std::fs::write(&path, "{ this is not json").unwrap();
        assert_eq!(load(&path), None, "corrupt");
        std::fs::write(&path, r#"{"x":0,"y":0,"width":1e99,"height":10,"scale":1,"maximized":false,"fullscreen":false}"#).unwrap();
        assert_eq!(load(&path), None, "silly numbers");
        std::fs::write(&path, "").unwrap();
        assert_eq!(load(&path), None, "empty");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
