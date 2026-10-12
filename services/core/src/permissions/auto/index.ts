/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode with an independent review
 *  Ref      |  docs/auto-mode.md · CLAUDE.md (permissions/decide)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let long agentic sessions run without a person in the
 *           |  loop for routine steps, while anything risky still
 *           |  stops: floors first, then the approved plan, a per-
 *           |  session verdict cache, and an independent reviewer.
 *  How      |  The gate calls floors() before decide() and settle()
 *           |  when decide() would ask on a GATED call. settle() tries
 *           |  plan → cache → reviewer chain (Jev via OpenRouter, Jev
 *           |  direct, a local model, rules), applies the thresholds,
 *           |  then checks the floors and the scope again. Asks join a
 *           |  per-run group so they can be answered together; runs
 *           |  without asking leave a quiet `auto.ran` marker.
 *  Note     |  The reviewer can only make things stricter: it decides
 *           |  between "run" and "ask" for a call decide() was going
 *           |  to ask about anyway, and never sees a call a floor or a
 *           |  scope has stopped. When nothing may leave the machine,
 *           |  only local reviewers are asked. Every decision goes to
 *           |  the trace with an input hash, never the arguments.
 *           |  When no reviewer but the rules can answer, Auto mode is
 *           |  "reviewer offline": said once per outage (reviewerStatus
 *           |  and onReviewerStatus), with the reason. An ask while an
 *           |  approved plan is in force is marked out of plan, so the
 *           |  Cockpit can offer "Add to plan".
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  AUTO_THRESHOLDS,
  type AutoReviewerId,
  type AutoReviewRecord,
  type AutoVia,
  type EffectiveScope,
  type ReviewerOfflineReason,
  type ReviewerStatus,
} from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import { ulid } from 'ulid';
import { logFor } from '../../obs/logger';
import { startSpan } from '../../obs/spans';
import type { RunEventInput } from '../../runs/events';
import { type AutoCall, checkFloors, type FloorHit } from './floors';
import { type PlanStore, planStepFor, sessionKey } from './plans';
import { type ReviewAnswer, type Reviewer, RulesReviewer } from './reviewers';

export { type AutoCall, checkFloors, type FloorHit } from './floors';
export { MemoryPlanStore, PgPlanStore, type PlanStore, planStepFor, sessionKey } from './plans';
export {
  JEV_DIRECT_MODELS,
  JEV_OPENROUTER_MODELS,
  JevReviewer,
  LocalModelReviewer,
  OPENROUTER_DECISIONS_URL,
  type Reviewer,
  RulesReviewer,
  TYPESAFE_SYSTEMONE_URL,
} from './reviewers';

export interface AutoContext {
  call: AutoCall;
  scope: EffectiveScope | null;
  threadId: string | null;
  notebookId: string | null;
  runId: string | null;
  traceId: string;
  callId?: string;
  /** The workspace or session folder. */
  root: string;
}

export interface AutoOutcome extends AutoReviewRecord {
  /** Set on an ask: the group its approval joins. */
  batch_id: string | null;
  /** An approved plan is in force and this ask fits none of its steps. */
  out_of_plan?: boolean;
  /** That plan, when out_of_plan. */
  plan_id?: string;
}

export interface AutoDeps {
  /** In order of preference; the rules reviewer is always added last. */
  reviewers: Reviewer[];
  plans: PlanStore;
  /** Append a run event (auto.ran, approval.batched). */
  emit?: (runId: string, event: RunEventInput) => Promise<unknown>;
  now?: () => number;
  /** How long a verdict is reused within a session (default 30 minutes). */
  cacheTtlMs?: number;
  /** How long asks in one run keep joining the same group (default 2 minutes). */
  batchWindowMs?: number;
  /** The reviewer went offline (rules only) or came back: called once per change. */
  onReviewerStatus?: (status: ReviewerStatus) => void;
}

/** Why one reviewer could not answer. */
function failureReason(r: Reviewer, err: unknown): ReviewerOfflineReason {
  if (r.local) return 'model_not_pulled';
  const status = err instanceof ClassifiedError ? err.status : undefined;
  if (status === 401 || status === 403) return 'key_rejected';
  return 'network';
}

