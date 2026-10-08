/**
 * ------------------------------------------------------------------
 *  Title    |  Approval housekeeping
 *  Ref      |  DESIGN.md §5.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep questions and paused runs in step, whatever order
 *           |  things happened in:
 *           |    - an approval past its expiry resolves as `expired`,
 *           |      which the run treats as a denial
 *           |    - an approval whose run already ended is withdrawn
 *           |    - a run paused on approvals that are all answered is
 *           |      put back in the queue (an answer that missed its
 *           |      resume, or a pause saved after the answer)
 *  How      |  reconcileApprovals() runs on the worker's reconcile
 *           |  timer and once at boot. withdrawApprovals() is the
 *           |  worker's settle hook, so a run that ends (any way)
 *           |  takes its open questions with it.
 * ------------------------------------------------------------------
 */

import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { RunStore } from '../runs/engine';
import type { RunEventLog } from '../runs/events';
import { TERMINAL } from '../runs/machine';
import type { RunWorker } from '../runs/worker';
import type { ApprovalRecord, PermissionStore } from './store';

const log = logFor('permissions');

/** Default lifetime of a question nobody answers (ANCILE_APPROVAL_TTL_S). */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

export interface ReconcileDeps {
  permissions: PermissionStore;
  runs: Pick<RunStore, 'get' | 'withStatus'>;
  events: RunEventLog;
  bus?: EventBus;
  worker: Pick<RunWorker, 'resume'>;
  userId: string;
  traceId: () => string;
  /** Relay an outcome elsewhere (the lab's engine is waiting on it). */
  onResolved?: (approval: ApprovalRecord, status: 'expired', reason: null) => Promise<unknown>;
}

export async function reconcileApprovals(deps: ReconcileDeps, now = new Date()): Promise<void> {
  const { permissions, runs } = deps;

  for (const a of await permissions.expireDue(now)) {
    log.info({ approval_id: a.id, run_id: a.run_id }, 'an approval expired unanswered');
    await permissions.recordDecision({
      userId: deps.userId,
      principal: a.principal,
      action: a.action,
      resource: a.resource,
      tier: a.tier,
      outcome: 'expired',
      approvalId: a.id,
      runId: a.run_id,
      traceId: deps.traceId(),
    });
    await deps.events
      .append(a.run_id, { type: 'approval.resolved', approval_id: a.id, decision: 'expired' })
      .catch(() => undefined);
    await deps.bus?.publish({ type: 'approval.resolved', approval_id: a.id }).catch(() => undefined);
    await deps.onResolved?.(a, 'expired', null);
    await deps.worker.resume(a.run_id);
  }

  for (const a of await permissions.pendingApprovals()) {
    const run = await runs.get(a.run_id);
    if (run && !TERMINAL.has(run.status)) continue;
    if (await permissions.resolveApproval(a.id, { status: 'cancelled' })) {
      log.info({ approval_id: a.id, run_id: a.run_id }, 'withdrew an approval whose run had ended');
      await deps.bus?.publish({ type: 'approval.resolved', approval_id: a.id }).catch(() => undefined);
    }
  }

  for (const run of await runs.withStatus('waiting_approval')) {
    const open = (await permissions.approvalsForRun(run.id)).some((a) => a.status === 'pending');
    if (!open && (await deps.worker.resume(run.id)))
      log.warn({ run_id: run.id }, 'resumed a run whose approvals were already answered');
  }
}

/** Withdraw a run's open questions (it ended); every tab hears so the dialog closes. */
export async function withdrawApprovals(
  deps: Pick<ReconcileDeps, 'permissions' | 'bus'>,
  runId: string,
): Promise<string[]> {
  const ids = await deps.permissions.cancelApprovalsForRun(runId);
  for (const id of ids)
    await deps.bus?.publish({ type: 'approval.resolved', approval_id: id }).catch(() => undefined);
  return ids;
}
