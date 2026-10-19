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

import type {
  ClaudeCodeEffort,
  ClaudeCodeQueuedResult,
  EngineCapabilities,
  EngineKind,
  FilePart,
  ImagePart,
  ResumeCommand,
  SendTurnResult,
} from '@nvx/contracts';
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
  effort?: ClaudeCodeEffort | null;
  sourceIds?: string[];
  /** Images attached to this turn (core.images ids), already checked against the model. */
  images?: ImagePart[];
  /** Files attached to this turn only (CH6): their text rides on the user message. */
  files?: FilePart[];
  asBranch?: boolean;
  taskClass?: string;
  /** Wait instead of failing or branching while the session is busy (CC6). */
  queueIfBusy?: boolean;
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
  /**
   * CLI engines with sessions a terminal can also open (CC6): what the next
   * turn would wait for (its own turn, or a terminal holding the session),
   * and how to carry the session on in a terminal. The turn queue and the
   * cockpit's "in a terminal" badge use only these, so any CLI that
   * provides them gets one writer at a time.
   */
  waitingFor?(thread: ThreadRecord): Promise<'turn' | 'terminal' | null>;
  resumeCommand?(thread: ThreadRecord): ResumeCommand | null;
  /** Start the turn, or queue it while the session is busy (queueIfBusy). */
  startOrQueue?(
    turn: EngineTurn,
  ): Promise<
    | (Omit<SendTurnResult, 'engine' | 'context_notice'> & { context_notice?: string | null })
    | ClaudeCodeQueuedResult
  >;
  /** Start the turn as a run; resolves once it is queued (202). */
  start(
    turn: EngineTurn,
  ): Promise<Omit<SendTurnResult, 'engine' | 'context_notice'> & { context_notice?: string | null }>;
}
