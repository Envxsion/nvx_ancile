/**
 * ------------------------------------------------------------------
 *  Title    |  Live runs
 *  Ref      |  DESIGN.md §4.1 (run stream)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  While an answer is being written, the message on screen
 *           |  is drawn from its run's event stream, not from the last
 *           |  fetch: text as it arrives, which model is writing, tool
 *           |  steps, a pause for your approval, a fallback.
 *  How      |  One zustand entry per assistant message being written.
 *           |  attachRun() opens /runs/:id/stream (resumable by seq,
 *           |  so a closed laptop or a reload picks up where it left
 *           |  off) and folds each event into that entry. On `done`
 *           |  the thread is refetched and the entry is dropped once
 *           |  the saved message has replaced it.
 * ------------------------------------------------------------------
 */

import { type Part, RunEvent, type RunStatus } from '@nvx/contracts';
import { create } from 'zustand';
import { finishTeam, isFlowEvent, pushFlowEvent } from '../thread/teamworkState';
import { keys } from './data';
import { queryClient } from './query';
import { openStream } from './sse';

export interface LiveTurn {
  runId: string;
  threadId: string;
  messageId: string;
  parts: Part[];
  status: RunStatus;
  modelId: string | null;
  modelName: string | null;
  fallback: { from: string; to: string; reason: string } | null;
  /** The model's GPU node is waking (Phase 5); cleared when an answer starts. */
  waking: {
    nodeId: string;
    modelId: string | null;
    etaS: number | null;
    canUseCloud: boolean;
    detail: string | null;
    since: string;
  } | null;
  /** Waiting on this approval. */
  approvalId: string | null;
  error: { title: string; hint: string } | null;
  done: boolean;
  lastSeq: number;
}

interface RunsState {
  turns: Record<string, LiveTurn>;
  apply: (messageId: string, event: RunEvent) => void;
  start: (t: Pick<LiveTurn, 'runId' | 'threadId' | 'messageId'>) => void;
  drop: (messageId: string) => void;
}

function appendText(parts: Part[], type: 'text' | 'reasoning', delta: string): Part[] {
  const last = parts.at(-1);
  if (last && last.type === type) return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
  return [...parts, type === 'text' ? { type: 'text', text: delta } : { type: 'reasoning', text: delta }];
}

export function fold(t: LiveTurn, e: RunEvent): LiveTurn {
  const next = { ...t, lastSeq: Math.max(t.lastSeq, e.seq) };
  switch (e.type) {
    case 'run.status':
      return { ...next, status: e.status };
    case 'message.snapshot':
      return { ...next, parts: e.parts };
    case 'model':
      return { ...next, modelId: e.model_id, modelName: e.display_name, waking: null };
    case 'text.delta':
      return { ...next, parts: appendText(t.parts, 'text', e.delta), waking: null };
    case 'compute.waiting':
      return {
        ...next,
        waking: {
          nodeId: e.node_id,
          modelId: e.model_id ?? null,
          etaS: e.eta_s,
          canUseCloud: e.can_use_cloud,
          detail: e.detail ?? null,
          since: t.waking?.since ?? e.at,
        },
      };
    case 'reasoning.delta':
      return { ...next, parts: appendText(t.parts, 'reasoning', e.delta) };
    case 'tool.call':
      if (t.parts.some((p) => p.type === 'tool_call' && p.call_id === e.call_id)) return next;
      return {
        ...next,
        parts: [...t.parts, { type: 'tool_call', call_id: e.call_id, tool: e.tool, args: e.args_preview }],
      };
    case 'tool.result': {
      if (t.parts.some((p) => p.type === 'tool_result' && p.call_id === e.call_id)) return next;
      const declined = /^Declined/.test(e.preview);
      return {
        ...next,
        parts: [
          ...t.parts,
          {
            type: 'tool_result',
            call_id: e.call_id,
            ok: e.ok,
            result: e.preview,
            ...(declined && { declined_reason: e.preview.replace(/^Declined:?\s*/, '') }),
          },
        ],
      };
    }
    case 'approval.required':
      return { ...next, approvalId: e.approval_id };
    case 'approval.resolved':
      return { ...next, approvalId: null };
    case 'fallback':
      return { ...next, fallback: { from: e.from_model, to: e.to_model, reason: e.reason }, waking: null };
    case 'error':
      return { ...next, error: { title: e.title, hint: e.hint }, waking: null };
    case 'done':
      return { ...next, done: true, waking: null };
    default:
      return next;
  }
}

