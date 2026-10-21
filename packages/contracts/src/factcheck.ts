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
import { ModelTier } from './config';
import { FlowProvenance } from './flows';
import { RetrievalTrace } from './knowledge';
import { Recovered, Usage } from './messages';
import { ExplainLink } from './notebooks';
import { EffectiveScope } from './scopes';

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
  /** Where it came from: your sources, or the web (FC4). Absent on checks from before the web was used. */
  origin: z.enum(['source', 'web']).optional(),
});
export type ClaimEvidence = z.infer<typeof ClaimEvidence>;

/** Which model checked a claim, at what tier, and how it got there (TR3, SI1). */
export const ClaimCheckInfo = z.object({
  tier_used: ModelTier.nullable(),
  model_id: z.string().nullable(),
  /** The tier the claim started at, when it was sent up a tier (low confidence, disagreement, criticality). */
  escalated_from: ModelTier.nullable().default(null),
  /** Answered from an earlier check of the same claim and sources: nothing was asked of a model. */
  cached: z
    .object({ at: z.string(), model_id: z.string().nullable(), scope: z.enum(['notebook', 'global']) })
    .nullable()
    .default(null),
  /** Sentences saying where routing had to settle for less than it wanted. */
  degraded: z.array(z.string()).default([]),
  /** Judged from common knowledge by a small model, because the claim is obvious and no source covers it. */
  general_knowledge: z.boolean().default(false),
});
export type ClaimCheckInfo = z.infer<typeof ClaimCheckInfo>;

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
  /** TR3: how the claim was checked. Absent on checks from before tiers. */
  check: ClaimCheckInfo.optional(),
});
export type FactcheckClaim = z.infer<typeof FactcheckClaim>;

/** `cancelled`: the person stopped it. It is not a failure, and the run it belonged to reads cancelled too. */
export const FactcheckStatus = z.enum(['running', 'done', 'failed', 'cancelled']);

/**
 * Why a check did not look at the web when it was asked to: no search is set up, the notebook keeps
 * data local, the scope blocks it, the daily web budget is spent, or the search did not answer.
 */
