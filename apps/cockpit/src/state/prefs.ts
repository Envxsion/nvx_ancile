/**
 * ------------------------------------------------------------------
 *  Title    |  Preferences
 *  Ref      |  DESIGN-UI.md §4 · contracts/prefs.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every setting in one store: read anywhere, changed from
 *           |  Settings or the palette, applied to the document at
 *           |  once, kept on this device and in Core so it follows you.
 *  How      |  Zustand, persisted to localStorage. Appearance and
 *           |  reading choices become a Look (aperture/prefs.ts) on
 *           |  <html>. Core holds a copy under ui-state "prefs",
 *           |  written 800 ms after the last change; on start the
 *           |  newer of the two wins. Device-only settings
 *           |  (DEVICE_PREFS: zoom, panel widths, effects, custom CSS)
 *           |  never go to Core and are never taken from its copy.
 *           |  Whether custom CSS was confirmed here (cssConsent) is
 *           |  this device's alone, outside the preferences.
 *  Note     |  Everything is parsed through the contract, so an old or
 *           |  hand-edited file can never leave a hole.
 * ------------------------------------------------------------------
 */

import { applyLook, getThemeChoice, type Look } from '@nvx/aperture';
import type { PrefGroup } from '@nvx/contracts';
import { DEFAULT_PREFERENCES, keepDevicePrefs, Preferences, withoutDevicePrefs } from '@nvx/contracts/prefs';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { API_BASE, api } from '../lib/api';

type Group<G extends PrefGroup> = Preferences[G];

interface PrefsState {
  prefs: Preferences;
  /** When the prefs last changed here, for picking the newer copy. */
  changedAt: number;
  /** Resolved by the frame-time governor while performance is "auto". */
  autoLite: boolean;
  /** Custom CSS was confirmed on this device (the first-time confirm). Never synced. */
  cssConsent: boolean;
  set: <G extends PrefGroup>(group: G, patch: Partial<Group<G>>) => void;
  reset: (group?: PrefGroup, key?: string) => void;
  replace: (next: unknown) => Preferences;
  setAutoLite: (lite: boolean) => void;
  /** Confirm custom CSS on this device and apply it. */
  applyCss: (css: string) => void;
}

const READ_LH = { tight: 1.5, normal: 1.65, loose: 1.8 } as const;
const READ_W = { narrow: 60, normal: 72, wide: 84, full: 0 } as const;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const prefersReducedTransparency = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches;

/**
 * Whether this window can blur what is behind an element. Every current
 * WebView2 and browser can; one that cannot would show glass as a flat
 * see-through tint, so it gets the solid material and Settings says why.
 */
export function backdropSupported(): boolean {
  const css = typeof CSS === 'undefined' ? undefined : CSS;
  if (!css || typeof css.supports !== 'function') return true;
  return css.supports('backdrop-filter', 'blur(1px)') || css.supports('-webkit-backdrop-filter', 'blur(1px)');
}

export function lookOf(p: Preferences, autoLite = false): Look {
  const a = p.appearance;
  const x = p.accessibility;
  const motion = x.motion === 'system' ? (prefersReducedMotion() ? 'reduced' : 'full') : x.motion;
  return {
    contrast: a.contrast,
    accent: a.accent,
    tint: a.tint,
    gilt: a.gilt,
    material: a.material === 'glass' && !backdropSupported() ? 'solid' : a.material,
    grain: a.grain,
    mark: a.mark,
    font: a.font,
    mono: a.mono,
    width: a.width,
    corners: a.corners,
    zoom: a.zoom,
    density: p.layout.density,
    motion,
    transparency: x.transparency === 'reduced' || prefersReducedTransparency() ? 'reduced' : 'full',
    focus: x.focus,
    links: x.underlineLinks ? 'underline' : 'plain',
    targets: x.largeTargets ? 'large' : 'standard',
    readSize: p.reading.size,
    lineHeight: READ_LH[p.reading.lineHeight],
    readWidth: READ_W[p.reading.width],
    codeSize: p.reading.codeSize,
    fx:
      p.advanced.performance === 'lite' || (p.advanced.performance === 'auto' && autoLite) ? 'lite' : 'full',
  };
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSync: string | null = null;
function scheduleSync(all: Preferences, changedAt: number) {
  clearTimeout(syncTimer);
  // Core's copy follows you to other devices: what belongs to this one stays here.
  const prefs = withoutDevicePrefs(all);
  pendingSync = JSON.stringify({ value: { prefs, changedAt } });
  syncTimer = setTimeout(() => {
    pendingSync = null;
    void api.put('/ui-state/prefs', { value: { prefs, changedAt } }).catch(() => undefined);
  }, 800);
}
// A change made just before the tab closes still reaches Core (keepalive
// outlives the page), so another device never sees the older choice.
if (typeof window !== 'undefined')
  window.addEventListener('pagehide', () => {
    if (!pendingSync) return;
    clearTimeout(syncTimer);
    void fetch(`${API_BASE}/ui-state/prefs`, {
      method: 'PUT',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: pendingSync,
    }).catch(() => undefined);
    pendingSync = null;
  });

/** Stored preferences from an older version of this store, brought up to date. Exported for tests. */
export function migratePrefs(persisted: unknown, from: number): unknown {
  const p = persisted as { prefs?: { appearance?: Record<string, unknown> } } | undefined;
  if (from < 2 && p?.prefs?.appearance)
    return { ...p, prefs: { ...p.prefs, appearance: { ...p.prefs.appearance, grain: false } } };
  return persisted;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      prefs: DEFAULT_PREFERENCES,
      changedAt: 0,
      autoLite: false,
      cssConsent: false,
      set: (group, patch) => {
        const prefs = Preferences.parse({ ...get().prefs, [group]: { ...get().prefs[group], ...patch } });
        const changedAt = Date.now();
        set({ prefs, changedAt });
        scheduleSync(prefs, changedAt);
      },
      reset: (group, key) => {
        const cur = get().prefs;
        let next: Preferences;
        if (!group) next = DEFAULT_PREFERENCES;
        else if (!key) next = { ...cur, [group]: DEFAULT_PREFERENCES[group] };
        else
          next = {
            ...cur,
            [group]: { ...cur[group], [key]: (DEFAULT_PREFERENCES[group] as Record<string, unknown>)[key] },
          };
        const changedAt = Date.now();
        set({ prefs: next, changedAt });
        scheduleSync(next, changedAt);
      },
      replace: (raw) => {
        const prefs = Preferences.parse(raw);
        const changedAt = Date.now();
        set({ prefs, changedAt });
        scheduleSync(prefs, changedAt);
        return prefs;
      },
      setAutoLite: (autoLite) => set({ autoLite }),
      applyCss: (css) => {
        set({ cssConsent: true });
        get().set('advanced', { css });
      },
    }),
    {
      name: 'nvx.ancile.prefs',
      // 2: film grain became Off by default. Version 1 stored it On for
      // everyone who never touched it, so it goes Off once; On again is a click.
      version: 2,
      migrate: (persisted, from) => migratePrefs(persisted, from),
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ prefs: s.prefs, changedAt: s.changedAt, cssConsent: s.cssConsent }),
      merge: (persisted, current) => {
        const p = persisted as { prefs?: unknown; changedAt?: number; cssConsent?: boolean } | undefined;
        // Before preferences existed the theme had its own key: carry it over once.
        const legacy = !p?.prefs ? { appearance: { theme: getThemeChoice() } } : {};
        const parsed = Preferences.safeParse(p?.prefs ?? legacy);
        return {
          ...current,
          prefs: parsed.success ? parsed.data : DEFAULT_PREFERENCES,
          changedAt: p?.changedAt ?? 0,
          cssConsent: p?.cssConsent === true,
        };
      },
    },
  ),
);