/** The hash a trace records instead of the call. */
export function inputHash(call: AutoCall): string {
  return createHash('sha256')
    .update(JSON.stringify({ action: call.action, resource: call.resource, args: call.args ?? null }))
    .digest('hex');
}

/**
 * Calls that are "the same kind of thing" share a signature: a file write in
 * the same folder with the same extension, or the same command with numbers
 * and quoted text folded. Floors still see every call afresh.
 */
export function callSignature(call: AutoCall): string {
  const r = call.resource;
  if (r.startsWith('fs:')) {
    const p = r.slice(3);
    return `${call.action} fs:${posix.dirname(p)}/*${posix.extname(p)}`;
  }
  if (r.startsWith('shell:'))
    return `${call.action} shell:${r
      .slice(6)
      .replace(/(["'])(?:\\.|(?!\1).)*\1/g, '…')
      .replace(/\d+/g, '#')
      .trim()}`;
  return `${call.action} ${r}`;
}

const rank = { allow: 0, ask: 1, block: 2 } as const;

const log = logFor('auto-review');

export class AutoReview {
  private readonly reviewers: Reviewer[];
  private readonly cache = new Map<
    string,
    { verdict: 'allow'; at: number; reviewer: AutoReviewerId | null }
  >();
  private readonly batches = new Map<string, { id: string; openedAt: number; n: number }>();
  private readonly now: () => number;
  private status: ReviewerStatus = {
    status: 'unknown',
    outage_id: null,
    reason: null,
    local_only: false,
    since: null,
  };

  constructor(private readonly deps: AutoDeps) {
    this.reviewers = [...deps.reviewers.filter((r) => r.id !== 'rules'), new RulesReviewer()];
    this.now = deps.now ?? Date.now;
  }

  /** Is a reviewer answering, or is Auto mode on its rules alone (asking more often)? */
  reviewerStatus(): ReviewerStatus {
    return { ...this.status };
  }

  private reviewerAnswered() {
    if (this.status.status === 'online') return;
    const was = this.status.status;
    this.status = { status: 'online', outage_id: null, reason: null, local_only: false, since: this.iso() };
    if (was === 'offline') {
      log.info({}, 'auto review: a reviewer answers again');
      this.deps.onReviewerStatus?.(this.reviewerStatus());
    }
  }

