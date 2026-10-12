/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: per-thread composer state
 *  Ref      |  docs/claude-code.md (Live sessions)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the composer of a Claude Code thread remembers
 *           |  between sends: the model and effort chosen for the next
 *           |  turn, the one notice above the composer (busy elsewhere,
 *           |  signed out, a restart during a turn), a message queued
 *           |  behind the running turn, and which picker or popover a
 *           |  "/" command asked to open.
 *  How      |  One small Zustand store keyed by thread id. It imports
 *           |  nothing else from the app, so lib/run.ts can report a
 *           |  run's warning here without an import cycle.
 *  Note     |  In memory only: a reload starts from Claude Code's own
 *           |  live state (GET /claude-code/threads/:id/live).
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';

/** Claude Code's effort levels; "auto" leaves the choice to Claude Code. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
export type Effort = (typeof EFFORTS)[number];

export const isEffort = (v: unknown): v is Effort =>
  typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

/** What a send that Claude Code refused needs to be tried again. */
export interface CcRetry {
  text: string;
  parentId: string | null;
  sourceIds?: string[];
}

export type CcNotice =
  | { kind: 'busy'; retry: CcRetry }
  | { kind: 'signed_out' | 'not_installed' | 'unverified'; title: string; hint: string }
  | { kind: 'recovered' }
  /** The session's folder moved or was deleted; `retry` is the message that was not sent. */
  | { kind: 'folder_missing'; cwd: string | null; retry: CcRetry | null }
  | { kind: 'unsupported'; name: string; description: string };

export interface CcThreadState {
  /** Chosen for the next send; null: what the session already uses. */
  model: string | null;
  /**
   * Another model answering this thread's turns instead of Claude Code
   * (docs/engines.md): any gateway model. null: Claude Code answers. The
   * thread keeps its session either way.
   */
  other: { id: string; name: string } | null;
  effort: Effort | null;
  notice: CcNotice | null;
  /** One message waiting for the running turn to end. */
  queued: { text: string; sourceIds?: string[] } | null;
  /** A "/" command asked for this picker to open. */
  picker: 'model' | 'effort' | null;
  usageOpen: boolean;
  /** "/branch": the next message forks the session even from its latest message. */
  forkNext: boolean;
}

export const CC_EMPTY: CcThreadState = {
  model: null,
  other: null,
  effort: null,
  notice: null,
  queued: null,
  picker: null,
  usageOpen: false,
  forkNext: false,
};

interface CcStore {
  byThread: Record<string, CcThreadState>;
  patch: (threadId: string, p: Partial<CcThreadState>) => void;
}

export const useCcStore = create<CcStore>((set) => ({
  byThread: {},
  patch: (threadId, p) =>
    set((s) => ({
      byThread: { ...s.byThread, [threadId]: { ...(s.byThread[threadId] ?? CC_EMPTY), ...p } },
    })),
}));

export function useCcThread(threadId: string): CcThreadState {
  return useCcStore((s) => s.byThread[threadId] ?? CC_EMPTY);
}

export function patchCc(threadId: string, p: Partial<CcThreadState>): void {
  useCcStore.getState().patch(threadId, p);
}

/** A run's `warning` event (lib/run.ts): a restart during a Claude Code turn says so here. */
export function noteRunWarning(threadId: string, code: string): void {
  if (code === 'claude_code.recovered') patchCc(threadId, { notice: { kind: 'recovered' } });
}
