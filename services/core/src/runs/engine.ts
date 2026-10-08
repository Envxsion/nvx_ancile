/**
 * ------------------------------------------------------------------
 *  Title    |  Run engine: records and contracts
 *  Ref      |  DESIGN.md §5.5, §7.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Execute runs so that a crash, a restart or a pause for
 *           |  approval never loses or repeats work.
 *  How      |  - claim(): take a queued run with a lease (SELECT … FOR
 *           |    UPDATE SKIP LOCKED), renewed every 10 s (worker.ts).
 *           |  - a handler runs the whole run, saving its checkpoint at
 *           |    each boundary; side-effecting steps (tool calls) are
 *           |    recorded in run_steps under a deterministic key and
 *           |    replayed from there, never executed twice.
 *           |  - a step that needs a person returns `pause`: the run
 *           |    moves to waiting_approval and releases its lease.
 *           |  - the sweeper reclaims runs whose lease lapsed.
 *           |  - every status write is a compare-and-set on the status
 *           |    (and lease owner) the writer last saw, so a cancel, a
 *           |    sweep and a worker can never overwrite each other.
 * ------------------------------------------------------------------
 */

import { AncileError, type RunStatus } from '@nvx/contracts';
import type { RunEventLog } from './events';
import { type RunEventKind, transition } from './machine';

export type RunKind =
  | 'chat_turn'
  | 'agent'
  | 'research'
  | 'factcheck'
  | 'automation'
  | 'diagnostic'
  | 'flow_try';

export interface RunRecord {
  id: string;
  kind: RunKind;
  status: RunStatus;
  attempt: number;
  stepCursor: number;
  checkpoint: unknown;
  traceId: string;
  threadId: string | null;
  messageId: string | null;
  error?: unknown;
  /** The worker holding the lease while running; null otherwise. */
  leaseOwner?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type StepStatus = 'in_progress' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'uncertain';

export interface StepRecord {
  runId: string;
  seq: number;
  kind: string;
  idempotencyKey: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
}

/** What a writer expects the stored run to still be; save() writes nothing otherwise. */
export interface Expected {
  status: RunStatus;
  /** string: the lease must be this owner's; null: no owner; omitted: not checked. */
  owner?: string | null;
  /** The lease must have lapsed before this instant (the sweeper). */
  leaseExpiredBy?: Date;
}

export type NewRun = Pick<RunRecord, 'id' | 'kind' | 'traceId' | 'threadId' | 'messageId' | 'checkpoint'>;

export interface RunStore {
  create(run: NewRun): Promise<RunRecord>;
  get(id: string): Promise<RunRecord | undefined>;
  /** Claim one queued run for this worker; null when none. */
  claim(owner: string, leaseMs: number): Promise<RunRecord | null>;
  renew(id: string, owner: string, leaseMs: number): Promise<boolean>;
  /**
   * Persist status, attempt, cursor, checkpoint and error, but only while the
   * stored run still matches `expected` (compare-and-set). Clears the lease
   * when the run leaves `running`. False means someone else moved the run
   * first (a cancel, the sweeper, another worker): the caller has lost it.
   */
  save(run: RunRecord, expected: Expected): Promise<boolean>;
  /** Runs whose lease lapsed while running. */
  expiredLeases(now: Date): Promise<RunRecord[]>;
  /** Non-terminal runs in a thread, newest first. */
  activeForThread(threadId: string): Promise<RunRecord[]>;
  /** Every run in a thread of one kind, oldest first. */
  forThread(threadId: string, kind: RunKind): Promise<RunRecord[]>;
  /** Runs in one status, oldest first (the reconciler). */
  withStatus(status: RunStatus, limit?: number): Promise<RunRecord[]>;
  step(runId: string, seq: number): Promise<StepRecord | undefined>;
  putStep(step: StepRecord): Promise<void>;
}

/** What a handler returns when it stops running. */
export type RunOutcome =
  | { kind: 'done' }
  | { kind: 'pause'; reason: 'approval' | 'compute'; checkpoint: unknown }
  | { kind: 'failed'; error: { code: string; title: string; hint: string } }
  | { kind: 'cancelled' };

export interface RunContext {
  run: RunRecord;
  events: RunEventLog;
  signal: AbortSignal;
  /** Persist progress so a restart resumes from here. */
  checkpoint(state: unknown): Promise<void>;
  /**
   * A recorded side effect: replays its output if this key already succeeded.
   * A step left in progress by a crash is not run again unless `rerunnable`
   * (a read); it is marked uncertain and StepUncertain is thrown instead.
   */
  once<T>(
    seq: number,
    kind: string,
    input: unknown,
    effect: () => Promise<T>,
    opts?: { rerunnable?: boolean },
  ): Promise<T>;
}

export interface RunHandler {
  execute(ctx: RunContext): Promise<RunOutcome>;
  /** Tidy up when a run is cancelled while it is not executing (queued or waiting). */
  cancelled?(run: RunRecord): Promise<void>;
  /** Tidy up when a run fails without its handler (the sweeper gave up on it). */
  failed?(run: RunRecord, error: RunError): Promise<void>;
}

export interface RunError {
  code: string;
  title: string;
  hint: string;
}

/** This worker no longer owns the run (lease lost, cancelled elsewhere): stop without writing. */
export class RunOwnershipLost extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} is no longer owned by this worker`);
    this.name = 'RunOwnershipLost';
  }
}

/** A side effect may or may not have happened before a restart (DESIGN.md §5.5). */
export class StepUncertain extends AncileError {
  constructor(
    readonly runId: string,
    readonly seq: number,
  ) {
    super({
      code: 'run.step_uncertain',
      title: 'A tool may or may not have run before a restart',
      hint: 'Check the result, then ask again if it is needed.',
      status: 409,
      errorClass: 'permanent',
      context: { run_id: runId, seq },
    });
  }
}

export function applyEvent(run: RunRecord, event: RunEventKind): RunRecord {
  const next = transition({ status: run.status, attempt: run.attempt }, event);
  return { ...run, status: next.status, attempt: next.attempt };
}

/** Deterministic idempotency key: the same step of the same run is the same key forever. */
export function stepKey(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

export const LEASE_MS = 30_000;
export const RENEW_EVERY_MS = 10_000;

export const GAVE_UP: RunError = {
  code: 'run.crashed',
  title: 'This run stopped unexpectedly',
  hint: 'It stopped its worker several times, so Ancile gave up. Try again; the trace has the details.',
};

export interface SweepResult {
  /** Back in the queue. */
  requeued: string[];
  /** Out of attempts: failed, still to be finalised (see RunWorker). */
  failed: RunRecord[];
}

/**
 * Reclaim runs whose worker died. Called on boot and every half minute.
 * Each write is a compare-and-set on the stale lease, so a worker that
 * renews in the meantime keeps its run.
 */
export async function sweep(store: RunStore, now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { requeued: [], failed: [] };
  for (const run of await store.expiredLeases(now)) {
    let next = applyEvent(run, 'lease_expired');
    if (next.status === 'failed') next = { ...next, error: GAVE_UP };
    const won = await store.save(next, {
      status: 'running',
      owner: run.leaseOwner ?? null,
      leaseExpiredBy: now,
    });
    if (!won) continue;
    if (next.status === 'failed') out.failed.push(next);
    else out.requeued.push(run.id);
  }
  return out;
}
