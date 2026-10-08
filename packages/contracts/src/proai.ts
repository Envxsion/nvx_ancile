/**
 * Pro features that work on answers (DESIGN.md §9): Beam, Insights and the
 * Flow lab. Only the shapes are public, so the Cockpit and the private
 * implementation agree; what they do lives in pro/. A free build answers
 * every one of these routes with `pro.locked`.
 */
import { z } from 'zod';

/* ---- Beam: ask several models at once, then fuse ----------------------------- */

export const BeamMember = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), model: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('flow'), flow_id: z.string().min(1) }).strict(),
]);
export type BeamMember = z.infer<typeof BeamMember>;

export const BeamSet = z
  .object({
    members: z.array(BeamMember).min(2).max(6),
    /** The model that writes the fused answer; null: the workspace default. */
    fuser: z.string().nullable(),
  })
  .strict();
export type BeamSet = z.infer<typeof BeamSet>;

export const BeamEstimateRequest = BeamSet.extend({
  text: z.string().min(1).max(100_000),
  thread_id: z.string().nullable().optional(),
}).strict();
export type BeamEstimateRequest = z.infer<typeof BeamEstimateRequest>;

export const BeamEstimate = z.object({
  members: z.array(
    z.object({
      member: BeamMember,
      label: z.string(),
      ready: z.boolean(),
      /** Why it cannot answer (no key, switched off, flow invalid). */
      problem: z.string().nullable(),
      cost_usd: z.number(),
    }),
  ),
  fuse: z.object({ model: z.string().nullable(), label: z.string(), cost_usd: z.number() }),
  total_usd: z.number(),
});
export type BeamEstimate = z.infer<typeof BeamEstimate>;

export const StartBeamRequest = BeamSet.extend({
  text: z.string().min(1).max(100_000),
  /** null or absent: a new thread (in the notebook, if given). */
  thread_id: z.string().nullable().optional(),
  notebook_id: z.string().nullable().optional(),
  /** The message this question replies to; absent: the thread's active head. */
  parent_id: z.string().nullable().optional(),
  /** false: keep the answers side by side and do not fuse them. */
  fuse: z.boolean().default(true),
}).strict();
export type StartBeamRequest = z.infer<typeof StartBeamRequest>;

export const BeamStepStatus = z.enum(['waiting', 'running', 'done', 'failed', 'stopped', 'skipped']);

export const BeamCandidate = z.object({
  member: BeamMember,
  label: z.string(),
  run_id: z.string(),
  assistant_message_id: z.string(),
  status: BeamStepStatus,
  model_id: z.string().nullable(),
  cost_usd: z.number().nullable(),
  ms: z.number().nullable(),
});
export type BeamCandidate = z.infer<typeof BeamCandidate>;

export const Beam = z.object({
  id: z.string(),
  thread_id: z.string(),
  user_message_id: z.string(),
  set: BeamSet,
  candidates: z.array(BeamCandidate),
  fuse: z.object({
    status: BeamStepStatus,
    model: z.string().nullable(),
    run_id: z.string().nullable(),
    assistant_message_id: z.string().nullable(),
    error: z.string().nullable(),
  }),
  status: z.enum(['running', 'done', 'failed']),
  created_at: z.string(),
});
export type Beam = z.infer<typeof Beam>;

/** provenance.beam on a candidate or a fused answer. */
export const BeamProvenance = z.object({
  beam_id: z.string(),
  role: z.enum(['candidate', 'fused']),
  label: z.string().optional(),
  /** On the fused answer: what each candidate gave it, in the fuser's words. */
  contributions: z
    .array(z.object({ label: z.string(), message_id: z.string(), used: z.string() }))
    .optional(),
});
export type BeamProvenance = z.infer<typeof BeamProvenance>;

/* ---- Insights: your own history, on this computer ---------------------------- */

export const InsightsQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  notebook_id: z.string().optional(),
  bucket: z.enum(['day', 'week', 'month']).default('day'),
});
export type InsightsQuery = z.infer<typeof InsightsQuery>;

const Pct = z.number().min(0).max(1);

export const InsightsReport = z.object({
  range: z.object({ from: z.string(), to: z.string(), bucket: z.enum(['day', 'week', 'month']) }),
  totals: z.object({
    answers: z.number(),
    cost_usd: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    failure_rate: Pct,
    fallback_rate: Pct,
    regenerate_rate: Pct,
  }),
  series: z.array(z.object({ t: z.string(), answers: z.number(), cost_usd: z.number(), tokens: z.number() })),
  by_model: z.array(
    z.object({
      model_id: z.string(),
      name: z.string(),
      provider: z.string(),
      answers: z.number(),
      cost_usd: z.number(),
      tokens: z.number(),
      p50_ms: z.number().nullable(),
      p95_ms: z.number().nullable(),
      failure_rate: Pct,
      fallback_rate: Pct,
    }),
  ),
  by_provider: z.array(z.object({ provider: z.string(), answers: z.number(), cost_usd: z.number() })),
  by_notebook: z.array(
    z.object({
      notebook_id: z.string().nullable(),
      title: z.string(),
      answers: z.number(),
      cost_usd: z.number(),
    }),
  ),
  by_flow: z.array(
    z.object({
      flow_id: z.string(),
      name: z.string(),
      answers: z.number(),
      cost_usd: z.number(),
      /** Signals that an answer was not good enough: asked again, or the question edited. */
      regenerate_rate: Pct,
      edit_rate: Pct,
      /** Mean fact-check confidence of its fact-checked answers. */
      factcheck: z.number().nullable(),
      routes: z.array(z.object({ route: z.string(), answers: z.number(), regenerate_rate: Pct })),
    }),
  ),
  memory: z.array(z.object({ t: z.string(), changes: z.number() })),
  busy: z.object({ by_hour: z.array(z.number()).length(24), by_weekday: z.array(z.number()).length(7) }),
  generated_at: z.string(),
});
export type InsightsReport = z.infer<typeof InsightsReport>;