/**
 * Take Core's copy (from another device, or this one before a reload) when
 * it is newer, keeping this device's own settings. Exported for tests.
 */
export function adoptRemotePrefs(
  remote: { prefs?: unknown; changedAt?: number } | null | undefined,
): boolean {
  const s = usePrefs.getState();
  if (!remote?.prefs || (remote.changedAt ?? 0) <= s.changedAt) return false;
  const parsed = Preferences.safeParse(remote.prefs);
  if (!parsed.success) return false;
  usePrefs.setState({ prefs: keepDevicePrefs(parsed.data, s.prefs), changedAt: remote.changedAt ?? 0 });
  return true;
}

/** Read one group, re-rendering only when it changes. */
export function usePref<G extends PrefGroup>(group: G): Group<G> {
  return usePrefs((s) => s.prefs[group]);
}

/** Changed from its default? Drives the dot beside a setting. */
export function isChanged(group: PrefGroup, key: string, prefs: Preferences): boolean {
  const a = (prefs[group] as Record<string, unknown>)[key];
  const b = (DEFAULT_PREFERENCES[group] as Record<string, unknown>)[key];
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Keep the document in step with the store, the OS, and Core's copy.
 * Called once from the app shell. Returns a cleanup.
 */
export function startPrefs(): () => void {
  const apply = () => {
    const s = usePrefs.getState();
    applyLook(lookOf(s.prefs, s.autoLite));
  };
  apply();
  const unsub = usePrefs.subscribe((s, prev) => {
    if (s.prefs !== prev.prefs || s.autoLite !== prev.autoLite) apply();
  });
  const mqs = ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)'].map((q) =>
    window.matchMedia(q),
  );
  for (const mq of mqs) mq.addEventListener('change', apply);

  // The server copy wins only when it is newer than this device's, and
  // never for what belongs to this device (an older copy may still hold it).
  void api
    .get<{ value: { prefs?: unknown; changedAt?: number } | null }>('/ui-state/prefs')
    .then((r) => adoptRemotePrefs(r.value))
    .catch(() => undefined);

  return () => {
    unsub();
    for (const mq of mqs) mq.removeEventListener('change', apply);
  };
}

/**
 * The lite governor: while performance is "auto", frames well over this
 * display's own frame time for two seconds running turn off blur and grain;
 * a calm minute turns them back on. "Slow" is measured against the
 * display, not a fixed 20 ms: on a 50 Hz or 48 Hz panel every frame takes
 * 20 ms or more, and the fixed line kept glass off on them for good.
 */
export function frameIsSlow(dt: number, frame: number): boolean {
  return dt > Math.max(20, frame * 1.5);
}

export function startFrameGovernor(): () => void {
  let raf = 0;
  let last = performance.now();
  let slowSince = 0;
  let calmSince = 0;
  // This display's frame time: the shortest interval seen lately, eased up slowly.
  let frame = 1000 / 60;
  const tick = (now: number) => {
    const dt = now - last;
    last = now;
    if (dt > 4 && dt < 250) frame = dt < frame ? dt : frame + (dt - frame) * 0.002;
    const { autoLite, setAutoLite, prefs } = usePrefs.getState();
    if (prefs.advanced.performance === 'auto' && document.visibilityState === 'visible' && dt < 250) {
      if (frameIsSlow(dt, frame)) {
        calmSince = 0;
        slowSince ||= now;
        if (!autoLite && now - slowSince > 2000) setAutoLite(true);
      } else {
        slowSince = 0;
        calmSince ||= now;
        if (autoLite && now - calmSince > 60_000) setAutoLite(false);
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
