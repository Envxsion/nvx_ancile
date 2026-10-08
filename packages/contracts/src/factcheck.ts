/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-checking and "why did it say this?"
 *  Ref      |  DESIGN.md §10, §11.4
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes of a fact-check (claims, their evidence and
 *           |  their confidence, broken down so it can be explained in
 *           |  words) and of an answer's explanation: model attempts,
 *           |  memory read, passages retrieved, tools and the decisions
 *           |  that let them run, compaction, cost, fact-check.
 *  How      |  POST /messages/:id/factcheck starts a durable run of kind
 *           |  'factcheck' and answers 202 with its ids; GET returns the
 *           |  latest result. GET /messages/:id/explain assembles the
 *           |  rest from provenance, run steps and decisions.
 * ------------------------------------------------------------------
 */
import { z } from 'zod';
import { FlowProvenance } from './flows';
import { RetrievalTrace } from './knowledge';
import { Usage } from './messages';

export const ClaimVerdict = z.enum(['verified', 'unverified', 'contradicted', 'not_checkable']);
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;

export const EvidenceStance = z.enum(['supports', 'contradicts', 'neutral']);
export type EvidenceStance = z.infer<typeof EvidenceStance>;

export const ClaimEvidence = z.object({
  kind: z.enum(['chunk', 'insight', 'url']),
  /** chunk id, insight id, or URL */
  ref: z.string(),
  source_id: z.string().nullable(),
  source_title: z.string(),
  page: z.number().int().nullable(),
  /** The quote's span in the source, so the viewer can open on it. */
  char_start: z.number().int().nullable(),
  char_end: z.number().int().nullable(),
  quote: z.string(),
  stance: EvidenceStance,
  /** How closely this passage matches the claim, in [0, 1]. */
  score: z.number(),
});
export type ClaimEvidence = z.infer<typeof ClaimEvidence>;

export const FactcheckClaim = z.object({
  id: z.string(),
  text: z.string(),
  /** Offsets into the answer's text (its text parts joined). */
  char_start: z.number().int(),
  char_end: z.number().int(),
  importance: z.number(),
  verdict: ClaimVerdict,
  confidence: z.number(),
  support: z.number(),
  agreement: z.number(),
  retrieval: z.number(),
  evidence: z.array(ClaimEvidence),
  rationale: z.string(),
  /** The confidence breakdown in words, for the tooltip. */
  explanation: z.string(),
});
export type FactcheckClaim = z.infer<typeof FactcheckClaim>;

export const FactcheckStatus = z.enum(['running', 'done', 'failed']);

export const Factcheck = z.object({
  id: z.string(),
  message_id: z.string(),
  run_id: z.string().nullable(),
  status: FactcheckStatus,
  /** Importance-weighted mean over checkable claims; null when nothing was checkable. */
  confidence: z.number().nullable(),
  verifier_model_id: z.string().nullable(),
  claims: z.array(FactcheckClaim),
  counts: z.object({
    verified: z.number().int(),
    unverified: z.number().int(),
    contradicted: z.number().int(),
    not_checkable: z.number().int(),
  }),
  /** Every checkable claim verified and none contradicted: the answer earns the seal. */
  sealed: z.boolean(),
  /** The message-level score in words. */
  summary: z.string(),
  /** Where the evidence came from. */
  scope: z.object({ notebook_id: z.string().nullable(), web: z.boolean() }),
  error: z.object({ code: z.string(), title: z.string(), hint: z.string() }).nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type Factcheck = z.infer<typeof Factcheck>;

export const StartFactcheckResponse = z.object({
  factcheck_id: z.string(),
  run_id: z.string(),
  stream_url: z.string(),
});
export type StartFactcheckResponse = z.infer<typeof StartFactcheckResponse>;

/** What Core asks Knowledge for: passages for each claim, with quotes. */
export const EvidenceRequest = z.object({
  workspace_id: z.string(),
  notebook_id: z.string().nullable(),
  claims: z.array(z.string().min(1)).min(1).max(50),
  k_per_claim: z.number().int().min(1).max(20).default(4),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequest>;

export const EvidenceHit = z.object({
  kind: z.enum(['chunk', 'insight']),
  chunk_id: z.string(),
  source_id: z.string(),
  source_title: z.string(),
  page: z.number().int().nullable(),
  heading_path: z.array(z.string()),
  text: z.string(),
  quote: z.string(),
  quote_start: z.number().int(),
  quote_end: z.number().int(),
  rerank_score: z.number().nullable(),
  /** Blend of reranker score and term overlap with the claim, in [0, 1]. */
  relevance: z.number(),
});
export type EvidenceHit = z.infer<typeof EvidenceHit>;

export const EvidenceResponse = z.object({
  results: z.array(
    z.object({
      claim: z.string(),
      hits: z.array(EvidenceHit),
      /** Share of the claim's content words found in its passages, in [0, 1]. */
      coverage: z.number(),
    }),
  ),
  mode: z.string(),
  embedder: z.string().nullable(),
  ms: z.number(),
});
export type EvidenceResponse = z.infer<typeof EvidenceResponse>;

/* ---- Explain (DESIGN.md §11.4) -------------------------------------------- */

/** What the memory module recorded as injected for this answer. */
export const ExplainMemory = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      commit: z.string(),
      entries: z.array(z.string()),
      tokens: z.number(),
      dropped: z.number(),
    }),
  ),
  tokens: z.number(),
  truncated: z.number(),
});
export type ExplainMemory = z.infer<typeof ExplainMemory>;

export const ExplainCompaction = z.object({
  summary_id: z.string(),
  upto_message_id: z.string(),
  tokens_before: z.number(),
  tokens_after: z.number(),
});
export type ExplainCompaction = z.infer<typeof ExplainCompaction>;

export const ExplainTool = z.object({
  call_id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  ok: z.boolean().nullable(),
  /** What happened, in words: the result preview, or why it did not run. */
  result: z.string().nullable(),
  declined_reason: z.string().nullable(),
  /** The permission decision behind it, when one was recorded. */
  decision: z
    .object({
      outcome: z.enum(['auto', 'grant', 'approved', 'denied', 'policy_deny', 'expired']),
      tier: z.string(),
      action: z.string(),
      resource: z.string(),
      at: z.string(),
    })
    .nullable(),
});
export type ExplainTool = z.infer<typeof ExplainTool>;

export const Explain = z.object({
  message_id: z.string(),
  thread_id: z.string(),
  status: z.string(),
  trace_id: z.string(),
  run_id: z.string().nullable(),
  model: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    requested: z.string().nullable(),
    chain: z.array(z.string()),
  }),
  attempts: z.array(z.object({ model: z.string(), reason: z.string(), detail: z.string() })),
  memory: ExplainMemory.nullable(),
  retrieval: RetrievalTrace.nullable(),
  retrieval_error: z.object({ code: z.string(), title: z.string() }).nullable(),
  tools: z.array(ExplainTool),
  compaction: ExplainCompaction.nullable(),
  usage: Usage.nullable(),
  factcheck: Factcheck.nullable(),
  error: z.object({ code: z.string(), title: z.string(), hint: z.string() }).nullable(),
  /** Flows (Phase 5b): the flow that answered, its path, decisions and steps. */
  flow: FlowProvenance.nullable().default(null),
  /** Where the full trace lives (Admin → Traces). */
  trace_url: z.string(),
});
export type Explain = z.infer<typeof Explain>;
