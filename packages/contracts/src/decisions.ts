/**
 * ------------------------------------------------------------------
 *  Title    |  Decision models: one interface, typed answers
 *  Ref      |  docs/decisions.md · DESIGN.md D30 · docs/privacy.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The one request and answer shape every decision caller
 *           |  uses (Auto review, flow routers, the fact-check triage,
 *           |  Keystone intent, automations), the routes that can
 *           |  serve it, and the settings and meters behind Settings →
 *           |  Decisions.
 *  How      |  A decision model gets a state and typed questions (noul
 *           |  yes/no, choice, score, box) and answers each with
 *           |  probabilities, not prose. Jev, Cloudflare Clef, Clef-
 *           |  flash, Perplexity's deciders and the OpenAI Decisions
 *           |  preview share this shape; Core's router picks a route
 *           |  per task (free allowances first, then the cheapest
 *           |  that suits), within caps and the privacy policy.
 *  Note     |  These models bill input tokens only and offer no
 *           |  provider-side prompt caching: a receipt never claims a
 *           |  cache saving. Output is free, so output_tokens is kept
 *           |  for information and never priced.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Who asks. Each task has a profile: fast sorting or reasoning (core/decisions/tasks.ts). */
export const DecisionTaskId = z.enum([
  'auto_review',
  'flow_router',
  'flow_condition',
  'factcheck_triage',
  'keystone_intent',
  'automation',
]);
export type DecisionTaskId = z.infer<typeof DecisionTaskId>;

export const DecisionProviderId = z.enum([
  'local',
  'cloudflare',
  'typesafe',
  'openrouter',
  'perplexity',
  'openai',
]);
export type DecisionProviderId = z.infer<typeof DecisionProviderId>;

/** One way to reach one decision model. */
export const DecisionRouteId = z.enum([
  'local_jev',
  'cf_clef_flash',
  'cf_clef',
  'jev_openrouter',
  'jev_direct',
  'or_clef_flash',
  'or_pplx_flash',
  'pplx_flash',
  'pplx_decider',
  'openai_luna',
]);
export type DecisionRouteId = z.infer<typeof DecisionRouteId>;

/* ---- the request ------------------------------------------------------------------- */

const Text = z.string().max(2000);