export const INSIGHTS_EXPORTS = ['series', 'by_model', 'by_provider', 'by_notebook', 'by_flow'] as const;

/* ---- Flow lab: test sets, shadow flows, a router that learns ------------------- */

export const EvalSet = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** How the judge scores an answer, in plain words. */
  rubric: z.string(),
  notebook_id: z.string().nullable(),
  item_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type EvalSet = z.infer<typeof EvalSet>;

export const CreateEvalSetRequest = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).default(''),
    rubric: z.string().max(4_000).default(''),
    notebook_id: z.string().nullable().default(null),
  })
  .strict();
export const PatchEvalSetRequest = CreateEvalSetRequest.partial().strict();

export const EvalItem = z.object({
  id: z.string(),
  set_id: z.string(),
  question: z.string(),
  /** An answer you accepted; the judge compares against it when there is one. */
  expected: z.string().nullable(),
  /** The conversation it came from, so a run sees the same context. */
  thread_id: z.string().nullable(),
  head_id: z.string().nullable(),
  source_message_id: z.string().nullable(),
  created_at: z.string(),
});
export type EvalItem = z.infer<typeof EvalItem>;

export const AddEvalItemsRequest = z
  .object({
    /** Answers to turn into items: the question before each, and the answer as expected. */
    message_ids: z.array(z.string()).max(200).default([]),
    items: z
      .array(
        z.object({ question: z.string().min(1).max(20_000), expected: z.string().max(50_000).nullable() }),
      )
      .max(200)
      .default([]),
  })
  .strict();

export const EvalTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flow'),
    flow_id: z.string(),
    version: z.number().int().nullable().default(null),
  }),
  z.object({ kind: z.literal('model'), model: z.string() }),
]);
export type EvalTarget = z.infer<typeof EvalTarget>;

export const StartEvalRunRequest = z
  .object({
    target: EvalTarget,
    /** The model that scores answers against the rubric; null: the workspace default. */
    judge: z.string().nullable().default(null),
    factcheck: z.boolean().default(false),
    /** Stand-in models: checks the wiring, costs nothing, scores mean nothing. */
    mock: z.boolean().default(false),
  })
  .strict();

export const EvalResult = z.object({
  item_id: z.string(),
  answer: z.string(),
  score: z.number().min(0).max(1).nullable(),
  reason: z.string(),
  factcheck: z.number().nullable(),
  cost_usd: z.number(),
  ms: z.number(),
  error: z.string().nullable(),
});
export type EvalResult = z.infer<typeof EvalResult>;

export const EvalRun = z.object({
  id: z.string(),
  set_id: z.string(),
  target: EvalTarget,
  label: z.string(),
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  progress: z.object({ done: z.number(), total: z.number() }),
  summary: z.object({
    score: z.number().nullable(),
    factcheck: z.number().nullable(),
    cost_usd: z.number(),
    p50_ms: z.number().nullable(),
    p95_ms: z.number().nullable(),
    failures: z.number(),
  }),
  results: z.array(EvalResult),
  mock: z.boolean(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type EvalRun = z.infer<typeof EvalRun>;

export const ShadowConfig = z
  .object({
    scope: z.enum(['workspace', 'notebook']),
    scope_ref: z.string().nullable(),
    flow_id: z.string(),
    enabled: z.boolean(),
    /** Share of live answers it runs beside (cost control). */
    sample: z.number().min(0).max(1),
  })
  .strict();
export type ShadowConfig = z.infer<typeof ShadowConfig>;

export const ShadowResult = z.object({
  id: z.string(),
  flow_id: z.string(),
  thread_id: z.string(),
  user_message_id: z.string(),
  live_message_id: z.string(),
  live_flow_id: z.string().nullable(),
  question: z.string(),
  answer: z.string(),
  live_answer: z.string(),
  cost_usd: z.number(),
  live_cost_usd: z.number().nullable(),
  ms: z.number(),
  error: z.string().nullable(),
  /** You said which answer was better: null until you do. */
  preferred: z.enum(['shadow', 'live', 'same']).nullable(),
  at: z.string(),
});
export type ShadowResult = z.infer<typeof ShadowResult>;

export const RouterLearning = z.object({
  flow_id: z.string(),
  node_id: z.string(),
  /** off: learn only; suggest: show where it would differ; decide: route by itself when sure. */
  mode: z.enum(['off', 'suggest', 'decide']),
  /** How sure it must be to decide on its own. */
  threshold: z.number().min(0.5).max(1),
  examples: z.number(),
  labelled: z.number(),
  /** Leave-one-out agreement with your choices; null with fewer than 5 examples. */
  accuracy: z.number().nullable(),
  per_route: z.record(z.string(), z.number()),
  trained_at: z.string().nullable(),
});
export type RouterLearning = z.infer<typeof RouterLearning>;

export const RouterSuggestion = z.object({
  message_id: z.string(),
  text: z.string(),
  router_chose: z.array(z.string()),
  learned: z.object({
    route: z.string(),
    confidence: z.number(),
    like: z.array(z.object({ text: z.string(), route: z.string() })),
  }),
  agrees: z.boolean(),
  at: z.string(),
});
export type RouterSuggestion = z.infer<typeof RouterSuggestion>;

export const PatchRouterLearningRequest = z
  .object({ mode: RouterLearning.shape.mode.optional(), threshold: z.number().min(0.5).max(1).optional() })
  .strict();
