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
export const AutoReviewerId = z.enum([
  'jev_openrouter',
  'jev_direct',
  /** DM1: the decision-model layer (docs/decisions.md): a hosted route picked by free allowance, then price. */
  'decisions',
  /** DM1: a decision server on this computer or the person's own GPU node. */
  'decisions_local',
  'local_model',
  'rules',
  'fake',
]);
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
 * POST /auto/plans/:id/steps: "Add to plan" on a step outside it. The plan
 * must be the approved one in force; the step is checked like any other.
 */
export const AddPlanStepRequest = AutoPlanStep;
export type AddPlanStepRequest = z.input<typeof AddPlanStepRequest>;

/** Why no reviewer could answer, so Auto mode fell back to its rules. */
export const ReviewerOfflineReason = z.enum(['no_key', 'key_rejected', 'network', 'model_not_pulled']);
export type ReviewerOfflineReason = z.infer<typeof ReviewerOfflineReason>;

/**
 * GET /auto/reviewer, and the `auto.reviewer` event when it changes. While
 * offline, Auto mode decides with its rules alone, so it asks more often.
 * `unknown` until Auto mode has reviewed a call since Core started.
 */
export const ReviewerStatus = z.object({
  status: z.enum(['online', 'offline', 'unknown']),
  /** One id per outage, so a dismissed notice stays dismissed until the next one. */
  outage_id: z.string().nullable(),
  reason: ReviewerOfflineReason.nullable(),
  /** Only local reviewers were allowed (a private notebook, or nothing may leave the machine). */
  local_only: z.boolean(),
  since: z.string().nullable(),
});
export type ReviewerStatus = z.infer<typeof ReviewerStatus>;

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

/* ---- Check my reviewers (R2) -------------------------------------------------- */

/** What the check will do and cost, shown before anything runs. GET /auto/reviewer-check. */
export const ReviewerCheckEstimate = z.object({
  /** Fixed cases: tool calls that carry injections, and an ordinary coding session. */
  injection_cases: z.number().int().nonnegative(),
  normal_cases: z.number().int().nonnegative(),
  /** How many of them get past the built-in rules and reach a reviewer. */
  reviewer_calls: z.number().int().nonnegative(),
  /** The reviewer that will answer first, or null when only the rules are available. */
  first_reviewer: AutoReviewerId.nullable(),
  /** Reviewers in the order they are asked. */
  reviewers: z.array(
    z.object({
      id: AutoReviewerId,
      label: z.string(),
      available: z.boolean(),
      /** Runs on this computer: nothing leaves it. */
      local: z.boolean(),
    }),
  ),
  /**
   * The most the run may cost, in US dollars: the measured size of each request
   * that reaches the reviewer, at its rates, plus its longest answer. The run
   * stops asking a paid reviewer once the cost it reports reaches this.
   */
  est_usd_max: z.number().nonnegative(),
  /** Prompt tokens in all the requests that reach a reviewer (about four characters to a token). */
  est_input_tokens: z.number().int().nonnegative(),
  /** listed: the model's own price. assumed: no price is published, so a cautious rate. free: it runs here. */
  price_basis: z.enum(['listed', 'assumed', 'free']),
  /** True when a paid reviewer will be asked. */
  costs_money: z.boolean(),
  /** True when the fixed cases (synthetic, none from your work) are sent to a service. */
  sends_cases_out: z.boolean(),
});
export type ReviewerCheckEstimate = z.infer<typeof ReviewerCheckEstimate>;

/** POST /auto/reviewer-check. Nothing runs, and nothing is spent, unless `confirm` is true. */
export const ReviewerCheckRequest = z
  .object({
    confirm: z.boolean(),
    /** A lower ceiling than the estimate; never a higher one. */
    max_usd: z.number().nonnegative().optional(),
  })
  .strict();
export type ReviewerCheckRequest = z.infer<typeof ReviewerCheckRequest>;

export const ReviewerCheckCategory = z.object({
  category: z.string(),
  injection_cases: z.number().int().nonnegative(),
  /** Injection cases that were asked about or blocked. */
  caught: z.number().int().nonnegative(),
  /** Injection cases that would have run by themselves. */
  missed: z.number().int().nonnegative(),
  normal_cases: z.number().int().nonnegative(),
  /** Ordinary calls that asked or were blocked. */
  false_alarms: z.number().int().nonnegative(),
});
export type ReviewerCheckCategory = z.infer<typeof ReviewerCheckCategory>;

export const ReviewerCheckResult = z.object({
  ran_at: z.string(),
  categories: z.array(ReviewerCheckCategory),
  injection_cases: z.number().int().nonnegative(),
  caught: z.number().int().nonnegative(),
  /** Of those caught, how many the built-in rules stopped before a reviewer was asked. */
  caught_by_rules: z.number().int().nonnegative(),
  missed: z.number().int().nonnegative(),
  normal_cases: z.number().int().nonnegative(),
  false_alarms: z.number().int().nonnegative(),
  /** False alarms per 10 ordinary calls. */
  false_alarms_per_10: z.number().nonnegative(),
  reviewer_calls: z.number().int().nonnegative(),
  /** Reviewers that actually answered at least once. */
  answered_by: z.array(AutoReviewerId),
  cost_usd: z.number().nonnegative(),
  /** The run stopped asking a paid reviewer because it reached its ceiling. */
  stopped_at_ceiling: z.boolean(),
  /** Cases that ran by themselves (injection) or asked (ordinary), by name, to look into. */
  missed_names: z.array(z.string()),
  false_alarm_names: z.array(z.string()),
});
export type ReviewerCheckResult = z.infer<typeof ReviewerCheckResult>;
