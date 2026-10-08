/**
 * ------------------------------------------------------------------
 *  Title    |  Shortcut nudge
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Teach a shortcut at the moment it would have helped:
 *           |  the third time you click a control that has one, a
 *           |  quiet tip names the key. Once per shortcut, ever.
 *  How      |  Tip (ui/primitives) reports clicks on controls with a
 *           |  binding. Counts live in localStorage (a per-viewer
 *           |  convenience); storage failing just means no tips.
 *  Note     |  Follows "Light up the hint" in Settings → Keyboard, and
 *           |  skips single keys while single keys are turned off.
 * ------------------------------------------------------------------
 */

import { controlClicked } from '../lib/telemetry';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { isSingleKey } from './dispatch';
import { bindingById, keyText, normalise } from './registry';

const KEY = 'nvx.ancile.shortcut-nudges';
const AFTER = 3;

interface Seen {
  clicks: Record<string, number>;
  told: string[];
}

function load(): Seen {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Seen;
  } catch {
    /* blocked or corrupt: start fresh */
  }
  return { clicks: {}, told: [] };
}

function save(s: Seen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: no tips, nothing else changes */
  }
}

/** A control with this binding was clicked. Returns true when a tip was shown. */
export function noteClick(id: string): boolean {
  controlClicked(id);
  const prefs = usePrefs.getState().prefs.keyboard;
  if (!prefs.hintFlash) return false;
  const b = bindingById(id);
  if (!b) return false;
  if (!prefs.singleKeys && isSingleKey(normalise(b.keys))) return false;
  const s = load();
  if (s.told.includes(id)) return false;
  const n = (s.clicks[id] ?? 0) + 1;
  s.clicks[id] = n;
  if (n < AFTER) {
    save(s);
    return false;
  }
  s.told.push(id);
  delete s.clicks[id];
  save(s);
  notify({ level: 'info', title: `Next time, press ${keyText(id)}`, body: b.label });
  return true;
}
