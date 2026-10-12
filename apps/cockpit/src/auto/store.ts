/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode: what the thread heard
 *  Ref      |  docs/auto-mode.md · packages/contracts/src/auto.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Keep what Auto mode said during a run long enough to
 *           |  show it: which tool calls ran without asking (and who
 *           |  checked them), the asks it grouped into one batch, and
 *           |  which plan steps have been used.
 *  How      |  lib/run.ts hands every run event to noteAutoEvent().
 *           |  auto.ran marks a call; approval.batched opens or grows
 *           |  a batch, and the approval.required that follows gives
 *           |  the item its approval id; approval.resolved closes it.
 *           |  plan.changed bumps a counter the plan query listens to.
 *  Note     |  Imports nothing from the app (lib/run.ts imports it).
 *           |  In memory: a reload shows the plan and the waiting
 *           |  approvals from Core, not old badges.
 * ------------------------------------------------------------------
 */

import type { AutoReviewerId, RunEvent } from '@nvx/contracts';
import { create } from 'zustand';

export interface AutoMark {
  action: string;
  via: 'plan' | 'cache' | 'reviewer' | 'rules';
  reviewer: AutoReviewerId | null;
}

export interface BatchItem {
  /** The tool call it is about, when the event named one. */
  callId: string | null;
  action: string;
  via: 'floor' | 'reviewer' | 'rules';
  /** Why it asks, in a sentence. */
  reason: string;
  /** Set when its approval.required arrives; answering needs it. */
  approvalId: string | null;
  resource: string | null;
  tool: string | null;
  state: 'waiting' | 'allowed' | 'denied' | 'gone';
}

export interface Batch {
  id: string;
  threadId: string;
  runId: string;
  items: BatchItem[];
}

interface AutoState {
  marks: Record<string, AutoMark>;
  /** Actions that ran under the approved plan, per thread (for "2 of 5 steps"). */
  planRan: Record<string, string[]>;
  batches: Record<string, Batch>;
  /** Bumped by plan.changed, per thread: the plan query refetches on it. */
  planTick: Record<string, number>;
  note: (threadId: string, runId: string, e: RunEvent) => void;
  settle: (approvalIds: string[], state: BatchItem['state']) => void;
}

export const useAuto = create<AutoState>((set) => ({
  marks: {},
  planRan: {},
  batches: {},
  planTick: {},
  note: (threadId, runId, e) =>
    set((s) => {
      switch (e.type) {
        case 'auto.ran': {
          const marks = e.call_id
            ? { ...s.marks, [e.call_id]: { action: e.action, via: e.via, reviewer: e.reviewer } }
            : s.marks;
          const planRan =
            e.via === 'plan'
              ? { ...s.planRan, [threadId]: [...(s.planRan[threadId] ?? []), e.action] }
              : s.planRan;
          return { marks, planRan };
        }
        case 'approval.batched': {
          const b = s.batches[e.batch_id] ?? { id: e.batch_id, threadId, runId, items: [] };
          if (e.call_id && b.items.some((i) => i.callId === e.call_id)) return s;
          const item: BatchItem = {
            callId: e.call_id ?? null,
            action: e.action,
            via: e.via,
            reason: e.reason,
            approvalId: null,
            resource: null,
            tool: null,
            state: 'waiting',
          };
          return { batches: { ...s.batches, [e.batch_id]: { ...b, items: [...b.items, item] } } };
        }
        case 'approval.required': {
          // The batched ask it follows: same call, else the run's latest unnamed one for this action.
          for (const b of Object.values(s.batches)) {
            if (b.runId !== runId) continue;
            const at = e.call_id
              ? b.items.findIndex((i) => i.callId === e.call_id)
              : b.items.findLastIndex((i) => !i.approvalId && i.action === e.action);
            if (at < 0) continue;
            const items = b.items.map((i, n) =>
              n === at ? { ...i, approvalId: e.approval_id, resource: e.resource, tool: e.tool } : i,
            );
            return { batches: { ...s.batches, [b.id]: { ...b, items } } };
          }
          return s;
        }
        case 'approval.resolved':
          return settled(s.batches, [e.approval_id], (i) => (i.state === 'waiting' ? 'gone' : i.state));
        case 'plan.changed':
          return { planTick: { ...s.planTick, [threadId]: (s.planTick[threadId] ?? 0) + 1 } };
        default:
          return s;
      }
    }),
  settle: (ids, state) => set((s) => settled(s.batches, ids, () => state)),
}));

function settled(
  batches: Record<string, Batch>,
  ids: string[],
  next: (i: BatchItem) => BatchItem['state'],
): { batches: Record<string, Batch> } {
  const want = new Set(ids);
  const out: Record<string, Batch> = {};
  for (const [k, b] of Object.entries(batches))
    out[k] = {
      ...b,
      items: b.items.map((i) => (i.approvalId && want.has(i.approvalId) ? { ...i, state: next(i) } : i)),
    };
  return { batches: out };
}

export function noteAutoEvent(threadId: string, runId: string, e: RunEvent): void {
  if (
    e.type === 'auto.ran' ||
    e.type === 'approval.batched' ||
    e.type === 'approval.required' ||
    e.type === 'approval.resolved' ||
    e.type === 'plan.changed'
  )
    useAuto.getState().note(threadId, runId, e);
}

/** The batch to show in a thread: the first with two or more asks, one still open. */
export function openBatch(batches: Record<string, Batch>, threadId: string): Batch | null {
  return (
    Object.values(batches).find(
      (b) => b.threadId === threadId && b.items.length >= 2 && b.items.some((i) => i.state === 'waiting'),
    ) ?? null
  );
}

const REVIEWER: Record<AutoReviewerId, string> = {
  jev_openrouter: 'Jev',
  jev_direct: 'Jev',
  local_model: 'a local model',
  rules: 'the rules',
  fake: 'a test reviewer',
};

/** The badge's hover: who checked it and why it ran ("Checked by Jev: fits the task"). */
export function autoWhy(m: AutoMark): string {
  switch (m.via) {
    case 'plan':
      return 'Fits the plan you approved';
    case 'cache':
      return 'Like a step checked earlier in this session';
    case 'rules':
      return 'A routine step, by the rules';
    default:
      return `Checked by ${m.reviewer ? REVIEWER[m.reviewer] : 'the reviewer'}: fits the task`;
  }
}
