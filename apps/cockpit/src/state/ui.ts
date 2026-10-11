/**
 * ------------------------------------------------------------------
 *  Title    |  UI state
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Layout, overlays and the live status the chrome shows.
 *  How      |  Zustand. Layout state persists to localStorage
 *           |  (per-viewer conveniences); the server copy at
 *           |  /ui-state syncs across devices. TODO(phase-2): sync.
 *           |  Live status starts empty: Core fills it, never the demo
 *           |  fixtures. The side panel's tab starts from the setting.
 *  Note     |  `layers` counts open overlays so single-key bindings
 *           |  pause while a dialog is up. Each overlay owns its Esc.
 * ------------------------------------------------------------------
 */

import { getThemeChoice, type MarkState, setTheme, type ThemeChoice } from '@nvx/aperture';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import * as demo from '../fixtures/demo';
import type { LiveState } from '../lib/types';
import { usePrefs } from './prefs';

export type DrawerTab = 'sources' | 'notes' | 'tree' | 'why' | 'evidence' | 'repo';
/** Nothing known yet: no model chosen, no node, nothing waiting. */
export const EMPTY_LIVE: LiveState = {
  modelId: '',
  context: { ratio: 0, used: 0, window: 0 },
  node: null,
  approvals: 0,
  health: 'ok',
};

/**
 * The titlebar and palette toggle: always the opposite of the theme on
 * screen, and back to "system" when that opposite is what the system shows,
 * so the toggle never does nothing and never strands you off "system".
 */
export function nextTheme(shown: 'dark' | 'light', systemDark: boolean): ThemeChoice {
  const next = shown === 'dark' ? 'light' : 'dark';
  return (next === 'dark') === systemDark ? 'system' : next;
}

export type PaletteScope = 'all' | 'commands' | 'models' | 'notebooks' | 'help' | 'settings';

interface UiState {
  railOpen: boolean;
  drawerOpen: boolean;
  /** The drawer as an overlay sheet (narrow screens): opens only when asked, never remembered. */
  sheetOpen: boolean;
  drawerTab: DrawerTab;
  /** When something asked for a particular tab (a citation, Why, a note), so opening a thread does not undo it. */
  drawerTabAt: number;
  focusedClaim: string | null;
  /** The answer the Evidence panel shows; null means the latest checked one. */
  evidenceMessage: string | null;

  paletteOpen: boolean;
  paletteScope: PaletteScope;
  /** Text to start the palette with ("Search inside messages" from the rail filter). */
  paletteQuery: string;
  helpOpen: boolean;
  /** The help article to open at, or null for the contents. */
  helpArticle: string | null;
  /** Focus mode: rail and drawer away, the work alone. */
  focusMode: boolean;
  /** The answer the Why panel explains; null means the latest. */
  whyMessage: string | null;
  /** The note the Notes panel has open; null shows the list. */
  noteOpen: string | null;
  /** The source viewer: which source, and the span to show. */
  viewer: { sourceId: string; start?: number; end?: number; marker?: number } | null;
  shortcutsOpen: boolean;
  approvalOpen: boolean;
  /** The approval the dialog should show; null means the one for the screen you are on. */
  approvalFocus: string | null;
  centerOpen: boolean;
  layers: number;

  demo: boolean;
  theme: ThemeChoice;
  mark: MarkState;
  live: LiveState;

