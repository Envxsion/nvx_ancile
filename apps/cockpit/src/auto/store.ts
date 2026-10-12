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
 *           |  An ask marked out_of_plan keeps its plan id, for "Add to
 *           |  plan". The reviewer's status (auto.reviewer on the
 *           |  global stream) goes into the query cache, and a
 *           |  dismissed outage is remembered per outage id.
 *  Note     |  Imports nothing from the app (lib/run.ts imports it).
 *           |  In memory: a reload shows the plan and the waiting
 *           |  approvals from Core, not old badges.
 * ------------------------------------------------------------------
 */

import type { AutoReviewerId, GlobalEvent, ReviewerStatus, RunEvent } from '@nvx/contracts';
import type { QueryClient } from '@tanstack/react-query';
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
  /** An approved plan is in force and this fits none of its steps. */
  outOfPlan: boolean;
  /** That plan, for "Add to plan". */
  planId: string | null;
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
            outOfPlan: e.out_of_plan === true,
            planId: e.plan_id ?? null,
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

/**
 * The batch to show in a thread: the first with an ask still open that has
 * two or more asks, or a step outside your plan (shown even alone).
 */
export function openBatch(batches: Record<string, Batch>, threadId: string): Batch | null {
  return (
    Object.values(batches).find(
      (b) =>
        b.threadId === threadId &&
        (b.items.length >= 2 || b.items.some((i) => i.outOfPlan)) &&
        b.items.some((i) => i.state === 'waiting'),
    ) ?? null
  );
}

/** "1 step outside your plan", "2 steps need you": the batch card's title. */
export function batchTitle(waiting: Pick<BatchItem, 'outOfPlan'>[]): string {
  const n = waiting.length;
  const steps = n === 1 ? 'step' : 'steps';
  if (n > 0 && waiting.every((i) => i.outOfPlan)) return `${n} ${steps} outside your plan`;
  return `${n} ${n === 1 ? 'step needs' : 'steps need'} you`;
}

/* ---- The reviewer's status ------------------------------------------------ */

export const REVIEWER_KEY = ['auto', 'reviewer'] as const;

/** auto.reviewer: the status as it is now, without asking Core again. */
export function onReviewerStatus(e: Extract<GlobalEvent, { type: 'auto.reviewer' }>, qc: QueryClient): void {
  qc.setQueryData<ReviewerStatus>(REVIEWER_KEY, {
    status: e.status,
    outage_id: e.outage_id,
    reason: e.reason,
    local_only: e.local_only,
    since: e.at,
  });
}

const DISMISSED = 'ancile.auto.reviewer-dismissed';

/** The outage you dismissed, if any (per browser; a new outage shows again). */
export function dismissedOutage(): string | null {
  try {
    return localStorage.getItem(DISMISSED);
  } catch {
    return null;
  }
}

export function dismissOutage(id: string): void {
  try {
    localStorage.setItem(DISMISSED, id);
  } catch {
    // Private windows: it shows again next time, which is harmless.
  }
}

/** Why the reviewer is offline, in words, and where to fix it. */
export function reviewerOfflineCopy(s: Pick<ReviewerStatus, 'reason' | 'local_only'>): {
  why: string;
  fix: { label: string; to: string; params?: Record<string, string> };
} {
  switch (s.reason) {
    case 'key_rejected':
      return {
        why: 'The reviewer turned down its key',
        fix: { label: 'Check the key', to: '/settings/$group', params: { group: 'keys' } },
      };
    case 'network':
      return {
        why: "The reviewer can't be reached",
        fix: { label: 'Open health', to: '/admin/$section', params: { section: 'health' } },
      };
    case 'model_not_pulled':
      return {
        why: s.local_only
          ? 'Only a local reviewer may be asked here, and no local model is ready'
          : 'No local model is ready to review',
        fix: { label: 'Set up a local model', to: '/admin/$section', params: { section: 'models' } },
      };
    default:
      return {
        why: 'No reviewer key is saved',
        fix: { label: 'Add a key', to: '/settings/$group', params: { group: 'keys' } },
      };
  }
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
