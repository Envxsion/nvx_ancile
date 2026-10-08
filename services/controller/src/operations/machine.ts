/**
 * ------------------------------------------------------------------
 *  Title    |  The confirmation chain
 *  Ref      |  DESIGN.md §13.3, §3.3 (operations), contracts/controller.ts
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Every action on a node walks a visible chain:
 *           |  requested → acknowledged → in progress → confirmed,
 *           |  or stops at failed / timed out with the provider's own
 *           |  words and a suggested fix.
 *  How      |  Pure functions over an immutable Operation. The executor
 *           |  feeds them events; the UI renders the timeline as-is.
 *           |  Skipped links (a provider that confirms instantly) are
 *           |  filled in as "implied" so the chain always reads whole.
 *  Note     |  Idempotency: the same key + same node + same action
 *           |  replays the existing operation; the same key for a
 *           |  different request is a conflict, never a second action.
 * ------------------------------------------------------------------
 */

import type { OperationStatus } from '@nvx/contracts';
import type { NodeAction, NodeState, Operation } from '@nvx/contracts/controller';

type OperationError = NonNullable<Operation['error']>;
type OpAction = Operation['action'];

export const CHAIN: readonly OperationStatus[] = ['requested', 'acknowledged', 'in_progress', 'confirmed'];
export const TERMINAL: ReadonlySet<OperationStatus> = new Set(['confirmed', 'failed', 'timed_out']);

/** How long an operation may sit in each live state before it times out. */
export const DEFAULT_BUDGETS_MS: Record<'requested' | 'acknowledged' | 'in_progress', number> = {
  requested: 30_000,
  acknowledged: 60_000,
  // Starting a GPU pod can include pulling a large image.
  in_progress: 15 * 60_000,
};