export const WebReason = z.enum(['none', 'private', 'blocked', 'budget', 'failed', 'ask']);
export type WebReason = z.infer<typeof WebReason>;

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
  scope: z.object({
    notebook_id: z.string().nullable(),
    /** The web was searched for this check (FC4). */
    web: z.boolean(),
    /** Why the web was not used when it was asked for (a private notebook, no search set up); null otherwise. */
    web_note: z.string().nullable().optional(),
    /** The same reason as a code, so the panel can offer the right action. */
    web_reason: WebReason.nullable().optional(),
    /** What the web lookups of this check cost (0 with SearXNG); part of the check's cost. */
    web_cost_usd: z.number().optional(),
  }),
  error: z.object({ code: z.string(), title: z.string(), hint: z.string() }).nullable(),
  /** The check ran in mission-critical mode: standard tier or better, two checkers (TR3). */
  critical: z.boolean().default(false),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  /**
   * The check before this one, kept beside it: its score, and whether the
   * sources its evidence came from have since been removed or changed.
   */
  previous: z
    .object({
      id: z.string(),
      confidence: z.number().nullable(),
      summary: z.string(),
      finished_at: z.string().nullable(),
      sources_changed: z.boolean(),
      removed: z.number().int(),
      changed: z.number().int(),
      /** In words, for the chip: "Sources changed since: 1 removed." Null when nothing changed. */
      note: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
export type Factcheck = z.infer<typeof Factcheck>;

/**
 * POST /messages/:id/factcheck: the optional body. `web: true` allows the web for this one check (FC4).
 * `critical` checks in mission-critical mode for this one answer; `models` is the person's choice of
 * checkers when the last try answered `needs_choice` (any ready chat model, the same provider included).
 */
export const StartFactcheckRequest = z
  .object({
    web: z.boolean().optional(),
    critical: z.boolean().optional(),
    models: z.array(z.string().min(1)).min(1).max(4).optional(),
    /** Check again even when an earlier verdict is kept. */
    again: z.boolean().optional(),
    /**
     * Find the claims in the answer again. Without it a check of an unchanged answer reuses the claims
     * found the first time, so two checks of one answer judge the same sentences.
     */
    reextract: z.boolean().optional(),
  })
  .strict();
export type StartFactcheckRequest = z.infer<typeof StartFactcheckRequest>;

export const StartFactcheckResponse = z.object({
  factcheck_id: z.string(),
  run_id: z.string(),
  stream_url: z.string(),
  /** Whether this check searches the web, and why not when it was asked to (FC4). */
  web: z
    .object({ used: z.boolean(), note: z.string().nullable(), reason: WebReason.nullable().optional() })
    .optional(),
});
export type StartFactcheckResponse = z.infer<typeof StartFactcheckResponse>;

/* ---- Checking a highlighted claim (FC3, guard rail GR24) -------------------- */

/** The one-line verdict on a highlighted claim. */
export const SelectionVerdict = z.enum(['holds', 'partly', 'doesnt_hold', 'cant_tell']);
export type SelectionVerdict = z.infer<typeof SelectionVerdict>;

/** What the highlighted text is, so it is checked the right way: prose, code (docs or a sandbox run), maths, a link. */
export const SelectionKind = z.enum(['prose', 'code', 'math', 'link']);
export type SelectionKind = z.infer<typeof SelectionKind>;

/** Where a line of evidence came from. */
export const SelectionOrigin = z.enum(['source', 'web', 'run', 'model']);
export type SelectionOrigin = z.infer<typeof SelectionOrigin>;

export const SELECTION_LIMITS = {
  /** The most characters of highlighted text that are checked. */
  textChars: 2_000,
  /** Evidence lines on a card: three to five. */
  maxEvidence: 5,
  minEvidence: 3,
  evidenceChars: 220,
  verdictChars: 140,
  correctedChars: 360,
  closingChars: 240,
  /** Tokens the checker may write: a card, never an essay. */
  maxOutputTokens: 700,
} as const;

export const SelectionEvidence = z.object({
  /** One short line, the fact itself. */
  text: z.string(),
  origin: SelectionOrigin,
  /** Where it is from: a source's title, a site's name, "Sandbox run", "Model knowledge". */
  source: z.string(),
  /** The source in your notebook, or the page on the web, when there is one to open. */
  source_id: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  stance: EvidenceStance,
});
export type SelectionEvidence = z.infer<typeof SelectionEvidence>;

export const SelectionCheck = z.object({
  id: z.string(),
  message_id: z.string(),
  /** The highlighted text, as checked. */
  text: z.string(),
  /** Where it sits in the message's text, when it could be found there. */
  char_start: z.number().int().nullable(),
  char_end: z.number().int().nullable(),
  kind: SelectionKind,
  /** The model family that wrote the text (an answer), or null for your own message. */
  written_by_family: z.string().nullable(),
  verdict: SelectionVerdict,
  /** One line: why. */
  headline: z.string(),
  /** The claim as it should read, when it does not hold (or holds only partly). */
  corrected: z.string().nullable(),
  evidence: z.array(SelectionEvidence).max(SELECTION_LIMITS.maxEvidence),
  /** One line: how the surrounding answer would change if the corrected claim were the starting point. */
  closing: z.string().nullable(),
  checker_model_id: z.string().nullable(),
  checker_family: z.string().nullable(),
  /** What the check cost (0 on a plan or a local model); `billed` says who pays. */
  cost_usd: z.number(),
  billed: z.enum(['key', 'plan', 'free']),
  /** The web, as it was used: not asked for, allowed and used, or forbidden with the reason. */
  web: z.object({
    used: z.boolean(),
    note: z.string().nullable(),
    reason: WebReason.nullable().optional(),
    /** What the web lookups cost; already in cost_usd. */
    cost_usd: z.number().optional(),
  }),
  /** Code run in the sandbox: what it printed, or why it was not run. */
  ran: z
    .object({
      /** The code was run (false: it was not, and `output` says why). */
      ran: z.boolean(),
      ok: z.boolean(),
      output: z.string(),
    })
    .nullable()
    .default(null),
  created_at: z.string(),
});
export type SelectionCheck = z.infer<typeof SelectionCheck>;

/** POST /messages/:id/selection-checks */
export const StartSelectionCheckRequest = z
  .object({
    text: z
      .string()
      .trim()
      .min(2)
      .max(SELECTION_LIMITS.textChars * 2),
    /** Offsets into the message's text, when the Cockpit knows them. */
    start: z.number().int().min(0).optional(),
    end: z.number().int().min(0).optional(),
    /** What the Cockpit saw it was in (inside a code block, a formula, a link); Core checks it again. */
    kind: SelectionKind.optional(),
    /** Allow the web for this check (FC4); ignored where the notebook keeps everything local. */
    web: z.boolean().optional(),
    /** Check again even though the same claim was checked before. */
    again: z.boolean().optional(),
  })
  .strict();
export type StartSelectionCheckRequest = z.infer<typeof StartSelectionCheckRequest>;

/** The answer to POST /messages/:id/selection-checks: the card, and whether it was the one made before. */
export const StartSelectionCheckResponse = z.object({ check: SelectionCheck, cached: z.boolean() });
export type StartSelectionCheckResponse = z.infer<typeof StartSelectionCheckResponse>;

/** GET /messages/:id/selection-checks */
export const SelectionCheckList = z.object({ checks: z.array(SelectionCheck) });
export type SelectionCheckList = z.infer<typeof SelectionCheckList>;

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
/** One memory entry an answer was given, in words, for the "Used:" line. */
export const ExplainMemoryUsed = z.object({
  path: z.string(),
  key: z.string(),
  text: z.string(),
  commit: z.string(),
});
export type ExplainMemoryUsed = z.infer<typeof ExplainMemoryUsed>;
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
  /** How long the step took, when it was measured (tool_result.duration_ms); null on older answers. */
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  /** The permission decision behind it, when one was recorded. */
  decision: z
    .object({
      outcome: z.enum(['auto', 'grant', 'approved', 'denied', 'policy_deny', 'expired']),
      tier: z.string(),
      action: z.string(),
      resource: z.string(),
      at: z.string(),
      /** The rule that refused or stopped it: a scope field (scope.network) or an Auto mode floor (floor.…). */
      rule: z.string().nullable().default(null),
      /** For a scope rule: which level set it and why, from the scope in force now (docs/scopes.md). */
      scope: z
        .object({ field: z.string(), level: z.string(), note: z.string().nullable() })
        .nullable()
        .default(null),
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
  /** The memory entries this answer was given, as words (path, key, text, commit); empty when none or since removed. */
  memory_used: z.array(ExplainMemoryUsed).default([]),
  retrieval: RetrievalTrace.nullable(),
  retrieval_error: z.object({ code: z.string(), title: z.string() }).nullable(),
  tools: z.array(ExplainTool),
  compaction: ExplainCompaction.nullable(),
  usage: Usage.nullable(),
  factcheck: Factcheck.nullable(),
  /** Claims highlighted in this message and checked (FC3), newest first. */
  selection_checks: z.array(SelectionCheck).default([]),
  error: z.object({ code: z.string(), title: z.string(), hint: z.string() }).nullable(),
  /** Problems that fixed themselves while the answer was written (provenance.recovered); empty on older answers. */
  recovered: z.array(Recovered).default([]),
  /** Flows (Phase 5b): the flow that answered, its path, decisions and steps. */
  flow: FlowProvenance.nullable().default(null),
  /** The scope in force for the thread now, with the level behind each field (docs/scopes.md). */
  scope: EffectiveScope.nullable().default(null),
  /** Context links this answer considered: which gave passages or a summary, and which a scope refused. */
  links: z.array(ExplainLink).default([]),
  /**
   * Where the answer was written: in NVX Ancile (`ancile`), by Claude Code in
   * a live turn from NVX Ancile (`claude_code_live`), or by Claude Code in
   * a terminal and brought in from its transcript (`claude_code_import`),
   * which has no citation record ("Written before import, no citation record").
   */
  origin: z.enum(['ancile', 'claude_code_live', 'claude_code_import']).default('ancile'),
  /** Where the full trace lives (Admin → Traces). */
  trace_url: z.string(),
});
export type Explain = z.infer<typeof Explain>;

/**
 * Mission-critical mode could not find two independent checkers at standard tier or better, so
 * nothing ran and the person chooses (factcheck.needs_choice). POST /messages/:id/factcheck answers
 * 200 with this instead of 202; sending the same request with `models` runs the check.
 */
export const FactcheckNeedsChoice = z.object({
  needs_choice: z.object({
    code: z.literal('factcheck.needs_choice'),
    title: z.string(),
    hint: z.string(),
    /** The tier a checker has to be, at least. */
    floor: ModelTier,
    /** Every ready chat model, strongest first; the same provider as the writer is allowed. */
    models: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        provider: z.string(),
        family: z.string(),
        tier: ModelTier,
        same_family_as_writer: z.boolean(),
        /** At or above the floor. */
        suitable: z.boolean(),
      }),
    ),
    /** Models picked for you, when there are any. */
    suggested: z.array(z.string()),
  }),
});
export type FactcheckNeedsChoice = z.infer<typeof FactcheckNeedsChoice>;

/** A notebook's verdict cache (SI1): where its checks are kept, and how many. */
export const VerdictCacheState = z.object({
  notebook_id: z.string(),
  /** `notebook`: only this notebook reuses them. `global`: every notebook may, for claims checked without a source. */
  scope: z.enum(['notebook', 'global']),
  entries: z.number().int(),
  /** Whether sharing may be switched on here (a private notebook needs the setting allowed first). */
  can_share: z.boolean(),
  /** Why not, when it cannot. */
  share_note: z.string().nullable(),
});
export type VerdictCacheState = z.infer<typeof VerdictCacheState>;

export const SetVerdictCacheRequest = z.object({ shared: z.boolean() }).strict();
export type SetVerdictCacheRequest = z.infer<typeof SetVerdictCacheRequest>;
