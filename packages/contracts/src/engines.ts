/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: one thread, any model
 *  Ref      |  docs/engines.md · docs/claude-code.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes for answering a thread's turns with more than
 *           |  one engine: NVX Ancile's own gateway (every configured
 *           |  model), the person's own Claude Code, and later other
 *           |  agent CLIs. A thread keeps its Claude Code binding while
 *           |  any turn may go to any model.
 *  How      |  The engine is chosen per message from the model id
 *           |  (`claude-code/<model>` is Claude Code). Each engine gets
 *           |  the thread's context assembled for it within its own
 *           |  budget (docs/engines.md), and the answer records how.
 *  Note     |  Engine kinds are an open set: `gateway` and
 *           |  `claude_code` today; a future adapter (Codex, Gemini CLI)
 *           |  adds its own lower-case kind without a contract change.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import { ClaudeCodeQueuedResult } from './claudecode';

/** Model ids with this prefix are answered by Claude Code (`claude-code/opus`, `claude-code/default`). */
export const CLAUDE_CODE_MODEL_PREFIX = 'claude-code/';
/** The provider name Claude Code's models carry in the model registry (Mode A). */
export const CLAUDE_CODE_PROVIDER = 'claude_code';

export const isClaudeCodeModel = (id: string | null | undefined): boolean =>
  !!id && id.startsWith(CLAUDE_CODE_MODEL_PREFIX);

/** `gateway`, `claude_code`, or a future adapter's own kind. */
export const EngineKind = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
export type EngineKind = z.infer<typeof EngineKind>;
export const KNOWN_ENGINES = ['gateway', 'claude_code'] as const;

