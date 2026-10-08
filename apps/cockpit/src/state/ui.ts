/**
 * ------------------------------------------------------------------
 *  Title    |  UI state
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Layout, overlays and the live status the chrome shows.
 *  How      |  Zustand. Layout preferences persist to localStorage
 *           |  (per-viewer conveniences); the server copy at
 *           |  /ui-state syncs across devices. TODO(phase-2): sync.
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
export type PaletteScope = 'all' | 'commands' | 'models' | 'notebooks' | 'help' | 'settings';

interface UiState {
  railOpen: boolean;
  drawerOpen: boolean;
  /** The drawer as an overlay sheet (narrow screens): opens only when asked, never remembered. */
  sheetOpen: boolean;
  drawerTab: DrawerTab;
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
  setModel: (modelId: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      railOpen: true,
      drawerOpen: true,
      sheetOpen: false,
      drawerTab: 'sources',
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
      live: demo.live,

      toggleRail: () => set((s) => ({ railOpen: !s.railOpen })),
      toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
      toggleSheet: () => set((s) => ({ sheetOpen: !s.sheetOpen })),
      openDrawer: (tab) => set({ drawerOpen: true, sheetOpen: true, drawerTab: tab }),
      openNote: (id) =>
        set(
          id ? { noteOpen: id, drawerOpen: true, sheetOpen: true, drawerTab: 'notes' } : { noteOpen: null },
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
        }),
      openPalette: (scope = 'all', query = '') =>
        set({ paletteOpen: true, paletteScope: scope, paletteQuery: query }),
      setHelp: (open, article = null) => set({ helpOpen: open, helpArticle: open ? article : null }),
      toggleFocus: () => set((s) => ({ focusMode: !s.focusMode })),
      explain: (messageId) =>
        set({ whyMessage: messageId, drawerOpen: true, sheetOpen: true, drawerTab: 'why' }),
      openViewer: (viewer) =>
        set(viewer ? { viewer, drawerOpen: true, sheetOpen: true, drawerTab: 'sources' } : { viewer: null }),
      closePalette: () => set({ paletteOpen: false }),
      setShortcuts: (open) => set({ shortcutsOpen: open }),
      setApproval: (open, approvalId = null) =>
        set({ approvalOpen: open, approvalFocus: open ? approvalId : null }),
      setCenter: (open) => set({ centerOpen: open }),
      pushLayer: () => set((s) => ({ layers: s.layers + 1 })),
      popLayer: () => set((s) => ({ layers: Math.max(0, s.layers - 1) })),
      setDemo: (value) =>
        set((s) =>
          s.demo === value ? s : { demo: value, mark: value && s.live.approvals > 0 ? 'ask' : s.mark },
        ),
      setMark: (mark) => set({ mark }),
      // The toggle always changes what you see: to the opposite of the theme
      // on screen. Cycling system → dark could do nothing visible on a dark OS.
      // "Match system" is its own command (Palette, Settings).
      cycleTheme: () =>
        set(() => {
          const shown = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
          const next = shown === 'dark' ? 'light' : 'dark';
          setTheme(next);
          usePrefs.getState().set('appearance', { theme: next });
          return { theme: next };
        }),
      setModel: (modelId) => set((s) => ({ live: { ...s.live, modelId } })),
    }),
    {
      name: 'nvx.ancile.ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        railOpen: s.railOpen,
        drawerOpen: s.drawerOpen,
        drawerTab: s.drawerTab,
        focusMode: s.focusMode,
        live: { ...demo.live, modelId: s.live.modelId },
      }),
    },
  ),
);
