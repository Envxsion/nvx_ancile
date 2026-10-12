/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: the adapter contract
 *  Ref      |  docs/engines.md (Adding an engine) · contracts engines.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What every engine that can answer a turn provides: the
 *           |  gateway (every configured model), Claude Code (the
 *           |  person's own sessions), and later other agent CLIs
 *           |  (Codex, Gemini CLI), each one adapter.
 *  How      |  An engine says what it can do, whether it can answer
 *           |  now, and starts a turn as a run on the thread's usual
 *           |  event stream. Selection (select.ts) picks the engine per
 *           |  message from the model id; the scope check runs first.
 *  Note     |  A CLI engine runs a separate helper program, downloaded
 *           |  at run time and checked against a pinned hash, never
 *           |  bundled (the Claude bridge is the model to follow).
 * ------------------------------------------------------------------
 */

import type { EngineCapabilities, EngineKind, SendTurnResult } from '@nvx/contracts';
import type { ThreadRecord } from '../threads/repo';

export interface EngineTurn {
  thread: ThreadRecord;
  text: string;
  /** undefined: the thread's active head. */
  parentId: string | null | undefined;
  /** The model asked for (an engine-local id for CLI engines, e.g. "opus"); null: its default. */
  modelId: string | null;
  /** The model id as the person gave it, kept on the answer. */
  requestedModelId: string | null;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  sourceIds?: string[];
  asBranch?: boolean;
  taskClass?: string;
  idempotencyKey: string;
}

export interface EngineStatus {
  available: boolean;
  /** Why not, in words. */
  reason: string | null;
}

export interface Engine {
  /** Stable id, also its kind for the built-in engines. */
  readonly id: string;
  readonly kind: EngineKind;
  readonly displayName: string;
  /** Model ids that choose this engine, e.g. "claude-code/"; null for the gateway (every other id). */
  readonly modelPrefix: string | null;
  capabilities(modelId?: string | null): EngineCapabilities;
  status(): Promise<EngineStatus>;
  /** Start the turn as a run; resolves once it is queued (202). */
  start(
    turn: EngineTurn,
  ): Promise<Omit<SendTurnResult, 'engine' | 'context_notice'> & { context_notice?: string | null }>;
}