  private reviewerOffline(reason: ReviewerOfflineReason, localOnly: boolean) {
    if (this.status.status === 'offline') {
      // The same outage: the reason may sharpen, but nobody is told twice.
      this.status = { ...this.status, reason, local_only: localOnly };
      return;
    }
    this.status = {
      status: 'offline',
      outage_id: `rvo_${ulid()}`,
      reason,
      local_only: localOnly,
      since: this.iso(),
    };
    log.warn({ reason, local_only: localOnly }, 'auto review: no reviewer answers; rules only');
    this.deps.onReviewerStatus?.(this.reviewerStatus());
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  /**
   * Forget cached verdicts for actions starting with `actionPrefix` (an MCP
   * server whose tools changed: mcp/guard.ts). They are reviewed afresh.
   */
  forget(actionPrefix: string): number {
    let n = 0;
    for (const key of [...this.cache.keys()]) {
      const sig = key.slice(key.indexOf('\u0000') + 1);
      if (sig.startsWith(actionPrefix)) {
        this.cache.delete(key);
        n++;
      }
    }
    return n;
  }

  /** The deterministic floors (the scope's checks among them). */
  floors(ctx: Pick<AutoContext, 'call' | 'scope'>): FloorHit | null {
    return checkFloors({ call: ctx.call, scope: ctx.scope });
  }

  /** A floor stopped the call before decide() was asked: record it, and group it if it asks. */
  async floored(ctx: AutoContext, hit: FloorHit): Promise<AutoOutcome> {
    const out = this.outcome(ctx, {
      verdict: hit.verdict,
      via: 'floor',
      reviewer: null,
      tried: [],
      answer: null,
      started: this.now(),
      rule: hit.rule,
      reason: hit.reason,
    });
    await this.finish(ctx, out);
    return out;
  }

  /**
   * decide() would ask about this GATED call. Settle it: run by itself, ask,
   * or (a floor on the second look) block. `rescope` reads the scope afresh
   * for the check after the reviewer.
   */
  async settle(ctx: AutoContext, rescope: () => Promise<EffectiveScope | null>): Promise<AutoOutcome> {
    const started = this.now();
    const key = sessionKey(ctx) ?? 'none';
    let out: AutoOutcome;

    const plan = await this.deps.plans.current(key).catch(() => undefined);
    const step = planStepFor(plan, ctx.call);
    const sig = `${key}\u0000${callSignature(ctx.call)}`;
    const cached = this.cache.get(sig);
    if (step) {
      out = this.outcome(ctx, {
        verdict: 'allow',
        via: 'plan',
        reviewer: null,
        tried: [],
        answer: null,
        started,
        rule: null,
        reason: `It fits the approved plan (${step.action} on ${step.resource})`,
      });
    } else if (cached && this.now() - cached.at < (this.deps.cacheTtlMs ?? 30 * 60_000)) {
      out = this.outcome(ctx, {
        verdict: 'allow',
        via: 'cache',
        reviewer: cached.reviewer,
        tried: [],
        answer: null,
        started,
        rule: null,
        reason: 'A call like this was reviewed and ran earlier in this session',
      });
    } else {
      out = await this.review(ctx, plan ?? null, started);
      if (out.verdict === 'allow')
        this.cache.set(sig, { verdict: 'allow', at: this.now(), reviewer: out.reviewer });
      if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value as string);
    }

    // The second look: floors and the scope, read again, after whatever the reviewer said.
    const fresh = await rescope().catch(() => ctx.scope);
    const again = this.floors({ call: ctx.call, scope: fresh });
    if (again && rank[again.verdict] > rank[out.verdict]) {
      out = { ...out, verdict: again.verdict, rule: again.rule, reason: again.reason, via: 'floor' };
      this.cache.delete(sig);
    }
    // An approved plan is in force and this fits none of its steps: one step outside your plan.
    // (Not when a floor asks: adding it to the plan would change nothing.)
    if (out.verdict === 'ask' && out.via !== 'floor' && !again && plan?.status === 'approved')
      out = { ...out, out_of_plan: true, plan_id: plan.id };
    await this.finish(ctx, out);
    return out;
  }

  private async review(
    ctx: AutoContext,
    plan: Awaited<ReturnType<PlanStore['current']>> | null,
    started: number,
  ): Promise<AutoOutcome> {
    const mayLeave = ctx.scope ? ctx.scope.scope.data_leaves_machine && !ctx.scope.private : true;
    const tried: AutoReviewerId[] = [];
    // Why each reviewer before the rules could not answer: failures first, then ones not set up.
    const failed: ReviewerOfflineReason[] = [];
    const missing: ReviewerOfflineReason[] = [];
    for (const r of this.reviewers) {
      if (!r.local && !mayLeave) continue;
      if (!(await r.available().catch(() => false))) {
        if (r.id !== 'rules') missing.push(r.local ? 'model_not_pulled' : 'no_key');
        continue;
      }
      try {
        const answer = await r.review({
          call: ctx.call,
          plan: plan ?? null,
          scope: ctx.scope,
          project: { root: ctx.root, notebookId: ctx.notebookId },
        });
        const fits = answer.p_fits >= AUTO_THRESHOLDS.minFits;
        const clean = answer.p_injection <= AUTO_THRESHOLDS.maxInjection;
        const via: AutoVia = r.id === 'rules' ? 'rules' : 'reviewer';
        if (r.id === 'rules') this.reviewerOffline(failed[0] ?? missing[0] ?? 'no_key', !mayLeave);
        else this.reviewerAnswered();
        return this.outcome(ctx, {
          verdict: fits && clean ? 'allow' : 'ask',
          via,
          reviewer: r.id,
          tried,
          answer,
          started,
          rule: null,
          reason: !clean
            ? 'The reviewer thinks it may be an injection attempt'
            : !fits
              ? r.id === 'rules'
                ? 'It is not a routine step NVX Ancile recognises'
                : "The reviewer wasn't sure it fits the plan and the project"
              : 'The reviewer found it routine for this session',
        });
      } catch (err) {
        tried.push(r.id);
        if (r.id !== 'rules') failed.push(failureReason(r, err));
        // The status only: a reviewer's error body is never logged.
        log.warn(
          { reviewer: r.id, err: (err as Error).message },
          'auto review: reviewer unavailable, trying the next',
        );
      }
    }
    // Unreachable in practice (rules never fail), but never allow by default.
    this.reviewerOffline(failed[0] ?? missing[0] ?? 'no_key', !mayLeave);
    return this.outcome(ctx, {
      verdict: 'ask',
      via: 'rules',
      reviewer: null,
      tried,
      answer: null,
      started,
      rule: null,
      reason: 'No reviewer could answer',
    });
  }

