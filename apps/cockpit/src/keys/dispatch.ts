/**
 * ------------------------------------------------------------------
 *  Title    |  Key dispatch
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Turn keydown events into binding ids, with sequences,
 *           |  scopes and the rule that single keys never fire while
 *           |  you are typing or while a dialog is open.
 *  How      |  One window listener. Handlers register per id with a
 *           |  scope; the most recently registered handler for an id
 *           |  wins, so a focused panel can override a global one.
 *           |  Sequences wait for their next chord as long as Settings
 *           |  says (800 ms by default). The index rebuilds when a
 *           |  person rebinds a key. A key that fires flashes its kbd
 *           |  hints on screen, so the shortcut teaches itself.
 * ------------------------------------------------------------------
 */

import { useEffect, useRef } from 'react';
import { shortcutUsed } from '../lib/telemetry';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { type BindingDef, effectiveBindings, isMac, normalise, onOverridesChange } from './registry';

type Handler = (e: KeyboardEvent) => void;
interface Registered {
  fn: Handler;
  order: number;
}

const handlers = new Map<string, Registered[]>();
let registrations = 0;

export function chordOf(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (e.altKey) mods.push('alt');
  let key = e.key.toLowerCase();
  if (key === 'esc') key = 'escape';
  // "?" and "{" already encode shift; only name shift for letters and named keys.
  if (e.shiftKey && (key.length > 1 || /[a-z]/.test(key))) mods.push('shift');
  // Alt on macOS rewrites the character; fall back to the physical key.
  if (e.altKey && e.code.startsWith('Bracket')) key = e.code === 'BracketLeft' ? '[' : ']';
  return [...mods.sort(), key].join('+');
}

/** Elements that act on Enter/Space themselves. */
export function isControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.closest(
      'button, a[href], summary, select, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"]',
    )
  )
    return true;
  return isTyping(target);
}

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
  }
  return false;
}

let index = new Map<string, BindingDef[]>();
let prefixes = new Set<string>();
function rebuild(): void {
  const next = new Map<string, BindingDef[]>();
  const bindings = effectiveBindings();
  for (const b of bindings) {
    const k = normalise(b.keys);
    next.set(k, [...(next.get(k) ?? []), b]);
  }
  index = next;
  prefixes = new Set(
    bindings.filter((b) => b.keys.includes(' ')).map((b) => normalise(b.keys).split(' ')[0] ?? ''),
  );
}
rebuild();
onOverridesChange(rebuild);

/** Light up every on-screen hint for this binding for a moment. */
function flash(id: string): void {
  if (!usePrefs.getState().prefs.keyboard.hintFlash) return;
  const kbds = document.querySelectorAll<HTMLElement>(`[data-binding="${id}"] kbd`);
  for (const k of kbds) {
    k.dataset.flash = '';
    setTimeout(() => delete k.dataset.flash, 180);
  }
}

/** A plain letter, digit or symbol with no modifier: off when single keys are turned off. */
export const isSingleKey = (seq: string) => !seq.includes('+') && !seq.includes(' ') && seq !== 'escape';

let pending: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function fire(sequence: string, e: KeyboardEvent): boolean {
  const defs = index.get(sequence);
  if (!defs) return false;
  const typing = isTyping(e.target);
  const overlay = useUi.getState().layers > 0;
  if (isSingleKey(sequence) && !usePrefs.getState().prefs.keyboard.singleKeys) return false;
  // Several bindings may share a key in different scopes (j in a list, j in
  // the tree). The handler registered most recently wins: focus a panel and
  // its keys take over until it lets go.
  let best: Registered | undefined;
  let bestId = '';
  for (const def of defs) {
    if (typing && !def.inInputs) continue;
    if (overlay && !def.inInputs) continue;
    const list = handlers.get(def.id) ?? [];
    const top = list[list.length - 1];
    if (top && (!best || top.order > best.order)) {
      best = top;
      bestId = def.id;
    }
  }
  if (!best) return false;
  e.preventDefault();
  best.fn(e);
  flash(bestId);
  shortcutUsed(bestId);
  return true;
}

export function onKeyDown(e: KeyboardEvent): void {
  // A Radix layer (dialog, popover) already handled this key, Escape
  // included: the topmost layer closes and nothing beneath it does.
  if (e.defaultPrevented) return;
  if (e.repeat && !['j', 'k'].includes(e.key)) return;
  if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return;
  // Enter and Space on a focused control belong to that control. Without
  // this, list-level bindings ("Enter opens the selected item") swallowed
  // the keypress and no button in the app could be pressed from the keyboard.
  if ((e.key === 'Enter' || e.key === ' ') && isControl(e.target)) return;
  const chord = chordOf(e);

  if (pending) {
    const seq = `${pending} ${chord}`;
    pending = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    if (fire(seq, e)) return;
  }
  if (prefixes.has(chord) && !isTyping(e.target) && useUi.getState().layers === 0) {
    pending = chord;
    pendingTimer = setTimeout(() => {
      pending = null;
    }, usePrefs.getState().prefs.keyboard.sequenceMs);
    return;
  }
  fire(chord, e);
}

export function installKeys(): () => void {
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** Attach a handler to a binding id for the lifetime of a component. */
export function useBinding(id: string, handler: Handler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const entry: Registered = { fn: (e) => ref.current(e), order: ++registrations };
    handlers.set(id, [...(handlers.get(id) ?? []), entry]);
    return () => {
      handlers.set(
        id,
        (handlers.get(id) ?? []).filter((h) => h !== entry),
      );
    };
  }, [id, enabled]);
}

/** Overlays register while open so single-key bindings pause under them. */
export function useLayer(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    useUi.getState().pushLayer();
    return () => useUi.getState().popLayer();
  }, [open]);
}