export class InvalidTransition extends Error {
  constructor(
    readonly from: OperationStatus,
    readonly to: OperationStatus,
  ) {
    super(`operation cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransition';
  }
}

export function isTerminal(status: OperationStatus): boolean {
  return TERMINAL.has(status);
}

export function createOperation(init: {
  id: string;
  nodeId: string;
  action: OpAction;
  requestedBy: string;
  reason?: string | null;
  traceId: string;
  now: Date;
  detail?: string;
}): Operation {
  const at = init.now.toISOString();
  return {
    id: init.id,
    node_id: init.nodeId,
    action: init.action,
    status: 'requested',
    timeline: [{ status: 'requested', at, detail: init.detail ?? `${label(init.action)} requested` }],
    requested_by: init.requestedBy,
    reason: init.reason ?? null,
    error: null,
    trace_id: init.traceId,
    created_at: at,
    updated_at: at,
  };
}

/**
 * Move an operation forward. Forward jumps along the chain fill the skipped
 * links as implied; failure and timeout may happen from any live state.
 */
export function advance(
  op: Operation,
  to: OperationStatus,
  detail: string,
  now: Date,
  error: OperationError | null = null,
): Operation {
  if (isTerminal(op.status)) throw new InvalidTransition(op.status, to);
  if (to === op.status) {
    // Same-state progress note (e.g. "pulling image 40%"): append, don't transition.
    return withStep(op, to, detail, now);
  }
  if (to === 'failed' || to === 'timed_out') {
    if (to === 'failed' && !error) throw new Error('a failed operation needs an error with a suggestion');
    return { ...withStep(op, to, detail, now), status: to, error };
  }
  const from = CHAIN.indexOf(op.status);
  const target = CHAIN.indexOf(to);
  if (target <= from) throw new InvalidTransition(op.status, to);
  let next = op;
  for (let i = from + 1; i < target; i++) {
    const skipped = CHAIN[i] as OperationStatus;
    next = withStep(
      next,
      skipped,
      `${humanStatus(skipped)} (implied: the provider went straight to the next step)`,
      now,
    );
  }
  return { ...withStep(next, to, detail, now), status: to };
}

/** Times out a live operation that has outstayed its current state's budget. */
export function checkTimeout(
  op: Operation,
  now: Date,
  budgets: Record<'requested' | 'acknowledged' | 'in_progress', number> = DEFAULT_BUDGETS_MS,
): Operation {
  if (isTerminal(op.status)) return op;
  const since = Date.parse(lastEntered(op).at);
  const budget = budgets[op.status as keyof typeof budgets];
  if (now.getTime() - since <= budget) return op;
  const minutes = Math.round(budget / 60_000);
  return advance(
    op,
    'timed_out',
    `No progress after ${minutes < 1 ? `${Math.round(budget / 1000)} s` : `${minutes} min`} in "${humanStatus(op.status)}". The node's real state will be re-read before anything else happens.`,
    now,
  );
}

export type IdempotencyResult =
  | { kind: 'new' }
  | { kind: 'replay'; op: Operation }
  | { kind: 'conflict'; op: Operation };

export function resolveIdempotency(
  existing: Operation | undefined,
  nodeId: string,
  action: OpAction,
): IdempotencyResult {
  if (!existing) return { kind: 'new' };
  if (existing.node_id === nodeId && existing.action === action) return { kind: 'replay', op: existing };
  return { kind: 'conflict', op: existing };
}

/** The state an action is trying to reach, used to confirm completion. */
export function targetState(action: NodeAction): NodeState {
  switch (action) {
    case 'start':
    case 'restart':
      return 'running';
    case 'stop':
      return 'stopped';
    case 'terminate':
      return 'terminated';
  }
}

export type Precheck = { ok: true; noop: boolean; detail: string } | { ok: false; error: OperationError };

/**
 * Decide before calling the provider whether an action makes sense now.
 * Asking to start a running node is a no-op that confirms immediately,
 * not an error: the user's intent is already true.
 */
export function precheck(action: NodeAction, state: NodeState, hasLiveOperation: boolean): Precheck {
  if (hasLiveOperation) {
    return {
      ok: false,
      error: {
        code: 'operation_in_progress',
        provider_message: 'Another operation on this node has not finished.',
        suggestion: 'Wait for it to confirm or time out, then try again.',
      },
    };
  }
  if (state === 'terminated' || state === 'terminating') {
    return {
      ok: false,
      error: {
        code: 'node_terminated',
        provider_message: 'This node has been terminated.',
        suggestion: 'Create a new node from the same template; terminated pods cannot be restarted.',
      },
    };
  }
  if (
    (action === 'start' && (state === 'running' || state === 'starting')) ||
    (action === 'stop' && (state === 'stopped' || state === 'stopping'))
  ) {
    return { ok: true, noop: true, detail: `The node is already ${state}.` };
  }
  if (action === 'restart' && state !== 'running') {
    return { ok: true, noop: false, detail: 'The node is not running, so restart will start it.' };
  }
  return { ok: true, noop: false, detail: `${label(action)} accepted for a ${state} node.` };
}

function withStep(op: Operation, status: OperationStatus, detail: string, now: Date): Operation {
  const at = now.toISOString();
  return { ...op, timeline: [...op.timeline, { status, at, detail }], updated_at: at };
}

function lastEntered(op: Operation) {
  for (let i = op.timeline.length - 1; i >= 0; i--) {
    const step = op.timeline[i];
    if (step && step.status === op.status && (i === 0 || op.timeline[i - 1]?.status !== op.status))
      return step;
  }
  return op.timeline[op.timeline.length - 1] ?? { status: op.status, at: op.updated_at, detail: '' };
}

function label(action: OpAction): string {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

export function humanStatus(s: OperationStatus): string {
  return {
    requested: 'Requested',
    acknowledged: 'Acknowledged',
    in_progress: 'In progress',
    confirmed: 'Confirmed',
    failed: 'Failed',
    timed_out: 'Timed out',
  }[s];
}
