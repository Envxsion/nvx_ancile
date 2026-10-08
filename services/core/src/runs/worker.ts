/**
 * ------------------------------------------------------------------
 *  Title    |  Run worker
 *  Ref      |  DESIGN.md §7.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Pick up queued runs, execute them under a lease, and
 *           |  turn whatever happens (done, paused for a person,
 *           |  failed, cancelled, crashed) into exactly one legal state
 *           |  transition, announced on the run's stream and globally.
 *  How      |  kick() claims immediately when a run is queued; a slow
 *           |  poll catches anything else (a resumed approval, a run
 *           |  another Core released). Each executing run renews its
 *           |  lease every 10 s; the sweeper puts lapsed leases back in
 *           |  the queue, so a killed process loses nothing.
 *           |  Every status write is a compare-and-set (RunStore.save):
 *           |  a worker that loses the race (a cancel, the sweeper)
 *           |  stops instead of overwriting. An answer that arrives
 *           |  while the run is still saving its pause is remembered
 *           |  and applied as soon as the pause is saved; the
 *           |  reconcile hook is the backstop for anything missed.
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import type { RunStatus } from '@nvx/contracts';
import { runWithContext } from '../context';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import { startSpan, withSpan } from '../obs/spans';
import {
  applyEvent,
  type Expected,
  LEASE_MS,
  RENEW_EVERY_MS,
  type RunContext,
  type RunError,
  type RunHandler,
  type RunKind,
  RunOwnershipLost,
  type RunRecord,
  type RunStore,
  StepUncertain,
  stepKey,
  sweep,
} from './engine';
import type { RunEventLog } from './events';
import { canTransition, TERMINAL } from './machine';

const log = logFor('runs');

const CRASHED: RunError = {
  code: 'run.crashed',
  title: 'This run stopped unexpectedly',
  hint: 'Try again. If it keeps happening, the trace has the details.',
};

export interface WorkerOptions {
  store: RunStore;
  events: RunEventLog;
  bus?: EventBus;
  handlers: Partial<Record<RunKind, RunHandler>>;
  concurrency?: number;
  pollMs?: number;
  sweepMs?: number;
  leaseMs?: number;
  /** Housekeeping on its own timer (approvals: expiry, stale ones, missed resumes). */
  reconcile?: () => Promise<void>;
  reconcileMs?: number;
  /** Called once a run reaches a terminal state, whoever moved it there. */
  onSettled?: (run: RunRecord) => Promise<void>;
}

export class RunWorker {
  readonly owner = `core-${process.pid}-${randomBytes(3).toString('hex')}`;
  private readonly active = new Map<string, AbortController>();
  /** Answers that arrived while the run was still running (see resume()). */
  private readonly resumeAfterPause = new Set<string>();
  private readonly idle = new Set<() => void>();
  private poll?: ReturnType<typeof setInterval>;
  private sweeper?: ReturnType<typeof setInterval>;
  private reconciler?: ReturnType<typeof setInterval>;
  private claiming = false;
  private again = false;
  private reconciling = false;
  private stopped = false;

  constructor(private readonly opts: WorkerOptions) {}

  async start(): Promise<void> {
    await this.sweepNow('resumed runs left running by a previous Core');
    this.poll = setInterval(() => this.kick(), this.opts.pollMs ?? 1_000);
    this.sweeper = setInterval(
      () => void this.sweepNow('reclaimed runs whose lease lapsed'),
      // Every 10 s, so a run cut off by a restart resumes within a lease plus 10 s.
      this.opts.sweepMs ?? 10_000,
    );
    if (this.opts.reconcile) {
      this.reconciler = setInterval(() => void this.reconcileNow(), this.opts.reconcileMs ?? 5_000);
      void this.reconcileNow();
    }
    this.kick();
  }

  /** Stop claiming; abort nothing. Runs in flight keep their lease until the process exits. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.poll);
    clearInterval(this.sweeper);
    clearInterval(this.reconciler);
  }

  /** Resolves when no run is executing in this worker (tests, graceful shutdown). */
  async drain(): Promise<void> {
    if (this.active.size === 0 && !this.claiming) return;
    await new Promise<void>((r) => this.idle.add(r));
  }