export const EngineCapabilities = z.object({
  streaming: z.boolean(),
  /** It can call NVX Ancile's tools (always through the permission gate). */
  tools: z.boolean(),
  images: z.boolean(),
  /**
   * It keeps its own conversation (a Claude Code session): NVX Ancile never
   * re-sends it its own history, only a digest of what other engines said.
   */
  own_context: z.boolean(),
  /** Tokens it can read at once; null when the engine manages its own context. */
  context_window: z.number().int().positive().nullable(),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilities>;

/** GET /engines: one engine and whether it can answer now. */
export const EngineInfo = z.object({
  id: z.string(),
  kind: EngineKind,
  display_name: z.string(),
  available: z.boolean(),
  /** Why it cannot answer now, in words; null when it can. */
  reason: z.string().nullable(),
  capabilities: EngineCapabilities,
  /** Model ids that choose this engine (for Claude Code: `claude-code/…`). */
  model_prefix: z.string().nullable(),
});
export type EngineInfo = z.infer<typeof EngineInfo>;

export const EngineList = z.object({ items: z.array(EngineInfo) });
export type EngineList = z.infer<typeof EngineList>;

/**
 * POST /threads/:id/turns: one turn, answered by whichever engine the
 * model chooses. In a thread bound to a Claude Code session, no model (or
 * a `claude-code/…` model) carries the session on; any other model answers
 * through the gateway and the thread keeps its binding.
 */
export const SendTurnRequest = z
  .object({
    text: z.string().min(1).max(200_000),
    /** The message this turn answers from; absent: the thread's active head. */
    parent_id: z.string().nullable().optional(),
    /** Any model id, `claude-code/<model>` included; absent: the thread decides. */
    model: z.string().max(200).nullable().optional(),
    /** Claude Code only; "auto" lets Claude Code pick. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).nullable().optional(),
    /** Source ids to ground this turn on. */
    source_ids: z.array(z.string()).max(50).optional(),
    /** Images attached to this turn (POST /threads/:id/images); the model must see images (docs/images.md). */
    image_ids: z.array(z.string().max(60)).max(8).optional(),
    /** Claude Code only: fork the session even from its latest message. */
    as_branch: z.boolean().optional(),
    /** Gateway only. */
    task_class: z.string().max(80).optional(),
    /**
     * CLI session engines (Claude Code): wait instead of failing or
     * branching while the thread answers or a terminal holds the session.
     * The answer is then a ClaudeCodeQueuedResult (CC6).
     */
    queue_if_busy: z.boolean().optional(),
    idempotency_key: z.string().min(8).max(200),
  })
  .strict();
export type SendTurnRequest = z.infer<typeof SendTurnRequest>;

export const SendTurnResult = z.object({
  run_id: z.string(),
  user_message_id: z.string(),
  /** The answer being written (null only from an engine that names it later). */
  assistant_message_id: z.string().nullable(),
  engine: EngineKind,
  /** The model asked for, as given (null: the engine's default). */
  model_id: z.string().nullable(),
  /**
   * The one-line notice the composer shows when this turn sends thread
   * context to Claude Code ("This thread's context will be sent to Claude
   * Code"); null when nothing of the thread leaves for it.
   */
  context_notice: z.string().nullable(),
  /**
   * Claude Code only: the turn went on in a branch by itself, because a
   * Claude Code process outside NVX Ancile has the session open.
   */
  branched: z.enum(['open_in_terminal']).nullable().optional(),
});
export type SendTurnResult = z.infer<typeof SendTurnResult>;

/** POST /threads/:id/turns: a turn that started, or (queue_if_busy) one that waits. */
export const SendTurnOutcome = z.union([SendTurnResult, ClaudeCodeQueuedResult]);
export type SendTurnOutcome = z.infer<typeof SendTurnOutcome>;

/** The notice text, one line, for the composer and the run event. */
export const CLAUDE_CODE_CONTEXT_NOTICE = "This thread's context will be sent to Claude Code";
/** The notice when all that goes is a note on the notebook's sources (no turns, no summary). */
export const CLAUDE_CODE_SOURCES_NOTICE = 'A note on the sources that changed will be sent to Claude Code';

/** The notice that says what a turn actually sends: the thread's context, or only a note on its sources. */
export function claudeCodeContextNotice(r: {
  foreign_turns: number;
  seeded_from_summary: boolean;
  source_notes?: number;
}): string {
  return r.foreign_turns === 0 && !r.seeded_from_summary && (r.source_notes ?? 0) > 0
    ? CLAUDE_CODE_SOURCES_NOTICE
    : CLAUDE_CODE_CONTEXT_NOTICE;
}

/**
 * The turn "Finish on another model" sends after Claude Code stopped at its
 * plan limit. The other model reads the thread through the engines'
 * context assembly (the summary, digests of Claude Code's steps), so it
 * can carry the work on.
 */
export const CONTINUE_AFTER_LIMIT = 'Continue from where Claude Code stopped';

/**
 * Header every Cockpit window sends with its own random id, so Core can
 * tell two windows (or later a phone) sending into one thread apart
 * (the per-thread send lock, docs/api.md). Never a secret, never stored
 * beyond the lock's lease.
 */
export const CLIENT_ID_HEADER = 'x-ancile-client';

/**
 * provenance.engine_context on an answer: what its engine was given and
 * why, for the "Why did the AI say this?" view.
 */
export const EngineContextReport = z.object({
  engine: EngineKind,
  /** Gateway: the model's window, what was kept back for the answer, and what was used. */
  window: z.number().int().nonnegative().nullable(),
  reserve: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** The compaction summary used in place of the older path, if one was. */
  summary_id: z.string().nullable(),
  /** Messages sent as they are (tool steps still collapsed to one-line digests). */
  verbatim: z.number().int().nonnegative(),
  /** Tool calls and results collapsed to one-line digests. */
  digested: z.number().int().nonnegative(),
  /** Older messages brought back because they bear on the question. */
  recalled: z.array(z.string()),
  /** Messages left out to fit the budget. */
  dropped: z.number().int().nonnegative(),
  /** Claude Code: turns by other engines given to it as a digest. */
  foreign_turns: z.number().int().nonnegative().default(0),
  /** Claude Code: the session was started afresh from NVX Ancile's summary. */
  seeded_from_summary: z.boolean().default(false),
  /** Claude Code: notes on the notebook's sources (added or removed since its last turn) sent with it. */
  source_notes: z.number().int().nonnegative().optional(),
  /**
   * About how many tokens the whole path would have been, sent as it is
   * (every message, tool output in full, no summary): what context assembly
   * saved is this less `tokens`. Recorded since track E; absent before.
   */
  full_tokens: z.number().int().nonnegative().optional(),
});
export type EngineContextReport = z.infer<typeof EngineContextReport>;

/**
 * NVX Ancile's own instructions for a thread or notebook, which every
 * engine follows: the gateway as part of its system prompt, Claude Code
 * in its appended system note (kept short and stable for prompt caching).
 */
export const AncileInstructions = z.object({
  /** How to answer here, in your words. */
  instructions: z.string().max(4_000).default(''),
  /** Who the assistant is here (a short persona). */
  persona: z.string().max(1_000).default(''),
});
export type AncileInstructions = z.infer<typeof AncileInstructions>;

export const PutInstructionsRequest = z
  .object({
    instructions: z.string().max(4_000).optional(),
    persona: z.string().max(1_000).optional(),
  })
  .strict();
export type PutInstructionsRequest = z.infer<typeof PutInstructionsRequest>;

/** GET /threads/:id/instructions: the thread's own, its notebook's, and what an engine is given. */
export const InstructionsView = z.object({
  thread: AncileInstructions,
  notebook: AncileInstructions.nullable(),
  /** The note as engines receive it (the thread wins over its notebook, field by field). */
  effective: z.string(),
});
export type InstructionsView = z.infer<typeof InstructionsView>;