  toggleRail: () => void;
  toggleDrawer: () => void;
  toggleSheet: () => void;
  openDrawer: (tab: DrawerTab) => void;
  /** Open one note in the Notes panel (null: back to the list). */
  openNote: (id: string | null) => void;
  focusClaim: (id: string | null, messageId?: string) => void;
  /** Open the Evidence panel on one answer's fact-check. */
  showEvidence: (messageId: string) => void;
  openPalette: (scope?: PaletteScope, query?: string) => void;
  setHelp: (open: boolean, article?: string | null) => void;
  toggleFocus: () => void;
  openViewer: (v: UiState['viewer']) => void;
  explain: (messageId: string) => void;
  closePalette: () => void;
  setShortcuts: (open: boolean) => void;
  setApproval: (open: boolean, approvalId?: string | null) => void;
  setCenter: (open: boolean) => void;
  pushLayer: () => void;
  popLayer: () => void;
  setDemo: (demo: boolean) => void;
  setMark: (mark: MarkState) => void;
  cycleTheme: () => void;
  /** Opening a thread: the side panel goes to the tab chosen in Settings, unless something just asked for one. */
  resetDrawerTab: () => void;
  setModel: (modelId: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      railOpen: true,
      drawerOpen: true,
      sheetOpen: false,
      drawerTab: usePrefs.getState().prefs.layout.drawerTab,
      drawerTabAt: 0,
      focusedClaim: null,

      paletteOpen: false,
      paletteScope: 'all',
      paletteQuery: '',
      helpOpen: false,
      helpArticle: null,
      focusMode: false,
      viewer: null,
      whyMessage: null,
      noteOpen: null,
      evidenceMessage: null,
      shortcutsOpen: false,
      approvalOpen: false,
      approvalFocus: null,
      centerOpen: false,
      layers: 0,

      demo: false,
      theme: typeof window === 'undefined' ? 'system' : getThemeChoice(),
      mark: 'idle',
      live: EMPTY_LIVE,

      toggleRail: () => set((s) => ({ railOpen: !s.railOpen })),
      toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
      toggleSheet: () => set((s) => ({ sheetOpen: !s.sheetOpen })),
      openDrawer: (tab) =>
        set({ drawerOpen: true, sheetOpen: true, drawerTab: tab, drawerTabAt: Date.now() }),
      openNote: (id) =>
        set(
          id
            ? { noteOpen: id, drawerOpen: true, sheetOpen: true, drawerTab: 'notes', drawerTabAt: Date.now() }
            : { noteOpen: null },
        ),
      focusClaim: (id, messageId) =>
        set((s) =>
          id
            ? {
                focusedClaim: id,
                evidenceMessage: messageId ?? s.evidenceMessage,
                drawerOpen: true,
                sheetOpen: true,
                drawerTab: 'evidence',
                drawerTabAt: Date.now(),
              }
            : { focusedClaim: null },
        ),
      showEvidence: (messageId) =>
        set({
          evidenceMessage: messageId,
          focusedClaim: null,
          drawerOpen: true,
          sheetOpen: true,
          drawerTab: 'evidence',
          drawerTabAt: Date.now(),
        }),
      openPalette: (scope = 'all', query = '') =>
        set({ paletteOpen: true, paletteScope: scope, paletteQuery: query }),
      setHelp: (open, article = null) => set({ helpOpen: open, helpArticle: open ? article : null }),
      toggleFocus: () => set((s) => ({ focusMode: !s.focusMode })),
      explain: (messageId) =>
        set({
          whyMessage: messageId,
          drawerOpen: true,
          sheetOpen: true,
          drawerTab: 'why',
          drawerTabAt: Date.now(),
        }),
      openViewer: (viewer) =>
        set(
          viewer
            ? { viewer, drawerOpen: true, sheetOpen: true, drawerTab: 'sources', drawerTabAt: Date.now() }
            : { viewer: null },
        ),
      closePalette: () => set({ paletteOpen: false }),
      setShortcuts: (open) => set({ shortcutsOpen: open }),
      setApproval: (open, approvalId = null) =>
        set({ approvalOpen: open, approvalFocus: open ? approvalId : null }),
      setCenter: (open) => set({ centerOpen: open }),
      pushLayer: () => set((s) => ({ layers: s.layers + 1 })),
      popLayer: () => set((s) => ({ layers: Math.max(0, s.layers - 1) })),
      setDemo: (value) =>
        set((s) =>
          s.demo === value ? s : { demo: value, mark: value && demo.live.approvals > 0 ? 'ask' : s.mark },
        ),
      setMark: (mark) => set({ mark }),
      // The toggle always changes what you see (see nextTheme).
      cycleTheme: () =>
        set(() => {
          const shown = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
          const next = nextTheme(shown, !window.matchMedia('(prefers-color-scheme: light)').matches);
          setTheme(next);
          usePrefs.getState().set('appearance', { theme: next });
          return { theme: next };
        }),
      resetDrawerTab: () =>
        set((s) =>
          Date.now() - s.drawerTabAt < 1500 ? s : { drawerTab: usePrefs.getState().prefs.layout.drawerTab },
        ),
      setModel: (modelId) => set((s) => ({ live: { ...s.live, modelId } })),
    }),
    {
      name: 'nvx.ancile.ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        railOpen: s.railOpen,
        drawerOpen: s.drawerOpen,
        focusMode: s.focusMode,
        live: { modelId: s.live.modelId },
      }),
      // Only these come back. Older copies also held the demo's live status
      // and the last tab; neither is let back in.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<
          Pick<UiState, 'railOpen' | 'drawerOpen' | 'focusMode'> & { live: { modelId?: unknown } }
        >;
        return {
          ...current,
          railOpen: typeof p.railOpen === 'boolean' ? p.railOpen : current.railOpen,
          drawerOpen: typeof p.drawerOpen === 'boolean' ? p.drawerOpen : current.drawerOpen,
          focusMode: typeof p.focusMode === 'boolean' ? p.focusMode : current.focusMode,
          live: {
            ...EMPTY_LIVE,
            modelId: typeof p.live?.modelId === 'string' ? p.live.modelId : '',
          },
        };
      },
    },
  ),
);