  isExecuting(runId: string): boolean {
    return this.active.has(runId);
  }

  kick(): void {
    if (this.stopped) return;
    // A kick during a claim pass is remembered, not dropped: the run queued
    // just after the pass found nothing would otherwise wait for the poll.
    if (this.claiming) {
      this.again = true;
      return;
    }
    this.claiming = true;
    this.again = false;
    void this.claimLoop()
      .catch((err) => log.error({ err }, 'claim loop failed'))
      .finally(() => {
        this.claiming = false;
        this.notifyIdle();
        if (this.again) this.kick();
      });
  }

  /** Run the reconcile hook now (also on its timer). Never throws. */
  async reconcileNow(): Promise<void> {
    if (!this.opts.reconcile || this.reconciling) return;
    this.reconciling = true;
    try {
      await this.opts.reconcile();
    } catch (err) {
      log.error({ err }, 'reconcile failed');
    } finally {
      this.reconciling = false;
    }
  }

  private async sweepNow(message: string): Promise<void> {
    try {
      const { requeued, failed } = await sweep(this.opts.store);
      if (requeued.length) log.warn({ runs: requeued }, message);
      for (const run of failed) {
        log.error({ run_id: run.id, attempt: run.attempt }, 'gave up on a run that kept stopping its worker');
        await this.finishFailed(run, run.error as RunError);
      }
      if (requeued.length) this.kick();
    } catch (err) {
      log.error({ err }, 'sweep failed');
    }
  }

  private notifyIdle() {
    if (this.active.size === 0 && !this.claiming) {
      for (const r of this.idle) r();
      this.idle.clear();
    }
  }

  private async claimLoop(): Promise<void> {
    // Runs mostly wait on providers, so many can share one process; a
    // small limit queued the 50th answer behind 46 others (Phase 6 load).
    const max = this.opts.concurrency ?? 32;
    while (!this.stopped && this.active.size < max) {
      let run: RunRecord | null;
      try {
        run = await this.opts.store.claim(this.owner, this.opts.leaseMs ?? LEASE_MS);
      } catch (err) {
        log.error({ err }, 'could not claim a run');
        return;
      }
      if (!run) return;
      const id = run.id;
      const controller = new AbortController();
      this.active.set(id, controller);
      void this.execute(run, controller)
        .catch((err) => log.error({ err, run_id: id }, 'run execution failed'))
        .finally(() => {
          // A run that lost its lease can be claimed again here while the
          // old execution winds down: only remove our own entry.
          if (this.active.get(id) === controller) this.active.delete(id);
          this.notifyIdle();
          this.kick();
        });
    }
  }