  private outcome(
    ctx: AutoContext,
    o: {
      verdict: AutoOutcome['verdict'];
      via: AutoVia;
      reviewer: AutoReviewerId | null;
      tried: AutoReviewerId[];
      answer: ReviewAnswer | null;
      started: number;
      rule: string | null;
      reason: string;
    },
  ): AutoOutcome {
    return {
      input_hash: inputHash(ctx.call),
      verdict: o.verdict,
      via: o.via,
      reviewer: o.reviewer,
      tried: o.tried,
      p_fits: o.answer?.p_fits ?? null,
      p_injection: o.answer?.p_injection ?? null,
      latency_ms: Math.max(0, Math.round(this.now() - o.started)),
      cost_usd: o.answer?.cost_usd ?? null,
      rule: o.rule,
      reason: o.reason,
      batch_id: null,
    };
  }

  private batchFor(runId: string): string {
    const now = this.now();
    const cur = this.batches.get(runId);
    if (cur && now - cur.openedAt < (this.deps.batchWindowMs ?? 120_000)) return cur.id;
    const n = (cur?.n ?? 0) + 1;
    const id = `apb_${runId}_${n}`;
    this.batches.set(runId, { id, openedAt: now, n });
    if (this.batches.size > 1000) this.batches.delete(this.batches.keys().next().value as string);
    return id;
  }

  /** Trace it, then tell the run: a quiet marker, or the group an ask joins. */
  private async finish(ctx: AutoContext, out: AutoOutcome): Promise<void> {
    if (out.verdict === 'ask' && ctx.runId) out.batch_id = this.batchFor(ctx.runId);
    const span = startSpan('auto review', 'internal', {
      'auto.input_hash': out.input_hash,
      'auto.verdict': out.verdict,
      'auto.via': out.via,
      'auto.reviewer': out.reviewer,
      'auto.tried': out.tried.join(','),
      'auto.p_fits': out.p_fits,
      'auto.p_injection': out.p_injection,
      'auto.latency_ms': out.latency_ms,
      'auto.cost_usd': out.cost_usd,
      'auto.rule': out.rule,
      'auto.batch_id': out.batch_id,
      action: ctx.call.action,
      ...(ctx.runId && { run_id: ctx.runId }),
    });
    span.end('ok');
    if (!ctx.runId || !this.deps.emit) return;
    const event: RunEventInput | null =
      out.verdict === 'allow' && out.via !== 'floor'
        ? {
            type: 'auto.ran',
            action: ctx.call.action,
            via: out.via,
            reviewer: out.reviewer,
            ...(ctx.callId && { call_id: ctx.callId }),
          }
        : out.verdict === 'ask'
          ? {
              type: 'approval.batched',
              batch_id: out.batch_id ?? this.batchFor(ctx.runId),
              action: ctx.call.action,
              via: out.via === 'floor' ? 'floor' : out.via === 'rules' ? 'rules' : 'reviewer',
              reason: out.reason,
              ...(ctx.callId && { call_id: ctx.callId }),
              ...(out.out_of_plan && { out_of_plan: true }),
              ...(out.plan_id && { plan_id: out.plan_id }),
            }
          : null;
    if (event) await this.deps.emit(ctx.runId, event).catch(() => undefined);
  }
}