export const NoulQuestion = z.object({
  type: z.literal('noul'),
  instructions: z.union([Text, z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  criteria: z.object({ true: Text, false: Text }).optional(),
});
export const ChoiceQuestion = z.object({
  type: z.literal('choice'),
  instructions: Text,
  /** option name → what it means. */
  criteria: z.record(z.string().min(1).max(120), Text),
});
export const ScoreQuestion = z.object({
  type: z.literal('score'),
  instructions: Text,
  /** The ordered levels, lowest first. */
  criteria: z.array(Text).min(2).max(10),
});
/** Locates something in an image. Jev 1.14 only (OpenRouter's guide: 1.13 answers 400). */
export const BoxQuestion = z.object({ type: z.literal('box'), instructions: Text });

export const DecisionQuestion = z.discriminatedUnion('type', [
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  BoxQuestion,
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestion>;

export const DecisionRequest = z.object({
  /** The content to judge: text, or structured data. Quoted data, never instructions. */
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z.record(z.string().min(1).max(64), DecisionQuestion).refine((q) => {
    const n = Object.keys(q).length;
    return n >= 1 && n <= 64;
  }, 'Between 1 and 64 questions'),
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;

/* ---- the answer -------------------------------------------------------------------- */

export const DecisionAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()),
  }),
  /** Passed through as the provider sent it. */
  z.object({ type: z.literal('box'), box: z.unknown() }),
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

/**
 * What one decision cost. Input tokens are billed, output is free, and there is
 * no provider-side caching, so there is no cache field to claim a saving with.
 */
export const DecisionReceipt = z.object({
  route: DecisionRouteId,
  provider: DecisionProviderId,
  model: z.string(),
  task: DecisionTaskId,
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  /** USD for this call; 0 when it ran on a free allowance or on this machine. */
  cost_usd: z.number().nonnegative(),
  /** Where the cost came from: the provider's own figure, our list price, or nothing to bill. */
  cost_basis: z.enum(['reported', 'listed', 'free']),
  /** Counted against a free allowance (id), else null. */
  allowance: z.string().nullable(),
  /** Neurons or other units counted against that allowance. */
  allowance_used: z.number().nonnegative(),
  /** Tokens were counted by us (about four characters each), not reported. */
  estimated: z.boolean(),
  at: z.string(),
});
export type DecisionReceipt = z.infer<typeof DecisionReceipt>;

/* ---- settings and meters ----------------------------------------------------------- */

export const DecisionCap = z.object({
  scope: z.enum(['provider', 'route', 'model']),
  /** The provider id, route id or model id. */
  key: z.string().min(1).max(120),
  usd_per_day: z.number().nonnegative().max(1000),
});
export type DecisionCap = z.infer<typeof DecisionCap>;

/** The default order for a person who has not changed it (cheapest suited route wins within it). */
export const DEFAULT_DECISION_ORDER: DecisionRouteId[] = [
  'local_jev',
  'cf_clef_flash',
  'cf_clef',
  'jev_openrouter',
  'jev_direct',
  'pplx_flash',
  'pplx_decider',
  'or_pplx_flash',
  'or_clef_flash',
  'openai_luna',
];

/** Routes that stay off until a person turns them on (a preview that may refuse the key). */
export const DECISION_ROUTES_OFF_BY_DEFAULT: DecisionRouteId[] = ['openai_luna'];

export const DecisionSettings = z.object({
  /** Use every free allowance before any paid route. On by default. */
  free_first: z.boolean().default(true),
  /** Routes in the order a tie falls to. */
  order: z.array(DecisionRouteId).default(DEFAULT_DECISION_ORDER),
  /** Routes switched off. */
  disabled: z.array(DecisionRouteId).default(DECISION_ROUTES_OFF_BY_DEFAULT),
  /** Free allowance id → the most we will count before switching away (the margin is limit minus this). */
  ceilings: z.record(z.string(), z.number().nonnegative()).default({}),
  /** Most spend, per day (UTC), for a provider, route or model. Providers default to DEFAULT_PROVIDER_CAP_USD. */
  caps: z.array(DecisionCap).max(40).default([]),
  /**
   * A decision server on this computer or the person's own GPU node (Clef-flash served with vLLM or
   * SGLang, or laya-serve). It speaks the Jev API at POST {url}/v1/systemone. Counts as private.
   */
  local: z
    .object({
      url: z.string().url().max(300).nullable().default(null),
      model: z.string().max(120).default('Cloudflare/clef-flash'),
    })
    .default({ url: null, model: 'Cloudflare/clef-flash' }),
});
export type DecisionSettings = z.infer<typeof DecisionSettings>;

export const PutDecisionSettingsRequest = DecisionSettings.partial().strict();
export type PutDecisionSettingsRequest = z.infer<typeof PutDecisionSettingsRequest>;

/** The most a provider may cost in a day when no cap is set: decisions cost a few millionths each. */
export const DEFAULT_PROVIDER_CAP_USD = 1;

export const DecisionRouteState = z.enum([
  'ready',
  /** No key, or no local server set. */
  'not_connected',
  'disabled',
  /** Out of free allowance or over a cap until the reset. */
  'spent',
  /** The provider said no (out of credit, not enabled for this key); until `until`. */
  'refused',
  /** Private notebooks only: hosted routes are not allowed here. */
  'private_blocked',
]);
export type DecisionRouteState = z.infer<typeof DecisionRouteState>;

export const DecisionRouteInfo = z.object({
  id: DecisionRouteId,
  provider: DecisionProviderId,
  label: z.string(),
  model: z.string(),
  runs_on_this_machine: z.boolean(),
  tier: z.enum(['fast', 'reasoning']),
  input_per_mtok_usd: z.number().nullable(),
  state: DecisionRouteState,
  /** In the provider's words, or ours, when state is not ready. */
  reason: z.string().nullable(),
  until: z.string().nullable(),
  /** Allowance it draws on, if any. */
  allowance: z.string().nullable(),
  spent_today_usd: z.number(),
  /** Documented by the provider's own pages when we last checked (checked 2026-10-20). */
  verified: z.boolean(),
  source: z.string(),
});
export type DecisionRouteInfo = z.infer<typeof DecisionRouteInfo>;

export const AllowanceMeter = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  used: z.number(),
  /** What the provider gives free. */
  limit: z.number(),
  /** The most we count before switching away. */
  ceiling: z.number(),
  resets_at: z.string(),
  source: z.string(),
});
export type AllowanceMeter = z.infer<typeof AllowanceMeter>;

export const DecisionStatus = z.object({
  settings: DecisionSettings,
  routes: z.array(DecisionRouteInfo),
  meters: z.array(AllowanceMeter),
  recent: z.array(DecisionReceipt).max(50),
  /** A decision server on this machine answers right now. */
  local_available: z.boolean(),
});
export type DecisionStatus = z.infer<typeof DecisionStatus>;
