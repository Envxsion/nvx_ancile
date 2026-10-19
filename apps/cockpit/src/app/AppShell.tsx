/**
 * ------------------------------------------------------------------
 *  Title    |  App shell
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The frame every screen lives in: titlebar, rail, the
 *           |  work, the contextual drawer, the status bar, and the
 *           |  layers above them (palette, guide, tours, dialogs,
 *           |  toasts).
 *  How      |  Grid layout; the rail and drawer collapse to zero
 *           |  columns, or become overlay sheets on narrow screens.
 *           |  Widths come from preferences. Focus mode hides both.
 *  Note     |  /setup renders bare: first run should feel like a
 *           |  welcome, not like the app with its furniture missing.
 * ------------------------------------------------------------------
 */

import { watchSystemTheme } from '@nvx/aperture';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { type CSSProperties, useEffect } from 'react';
import { command } from '../desktop/api';
import { installKeys, useBinding } from '../keys/dispatch';
import { useConnection } from '../lib/connection';
import { useApprovals, useNotebooks, useSetup, useThread, useThreads } from '../lib/data';
import { useGlobalEvents } from '../lib/events';
import { useRuns } from '../lib/run';
import { isDesktop } from '../lib/runtime';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useModelChangeToasts } from '../models/watch';
import { Toaster } from '../notify/Toaster';
import { BeamHost } from '../pro/beam';
import { EditionSync } from '../pro/edition';
import { SignInGate, useSignInGate } from '../pro/gate';
import { adminLabel } from '../routes/admin/labels';
import { ConnectionBanner } from '../shell/ConnectionBanner';
import { Drawer } from '../shell/Drawer';
import { Rail } from '../shell/Rail';
import { StatusBar } from '../shell/StatusBar';
import { Titlebar } from '../shell/Titlebar';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { lazyHost } from '../ui/lazyHost';
import { Runtime } from './Runtime';

// Overlays and panels draw nothing until opened, so they load after the shell (ROADMAP P1).
const ActivityHost = lazyHost(() => import('../activity/ActivityPanel'), 'ActivityHost');
const ApprovalDialog = lazyHost(() => import('../approvals/ApprovalDialog'), 'ApprovalDialog');
const ArtifactPanel = lazyHost(() => import('../artifacts/ArtifactPanel'), 'ArtifactPanel');
const ClaudeCodeSessionsHost = lazyHost(
  () => import('../claudecode/SessionsDialog'),
  'ClaudeCodeSessionsHost',
);
const FileEditorHost = lazyHost(() => import('../code/FileEditorHost'), 'FileEditorHost');
const WhatChangedHost = lazyHost(() => import('../desktop/WhatChanged'), 'WhatChangedHost');
const EditorsHost = lazyHost(() => import('../editors/EditorsHost'), 'EditorsHost');
const HelpCentre = lazyHost(() => import('../help/HelpCentre'), 'HelpCentre');
const TourOverlay = lazyHost(() => import('../help/TourOverlay'), 'TourOverlay');
const ShortcutsOverlay = lazyHost(() => import('../keys/ShortcutsOverlay'), 'ShortcutsOverlay');
const Center = lazyHost(() => import('../notify/Center'), 'Center');
const Palette = lazyHost(() => import('../palette/Palette'), 'Palette');

/** A thread's crumbs: its notebook, then its title, from the list or else the open thread itself. */
export function threadCrumbs(
  id: string | undefined,
  listed: { id: string; title: string; notebookId: string | null }[] | undefined,
  open: { title: string; notebookId: string | null } | undefined,
  notebooks: { id: string; title: string }[] | undefined,
): { label: string; to?: string }[] {
  // A thread opened from a link or Activity may not be in the sidebar's list.
  const t = listed?.find((x) => x.id === id) ?? open;
  const nb = notebooks?.find((n) => n.id === t?.notebookId);
  return [...(nb ? [{ label: nb.title, to: `/n/${nb.id}` }] : []), { label: t?.title || 'Thread' }];
}

function useCrumbs(pathname: string): { label: string; to?: string }[] {
  const threads = useThreads();
  const notebooks = useNotebooks();
  const [, kind, id] = pathname.split('/');
  const open = useThread(kind === 't' ? id : undefined);
  if (kind === 't') return threadCrumbs(id, threads.data, open.data, notebooks.data);
  if (kind === 'n') return [{ label: notebooks.data?.find((n) => n.id === id)?.title ?? 'Notebook' }];
  if (kind === 'settings') return [{ label: 'Settings' }];
  if (kind === 'admin') return [{ label: 'Admin', to: '/admin/health' }, { label: adminLabel(id) }];
  return [];
}

/**
 * The mark says what NVX Ancile is doing: asking when a decision waits,
 * streaming while an answer is written, thinking before the first word,
 * grey when Core is not answering.
 */
function useMarkState(pendingApprovals: number) {
  // A primitive, not an array: zustand compares selector results by reference.
  const writing = useRuns((s) => {
    const live = Object.values(s.turns).filter((t) => !t.done);
    return live.some((t) => t.parts.length > 0) ? 'streaming' : live.length ? 'thinking' : 'idle';
  });
  const offline = useConnection((s) => s.status === 'offline');
  const state = offline ? 'offline' : pendingApprovals > 0 ? 'ask' : writing;
  useEffect(() => {
    if (useUi.getState().mark !== state) useUi.getState().setMark(state);
  }, [state]);
}

/**
 * The dialog shows one request and stays on it. Opened without a target,
 * it locks onto the one for this screen; if that request is answered
 * somewhere else while the dialog is open, it closes and says so, rather
 * than slide another thread's question under your cursor.
 */
