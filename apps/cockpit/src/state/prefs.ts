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
 *           |  newer of the two wins.
 *  Note     |  Everything is parsed through the contract, so an old or
 *           |  hand-edited file can never leave a hole.
 * ------------------------------------------------------------------
 */

import { applyLook, getThemeChoice, type Look } from '@nvx/aperture';
import { DEFAULT_PREFERENCES, Preferences, type PrefGroup } from '@nvx/contracts';
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
  set: <G extends PrefGroup>(group: G, patch: Partial<Group<G>>) => void;
  reset: (group?: PrefGroup, key?: string) => void;
  replace: (next: unknown) => Preferences;
  setAutoLite: (lite: boolean) => void;
}

const READ_LH = { tight: 1.5, normal: 1.65, loose: 1.8 } as const;
const READ_W = { narrow: 60, normal: 72, wide: 84, full: 0 } as const;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const prefersReducedTransparency = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches;

export function lookOf(p: Preferences, autoLite = false): Look {
  const a = p.appearance;
  const x = p.accessibility;
  const motion = x.motion === 'system' ? (prefersReducedMotion() ? 'reduced' : 'full') : x.motion;
  return {
    contrast: a.contrast,
    accent: a.accent,
    tint: a.tint,
    gilt: a.gilt,
    material: a.material,
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
function scheduleSync(prefs: Preferences, changedAt: number) {
  clearTimeout(syncTimer);
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

export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      prefs: DEFAULT_PREFERENCES,
      changedAt: 0,
      autoLite: false,
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
    }),
    {
      name: 'nvx.ancile.prefs',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ prefs: s.prefs, changedAt: s.changedAt }),
      merge: (persisted, current) => {
        const p = persisted as { prefs?: unknown; changedAt?: number } | undefined;
        // Before preferences existed the theme had its own key: carry it over once.
        const legacy = !p?.prefs ? { appearance: { theme: getThemeChoice() } } : {};
        const parsed = Preferences.safeParse(p?.prefs ?? legacy);
        return {
          ...current,
          prefs: parsed.success ? parsed.data : DEFAULT_PREFERENCES,
          changedAt: p?.changedAt ?? 0,
        };
      },
    },
  ),
);

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

  // The server copy wins only when it is newer than this device's.
  void api
    .get<{ value: { prefs?: unknown; changedAt?: number } | null }>('/ui-state/prefs')
    .then((r) => {
      const remote = r.value;
      if (!remote?.prefs || (remote.changedAt ?? 0) <= usePrefs.getState().changedAt) return;
      const parsed = Preferences.safeParse(remote.prefs);
      if (parsed.success) usePrefs.setState({ prefs: parsed.data, changedAt: remote.changedAt ?? 0 });
    })
    .catch(() => undefined);

  return () => {
    unsub();
    for (const mq of mqs) mq.removeEventListener('change', apply);
  };
}

/**
 * The lite governor: while performance is "auto", frames slower than 20 ms
 * for two seconds running turn off blur and grain; a calm minute turns them
 * back on.
 */
export function startFrameGovernor(): () => void {
  let raf = 0;
  let last = performance.now();
  let slowSince = 0;
  let calmSince = 0;
  const tick = (now: number) => {
    const dt = now - last;
    last = now;
    const { autoLite, setAutoLite, prefs } = usePrefs.getState();
    if (prefs.advanced.performance === 'auto' && document.visibilityState === 'visible' && dt < 250) {
      if (dt > 20) {
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
