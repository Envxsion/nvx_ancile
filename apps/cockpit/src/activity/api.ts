/**
 * ------------------------------------------------------------------
 *  Title    |  Activity: data
 *  Ref      |  packages/contracts/src/activity.ts · docs/activity.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What is running, for the status bar's count and the
 *           |  Activity panel, and the typing hint that makes a
 *           |  background import wait.
 *  How      |  GET /activity through React Query. `activity.changed`
 *           |  sets the running count at once and refetches the list;
 *           |  while the panel is open and something runs, the list
 *           |  is fetched again every few seconds (live progress). The
 *           |  panel's open state is a small store of its own.
 *  Note     |  Typing hints go only while an import runs, at most one
 *           |  every TYPING_EVERY_MS, and never say what was typed.
 * ------------------------------------------------------------------
 */

import type { ActivityItem, ActivityResponse, GlobalEvent } from '@nvx/contracts';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { useImportProgress } from '../claudecode/api';
import { api } from '../lib/api';
import { useUi } from '../state/ui';
import { demoActivity } from './demo';

export const ACTIVITY_KEY = ['activity'] as const;
/** While the panel is open and something runs. */
export const LIVE_POLL_MS = 3_000;
/** At most one typing hint this often. */
export const TYPING_EVERY_MS = 1_500;

interface ActivityPanelState {
  open: boolean;
  /** The running count, as the last event or answer said. */
  running: number;
  setOpen: (open: boolean) => void;
  setRunning: (n: number) => void;
}

export const useActivityPanel = create<ActivityPanelState>((set) => ({
  open: false,
  running: 0,
  setOpen: (open) => set({ open }),
  setRunning: (running) => set({ running }),
}));

export const openActivity = () => useActivityPanel.getState().setOpen(true);

export function useActivity(opts: { enabled?: boolean } = {}) {
  const demo = useUi((s) => s.demo);
  const open = useActivityPanel((s) => s.open);
  return useQuery({
    queryKey: [...ACTIVITY_KEY, demo ? 'demo' : 'live'],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const r = demo ? demoActivity() : await api.get<ActivityResponse>('/activity');
      useActivityPanel.getState().setRunning(r.running);
      if (r.import) useImportProgress.getState().setProgress(r.import);
      return r;
    },
    staleTime: 5_000,
    refetchInterval: (q) => (open && (q.state.data?.running ?? 0) > 0 ? LIVE_POLL_MS : false),
  });
}

/**
 * A shell Claude Code started in the background: its launch answers at
 * once, so the call's own result says nothing about the shell. Its state
 * is Activity's: null until Activity has loaded, 'gone' when it no
 * longer lists it (it ended a while ago).
 */
export function useBackgroundShell(callId: string, enabled: boolean): ActivityItem['state'] | 'gone' | null {
  const q = useActivity({ enabled });
  if (!enabled || !q.data) return null;
  const item = q.data.items.find((i) => i.kind === 'shell' && i.id.endsWith(`:${callId}`));
  return item?.state ?? 'gone';
}

type ActivityChanged = Extract<GlobalEvent, { type: 'activity.changed' }>;

export function onActivityChanged(e: ActivityChanged, qc: QueryClient): void {
  useActivityPanel.getState().setRunning(e.running);
  void qc.invalidateQueries({ queryKey: ACTIVITY_KEY });
}

/* ---- Grouping and words --------------------------------------------------- */

export type ActivityGroup = 'ancile' | 'elsewhere' | 'subagents' | 'shells';

export const GROUP_TITLES: Record<ActivityGroup, string> = {
  ancile: 'In NVX Ancile',
  elsewhere: 'Claude Code elsewhere',
  subagents: 'Subagents',
  shells: 'Background shells',
};

export function groupOf(i: ActivityItem): ActivityGroup {
  return i.kind === 'run'
    ? 'ancile'
    : i.kind === 'claude_session'
      ? 'elsewhere'
      : i.kind === 'subagent'
        ? 'subagents'
        : 'shells';
}

/** Rows by group, in the panel's order, empty groups left out. */
export function grouped(items: ActivityItem[]): { group: ActivityGroup; items: ActivityItem[] }[] {
  const order: ActivityGroup[] = ['ancile', 'elsewhere', 'subagents', 'shells'];
  return order
    .map((group) => ({ group, items: items.filter((i) => groupOf(i) === group) }))
    .filter((g) => g.items.length > 0);
}

/** "12 s", "4 min", "2 h 5 min": how long since `iso`. */
export function since(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return null;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** The state chip's words. */
export function stateLabel(i: ActivityItem): string {
  if (i.kind === 'run' && i.run_status === 'waiting_approval') return 'Needs you';
  if (i.state === 'waiting') return 'Waiting';
  if (i.state === 'finished') return 'Finished';
  if (i.state === 'failed') return 'Failed';
  if (i.state === 'stopped') return 'Stopped';
  if (i.kind === 'claude_session') return i.held === 'terminal' ? 'Open' : 'Active';
  return 'Running';
}

/* ---- Typing hints ----------------------------------------------------------- */

let lastHint = 0;

/** The person typed something: while an import runs, ask Core to wait a moment. */
export function noteTyping(now = Date.now()): void {
  if (useUi.getState().demo) return;
  if (!useImportProgress.getState().progress) return;
  if (now - lastHint < TYPING_EVERY_MS) return;
  lastHint = now;
  void api.post('/activity/typing', { ms: 2_500 }).catch(() => undefined);
}

/** Reset between tests. */
export function resetTypingHint(): void {
  lastHint = 0;
}
