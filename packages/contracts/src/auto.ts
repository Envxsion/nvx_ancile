/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode: plans, reviews and grouped approvals
 *  Ref      |  docs/auto-mode.md · DESIGN.md §5 (permissions)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The vocabulary of the Auto permission preset: the plan
 *           |  you approve once, how each call was settled (plan,
 *           |  cache, reviewer, rules), the reviewers it can use, and
 *           |  answering a group of approvals in one go.
 *  How      |  Closed enums throughout, so a run event or a trace can
 *           |  never carry free text where a kind belongs.
 *  Note     |  The reviewer only ever makes things stricter: floors and
 *           |  scopes are checked before and after it, and it can turn
 *           |  a would-run into an ask or a block, never the reverse.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Who reviewed a call. `fake` exists only in tests and evals. */
export const AutoReviewerId = z.enum(['jev_openrouter', 'jev_direct', 'local_model', 'rules', 'fake']);
export type AutoReviewerId = z.infer<typeof AutoReviewerId>;

/** How an Auto mode call was settled. */
export const AutoVia = z.enum(['floor', 'plan', 'cache', 'reviewer', 'rules']);
export type AutoVia = z.infer<typeof AutoVia>;

export const AutoVerdict = z.enum(['allow', 'ask', 'block']);
export type AutoVerdict = z.infer<typeof AutoVerdict>;

/** The thresholds a reviewer must clear for a call to run by itself. */
export const AUTO_THRESHOLDS = { minFits: 0.9, maxInjection: 0.1 } as const;

/** One step of a plan: what kind of call, on what, and why (shown to you). */
export const AutoPlanStep = z
  .object({
    /** A tool action glob, e.g. "fs.write" or "git.*". */
    action: z.string().trim().min(1).max(200),
    /** A resource glob with a real prefix, e.g. "fs:/workspace/src/**" or "shell:pnpm test*". */
    resource: z.string().trim().min(4).max(1000),
    note: z.string().trim().max(300).default(''),
  })
  .strict();
export type AutoPlanStep = z.infer<typeof AutoPlanStep>;

export const AutoPlanStatus = z.enum(['proposed', 'approved', 'rejected', 'superseded']);
export type AutoPlanStatus = z.infer<typeof AutoPlanStatus>;

export const AutoPlan = z.object({
  id: z.string(),
  thread_id: z.string().nullable(),
  run_id: z.string().nullable(),
  summary: z.string(),
  steps: z.array(AutoPlanStep),
  status: AutoPlanStatus,
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type AutoPlan = z.infer<typeof AutoPlan>;

/** POST /auto/plans: one per thread (or run); a new one supersedes the last. */
export const ProposePlanRequest = z
  .object({
    thread_id: z.string().min(1).max(100).optional(),
    run_id: z.string().min(1).max(100).optional(),
    summary: z.string().trim().min(1).max(2000),
    steps: z.array(AutoPlanStep).min(1).max(50),
  })
  .strict()
  .refine((r) => !!r.thread_id || !!r.run_id, { message: 'thread_id or run_id is required' });
export type ProposePlanRequest = z.infer<typeof ProposePlanRequest>;

/** POST /auto/plans/:id/decision */
export const PlanDecisionRequest = z.object({ decision: z.enum(['approve', 'reject']) }).strict();
export type PlanDecisionRequest = z.infer<typeof PlanDecisionRequest>;

/**
 * POST /approvals/batch: answer several waiting approvals at once (Auto
 * mode groups its asks). Each is answered "once"; nothing is remembered.
 */
export const BatchDecisionRequest = z
  .object({
    approval_ids: z.array(z.string().min(1)).min(1).max(100),
    decision: z.enum(['approve', 'deny']),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type BatchDecisionRequest = z.infer<typeof BatchDecisionRequest>;

export const BatchDecisionResult = z.object({
  items: z.array(
    z.object({
      approval_id: z.string(),
      status: z.enum(['approved', 'denied', 'expired', 'cancelled', 'pending', 'missing']),
    }),
  ),
});
export type BatchDecisionResult = z.infer<typeof BatchDecisionResult>;

/**
 * What the trace records for one Auto mode decision. The call itself is
 * only a hash: arguments stay where the tool call already records them.
 */
export const AutoReviewRecord = z.object({
  input_hash: z.string(),
  verdict: AutoVerdict,
  via: AutoVia,
  reviewer: AutoReviewerId.nullable(),
  /** Reviewers tried before the one that answered, in order. */
  tried: z.array(AutoReviewerId),
  p_fits: z.number().min(0).max(1).nullable(),
  p_injection: z.number().min(0).max(1).nullable(),
  latency_ms: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative().nullable(),
  /** A floor or scope rule id when one decided ("floor.recursive_delete", "scope.network"). */
  rule: z.string().nullable(),
  reason: z.string(),
});
export type AutoReviewRecord = z.infer<typeof AutoReviewRecord>;