export const useRuns = create<RunsState>((set) => ({
  turns: {},
  start: (t) =>
    set((s) =>
      s.turns[t.messageId]
        ? s
        : {
            turns: {
              ...s.turns,
              [t.messageId]: {
                ...t,
                parts: [],
                status: 'queued',
                modelId: null,
                modelName: null,
                fallback: null,
                waking: null,
                approvalId: null,
                error: null,
                done: false,
                lastSeq: 0,
              },
            },
          },
    ),
  apply: (messageId, event) =>
    set((s) => {
      const t = s.turns[messageId];
      return t ? { turns: { ...s.turns, [messageId]: fold(t, event) } } : s;
    }),
  drop: (messageId) =>
    set((s) => {
      const { [messageId]: _gone, ...rest } = s.turns;
      return { turns: rest };
    }),
}));

const open = new Map<string, { threadId: string; close: () => void }>();
/** Streams closed because their thread left the screen, not because they finished. */
const parked = new Set<string>();

/** Attach to a run's stream. Idempotent: a second call for the same message is a no-op. */
export function attachRun(t: { runId: string; threadId: string; messageId: string }): void {
  if (open.has(t.messageId)) return;
  useRuns.getState().start(t);
  const after = useRuns.getState().turns[t.messageId]?.lastSeq ?? 0;
  const close = openStream({
    url: `/api/v1/runs/${t.runId}/stream`,
    schema: RunEvent,
    after,
    onEvent: (e) => {
      // Flow teamwork goes to its own store, batched per frame (Teamwork.tsx).
      if (isFlowEvent(e)) return pushFlowEvent(t.messageId, e);
      if (e.type === 'done') finishTeam(t.messageId, e.at);
      useRuns.getState().apply(t.messageId, e);
      if (e.type === 'approval.required' || e.type === 'approval.resolved') {
        void queryClient.invalidateQueries({ queryKey: keys.approvals });
      }
    },
    isTerminal: (e) => e.type === 'done',
    onState: (state) => {
      if (state !== 'closed') return;
      open.delete(t.messageId);
      if (parked.delete(t.messageId)) return;
      // The saved message replaces the live one: refetch, then let go.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.thread(t.threadId) }),
        queryClient.invalidateQueries({ queryKey: keys.threads }),
      ]).finally(() => useRuns.getState().drop(t.messageId));
    },
  });
  open.set(t.messageId, { threadId: t.threadId, close });
}

/**
 * Leave a thread: close its streams so they stop holding connections (a
 * browser allows six per origin). The live state stays, so coming back
 * re-attaches from the last event seen.
 */
export function detachThread(threadId: string): void {
  for (const [messageId, s] of open) {
    if (s.threadId !== threadId) continue;
    parked.add(messageId);
    s.close();
  }
}

/**
 * Come back to a thread: pick up every turn left unfinished when its stream
 * was let go. The stream resumes after the last event seen, so a run that
 * ended meanwhile delivers its ending at once (without this it read
 * "Thinking" until a reload).
 */
export function resumeThread(threadId: string): void {
  for (const t of Object.values(useRuns.getState().turns)) {
    if (t.threadId !== threadId || t.done || open.has(t.messageId)) continue;
    attachRun({ runId: t.runId, threadId: t.threadId, messageId: t.messageId });
  }
}

export function detachAll(): void {
  for (const s of open.values()) s.close();
  open.clear();
}

export function useLiveTurn(messageId: string | undefined): LiveTurn | undefined {
  return useRuns((s) => (messageId ? s.turns[messageId] : undefined));
}

/** Any run in this thread still writing or waiting. */
export function useThreadBusy(threadId: string): LiveTurn | undefined {
  return useRuns((s) => Object.values(s.turns).find((t) => t.threadId === threadId && !t.done));
}