function useApprovalFocus(pending: ReturnType<typeof useApprovals>, onScreen: string | undefined) {
  const open = useUi((s) => s.approvalOpen);
  const focus = useUi((s) => s.approvalFocus);
  const list = pending.data ?? [];
  const focused = focus ? list.find((a) => a.id === focus) : undefined;
  const fallback = list.find((a) => a.threadId === onScreen) ?? list[0];

  useEffect(() => {
    if (open && !focus && fallback) useUi.getState().setApproval(true, fallback.id);
  }, [open, focus, fallback]);

  const { refetch, isFetching } = pending;
  const missing = open && !!focus && !focused;
  useEffect(() => {
    if (missing) void refetch();
  }, [missing, refetch]);
  useEffect(() => {
    if (missing && !isFetching && pending.isFetched) {
      useUi.getState().setApproval(false);
      notify({ level: 'info', title: 'That request was answered elsewhere', body: 'Nothing else changed.' });
    }
  }, [missing, isFetching, pending.isFetched]);

  return focus ? focused : fallback;
}

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const railOpen = useUi((s) => s.railOpen);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const focusMode = useUi((s) => s.focusMode);
  const railWidth = usePrefs((s) => s.prefs.layout.railWidth);
  const drawerWidth = usePrefs((s) => s.prefs.layout.drawerWidth);
  const narrow = useMediaQuery('(max-width: 820px)');
  const crumbs = useCrumbs(pathname);
  // The flow editor is a full-width canvas with its own side panel: no drawer.
  const contextual =
    (pathname.startsWith('/t/') || pathname.startsWith('/n/')) && !/^\/n\/[^/]+\/flow/.test(pathname);

  // First run: open onboarding once per session until it is finished.
  const setup = useSetup();
  useEffect(() => {
    if (!setup.data || setup.data.complete || pathname.startsWith('/setup')) return;
    try {
      if (sessionStorage.getItem('nvx.ancile.setup-offered')) return;
      sessionStorage.setItem('nvx.ancile.setup-offered', '1');
    } catch {
      /* storage blocked: offer it anyway */
    }
    void navigate({ to: '/setup' });
  }, [setup.data, pathname, navigate]);

  const approvals = useApprovals();
  const onScreen = pathname.startsWith('/t/') ? pathname.split('/')[2] : undefined;
  const current = useApprovalFocus(approvals, onScreen);
  // Settings → Usage shows the context of the thread you came from.
  useEffect(() => {
    if (onScreen) useUi.getState().setLastThread(onScreen);
  }, [onScreen]);
  useGlobalEvents();
  useModelChangeToasts();
  useMarkState(approvals.data?.length ?? 0);

  useEffect(() => installKeys(), []);
  useEffect(() => watchSystemTheme(), []);

  useBinding('shortcuts.show', () => useUi.getState().setShortcuts(true));
  // The desktop app has no browser around it: Ctrl+Q asks the shell to quit (after it checks for live runs).
  useBinding('app.quit', () => void command('quit').catch(() => undefined), isDesktop());
  useBinding('center.open', () => useUi.getState().setCenter(true));
  // On a phone the open rail is a sheet: Esc puts it away, like any other.
  useBinding('layer.close', () => useUi.getState().toggleRail(), narrow && railOpen);
  useBinding('thread.new', () => navigate({ to: '/' }));
  useBinding('go.admin', () => navigate({ to: '/admin/$section', params: { section: 'health' } }));
  useBinding('go.logs', () => navigate({ to: '/admin/$section', params: { section: 'logs' } }));
  useBinding('go.flows', () => navigate({ to: '/flows' }));
  useBinding('go.automations', () => navigate({ to: '/admin/$section', params: { section: 'automations' } }));
  const signInNeeded = useSignInGate((s) => s.needed);

  if (signInNeeded) {
    return (
      <>
        <Runtime />
        <EditionSync />
        <SignInGate />
        <Toaster />
      </>
    );
  }

  if (pathname.startsWith('/setup')) {
    return (
      <>
        <Runtime />
        <EditionSync />
        <Outlet />
        <Toaster />
      </>
    );
  }

  return (
    <div
      className="shell"
      data-rail={railOpen && !focusMode}
      data-drawer={contextual && drawerOpen && !focusMode}
      data-contextual={contextual || undefined}
      data-focus-mode={focusMode || undefined}
      style={{ '--rail-w': `${railWidth}px`, '--drawer-w': `${drawerWidth}px` } as CSSProperties}
    >
      <Runtime />
      <EditionSync />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Titlebar crumbs={crumbs} />
      <Rail />
      {narrow && railOpen ? (
        <button
          type="button"
          className="sheet-scrim sheet-scrim--rail"
          aria-label="Close the sidebar"
          onClick={() => useUi.getState().toggleRail()}
        />
      ) : null}
      <main id="main" className="shell__main" tabIndex={-1}>
        <ConnectionBanner />
        <Outlet />
      </main>
      {contextual ? <Drawer /> : null}
      <StatusBar />

      <Palette />
      <ShortcutsOverlay />
      {current ? <ApprovalDialog key={current.id} approval={current} /> : null}
      <Center />
      <WhatChangedHost />
      <HelpCentre />
      <TourOverlay />
      <BeamHost />
      <ClaudeCodeSessionsHost />
      <ActivityHost />
      <EditorsHost />
      <FileEditorHost />
      <ArtifactPanel />
      <Toaster />
    </div>
  );
}