  /**
   * Cancel wherever the run is: executing here (abort it, the handler
   * finalises), or queued/waiting/running elsewhere (move it with a
   * compare-and-set and let the handler tidy up). A run claimed between
   * the read and the write is read again, never overwritten.
   */
  async cancel(runId: string): Promise<RunStatus | null> {
    for (let tries = 0; tries < 20; tries++) {
      const local = this.active.get(runId);
      local?.abort(new Error('cancelled'));
      const run = await this.opts.store.get(runId);
      if (!run) return null;
      // Executing here: the handler sees the abort and finalises. If it had
      // already saved a pause, the run is waiting and is cancelled below.
      if (local && run.status === 'running') return 'cancelled';
      if (TERMINAL.has(run.status) || !canTransition(run.status, 'cancel')) return run.status;
      if (run.status === 'running' && run.leaseOwner === this.owner) {
        // Claimed by this worker a moment ago; it is about to appear in `active`.
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      const next = applyEvent(run, 'cancel');
      if (!(await this.opts.store.save(next, expectedOf(run)))) continue;
      await this.announce(next);
      await this.opts.handlers[run.kind]?.cancelled?.(next);
      await this.opts.events.append(run.id, { type: 'done', message_id: run.messageId });
      await this.settled(next);
      return 'cancelled';
    }
    log.warn({ run_id: runId }, 'could not cancel a run that kept changing');
    return (await this.opts.store.get(runId))?.status ?? null;
  }

  /**
   * Put a paused run back in the queue (an approval was answered). A run
   * that is still executing here (it asked, and is saving its pause) is
   * remembered and requeued as soon as the pause is saved.
   */
  async resume(runId: string, checkpoint?: unknown): Promise<boolean> {
    for (let tries = 0; tries < 5; tries++) {
      const run = await this.opts.store.get(runId);
      if (!run) return false;
      if (run.status === 'running' && this.active.has(runId)) {
        this.resumeAfterPause.add(runId);
        // Read again after leaving the note: still running means the worker
        // has not saved its pause yet and will see the note when it does.
        if ((await this.opts.store.get(runId))?.status === 'running') return true;
        this.resumeAfterPause.delete(runId);
        continue;
      }
      if (!canTransition(run.status, 'resume')) return false;
      const next = { ...applyEvent(run, 'resume'), ...(checkpoint !== undefined && { checkpoint }) };
      if (!(await this.opts.store.save(next, expectedOf(run)))) continue;
      await this.announce(next);
      this.kick();
      return true;
    }
    return false;
  }

  private async announce(run: RunRecord, detail?: string): Promise<void> {
    await this.opts.events.append(run.id, {
      type: 'run.status',
      status: run.status,
      ...(detail !== undefined && { detail }),
    });
    await this.opts.bus
      ?.publish({ type: 'run.updated', run_id: run.id, status: run.status, thread_id: run.threadId })
      .catch(() => undefined);
  }

  private async settled(run: RunRecord): Promise<void> {
    if (!TERMINAL.has(run.status)) return;
    await this.opts.onSettled?.(run).catch((err) => log.error({ err, run_id: run.id }, 'settle hook failed'));
  }

  /** A run failed outside its handler (the sweeper gave up): finalise it like any failure. */
  private async finishFailed(run: RunRecord, error: RunError): Promise<void> {
    await this.announce(run, error.title).catch(() => undefined);
    await this.opts.handlers[run.kind]
      ?.failed?.(run, error)
      .catch((err) => log.error({ err, run_id: run.id }, 'could not finalise a failed run'));
    await this.opts.events.append(run.id, { type: 'error', ...error, attempts: [] }).catch(() => undefined);
    await this.opts.events.append(run.id, { type: 'done', message_id: run.messageId }).catch(() => undefined);
    await this.settled(run);
  }

  private async execute(claimed: RunRecord, controller: AbortController): Promise<void> {
    const { store, events } = this.opts;
    const leaseMs = this.opts.leaseMs ?? LEASE_MS;
    const owner = this.owner;
    let run = claimed;
    const handler = this.opts.handlers[run.kind];
    const lose = () => {
      if (!controller.signal.aborted) controller.abort(new RunOwnershipLost(run.id));
    };

    const renew = setInterval(() => {
      void store
        .renew(run.id, owner, leaseMs)
        .then((ok) => {
          if (!ok) {
            log.warn({ run_id: run.id }, 'lost the lease on a run; stopping it here');
            lose();
          }
        })
        .catch((err) => log.warn({ err, run_id: run.id }, 'could not renew a run lease'));
    }, RENEW_EVERY_MS);

    const mine: Expected = { status: 'running', owner };

    const ctx: RunContext = {
      get run() {
        return run;
      },
      events,
      signal: controller.signal,
      checkpoint: async (state) => {
        const next = { ...run, checkpoint: state };
        if (!(await store.save(next, mine))) {
          lose();
          throw new RunOwnershipLost(run.id);
        }
        run = next;
      },
      once: async <T>(
        seq: number,
        kind: string,
        input: unknown,
        effect: () => Promise<T>,
        opts?: { rerunnable?: boolean },
      ): Promise<T> => {
        const key = stepKey(run.id, seq);
        const prior = await store.step(run.id, seq);
        if (prior?.status === 'succeeded') return prior.output as T;
        // Left in progress by a crash (or already found uncertain): the effect
        // may have happened. Only a step that is safe to repeat runs again.
        if ((prior?.status === 'in_progress' || prior?.status === 'uncertain') && !opts?.rerunnable) {
          if (prior.status === 'in_progress')
            await store.putStep({ ...prior, idempotencyKey: key, status: 'uncertain' });
          throw new StepUncertain(run.id, seq);
        }
        await store.putStep({
          runId: run.id,
          seq,
          kind,
          idempotencyKey: key,
          status: 'in_progress',
          input,
          output: null,
        });
        try {
          const output = await withSpan(`step ${kind}`, 'internal', { run_id: run.id, seq, kind }, () =>
            effect(),
          );
          await store.putStep({
            runId: run.id,
            seq,
            kind,
            idempotencyKey: key,
            status: 'succeeded',
            input,
            output,
          });
          run = { ...run, stepCursor: Math.max(run.stepCursor, seq) };
          return output;
        } catch (err) {
          await store.putStep({
            runId: run.id,
            seq,
            kind,
            idempotencyKey: key,
            status: 'failed',
            input,
            output: { error: (err as Error).message },
          });
          throw err;
        }
      },
    };

    const runSpanId = randomBytes(8).toString('hex');
    // The run's own span: its steps, model calls and tool calls nest under it.
    const runSpan = startSpan(
      `run ${run.kind}`,
      'internal',
      {
        run_id: run.id,
        kind: run.kind,
        attempt: run.attempt,
        ...(run.threadId && { thread_id: run.threadId }),
      },
      { spanId: runSpanId, parent: { traceId: run.traceId, spanId: runSpanId } },
    );
    await runWithContext(
      { traceId: run.traceId, spanId: runSpanId, runId: run.id, component: 'runs' },
      async () => {
        try {
          await this.announce(run, run.attempt > 0 ? 'resumed' : undefined);
          if (!handler) throw new Error(`No handler for ${run.kind} runs`);
          let outcome = await handler.execute(ctx);
          const reason = controller.signal.reason;
          if (reason instanceof RunOwnershipLost) {
            log.warn({ run_id: run.id }, 'stopped a run this worker no longer owns');
            return;
          }
          // A Stop that landed while the run was asking for approval wins.
          let tidy = false;
          if (outcome.kind === 'pause' && controller.signal.aborted) {
            outcome = { kind: 'cancelled' };
            tidy = true;
          }
          let next: RunRecord;
          switch (outcome.kind) {
            case 'done':
              next = applyEvent(run, 'complete');
              break;
            case 'pause':
              next = {
                ...applyEvent(run, outcome.reason === 'approval' ? 'need_approval' : 'need_compute'),
                checkpoint: outcome.checkpoint,
              };
              break;
            case 'failed':
              next = { ...applyEvent(run, 'fail'), error: outcome.error };
              break;
            case 'cancelled':
              next = applyEvent(run, 'cancel');
              break;
          }
          if (!(await store.save(next, mine))) {
            // Cancelled elsewhere, or reclaimed by the sweeper: whoever moved
            // it has announced it.
            log.warn(
              { run_id: run.id, outcome: outcome.kind },
              'run moved while it was finishing; leaving it',
            );
            return;
          }
          run = next;
          if (tidy) await handler.cancelled?.(run);
          await this.announce(run, outcome.kind === 'failed' ? outcome.error.title : undefined);
          if (outcome.kind !== 'pause') {
            await events.append(run.id, { type: 'done', message_id: run.messageId });
            await this.settled(run);
            return;
          }
          // An answer that came in while the pause was being saved.
          if (this.resumeAfterPause.delete(run.id)) {
            if (this.active.get(run.id) === controller) this.active.delete(run.id);
            await this.resume(run.id);
          }
        } catch (err) {
          if (err instanceof RunOwnershipLost || controller.signal.reason instanceof RunOwnershipLost) {
            log.warn({ run_id: run.id }, 'stopped a run this worker no longer owns');
            return;
          }
          log.error({ err, run_id: run.id }, 'run crashed');
          const failed = { ...applyEvent({ ...run, status: 'running' }, 'fail'), error: CRASHED };
          if (await store.save(failed, mine).catch(() => false)) {
            run = failed;
            await this.finishFailed(run, CRASHED);
          }
        } finally {
          clearInterval(renew);
          this.resumeAfterPause.delete(claimed.id);
          runSpan.end(run.status === 'failed' ? 'error' : 'ok', { status: run.status });
        }
      },
    );
  }
}

/** What a writer that just read `run` expects it to still be. */
function expectedOf(run: RunRecord): Expected {
  return run.status === 'running'
    ? { status: 'running', owner: run.leaseOwner ?? null }
    : { status: run.status };
}
