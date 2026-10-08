/**
 * ------------------------------------------------------------------
 *  Title    |  Run state machine
 *  Ref      |  DESIGN.md §5.5, §7.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every run (a chat turn, an agent, a fact-check) moves
 *           |  through one table of legal transitions. Pausing for an
 *           |  approval or a waking GPU node releases the worker; the
 *           |  run goes back to `queued` when it can continue, and any
 *           |  worker can pick it up from its checkpoint.
 *  How      |  transition() is pure: illegal moves throw, so a bug in
 *           |  the engine fails loudly instead of corrupting a run.
 * ------------------------------------------------------------------
 */

import type { RunStatus } from '@nvx/contracts';

export type RunEventKind =
  | 'start'
  | 'need_approval'
  | 'need_compute'
  | 'resume'
  | 'complete'
  | 'fail'
  | 'cancel'
  | 'lease_expired';

export const TERMINAL: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled']);

const TABLE: Record<RunEventKind, Partial<Record<RunStatus, RunStatus>>> = {
  start: { queued: 'running' },
  need_approval: { running: 'waiting_approval' },
  need_compute: { running: 'waiting_compute' },
  // An approval decision, a node coming up, or a compute deadline passing
  // (the run then falls back) all put the run back in the queue.
  resume: { waiting_approval: 'queued', waiting_compute: 'queued' },
  complete: { running: 'succeeded' },
  fail: { running: 'failed', queued: 'failed', waiting_compute: 'failed', waiting_approval: 'failed' },
  cancel: {
    queued: 'cancelled',
    running: 'cancelled',
    waiting_approval: 'cancelled',
    waiting_compute: 'cancelled',
  },
  lease_expired: { running: 'queued' },
};

export class IllegalTransition extends Error {
  constructor(
    readonly from: RunStatus,
    readonly event: RunEventKind,
  ) {
    super(`A run that is ${from} cannot ${event.replace('_', ' ')}`);
    this.name = 'IllegalTransition';
  }
}

export interface RunMachineState {
  status: RunStatus;
  attempt: number;
}

export function transition(
  state: RunMachineState,
  event: RunEventKind,
  opts: { maxAttempts?: number } = {},
): RunMachineState {
  const to = TABLE[event][state.status];
  if (!to) throw new IllegalTransition(state.status, event);
  if (event === 'lease_expired') {
    const attempt = state.attempt + 1;
    // A run that keeps killing its worker is not retried forever.
    if (attempt >= (opts.maxAttempts ?? 5)) return { status: 'failed', attempt };
    return { status: to, attempt };
  }
  return { status: to, attempt: state.attempt };
}

export function canTransition(status: RunStatus, event: RunEventKind): boolean {
  return TABLE[event][status] !== undefined;
}
