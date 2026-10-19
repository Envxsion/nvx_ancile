/**
 * ------------------------------------------------------------------
 *  Title    |  The conductor: one chat turn
 *  Ref      |  DESIGN.md §1.3, §5.5, §7
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Answer one user message, start to finish: assemble the
 *           |  path, call the model through the gateway (fallback,
 *           |  refusal and mid-stream recovery included), run tools
 *           |  through the permission gate, pause for a person when a
 *           |  tool needs one, then finalise the message and its cost.
 *  How      |  A RunHandler for `chat_turn` runs. Its checkpoint holds
 *           |  everything needed to continue on any worker: the parts
 *           |  produced so far, the tool calls still to settle, the
 *           |  approval it is waiting on. The loop is:
 *           |    settle queued tool calls → (pause if asked) →
 *           |    model round → queue its tool calls → repeat
 *           |  until a round produces no tool calls.
 *           |  Text deltas are batched every 40 ms so a fast model is
 *           |  not one database row per token.
 *           |  In a notebook, retrieval runs once before the first
 *           |  round (retrieval.ts) and the finished answer's citations
 *           |  are checked against what it was given (citations.ts).
 *           |  Memory (memory/service.ts) is injected before every model
 *           |  round for the model about to be called, recorded on the
 *           |  answer as provenance.memory, and learned from after the
 *           |  answer is saved, without holding the turn up. Long
 *           |  branches are compacted before the model round (§8.4).
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type AnswerRoute,
  type Attempt,
  type CompactionProvenance,
  type EngineContextReport,
  type EpochProvenance,
  type EpochReason,
  ID_PREFIX,
  type ModelConfig,
  type Part,
  type Recovered,
  type RetrievalTrace,
  type RunEvent,
  stepTitle,
  type Usage,
  type UsageCall,
} from '@nvx/contracts';
import { collectRecoveries, type RecoveryInfo } from '@nvx/resilience';
import { ulid } from 'ulid';
import type { JobSwitches } from '../automations/settings';
import type { EventBus } from '../events/bus';
import { executeFlow, type FlowState, type ModelCallResult, provenanceOf } from '../flows/execute';
import {
  type FlowReplay,
  type FlowsService,
  makeTurnRuntime,
  type RouteAgain,
  withFlow,
} from '../flows/turn';
import { sentOfAnswer, sentText, toSdkMessages } from '../gateway/convert';
import { ChainFailedError, type Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import { NoRouteError } from '../gateway/router';
import type { ModelMessage, ModelRequest, StreamChunk, ToolDef } from '../gateway/types';
import { summariesBlock, type TurnLinks } from '../links/service';
import { approxTokens } from '../memory/inject';
import type { MemoryService } from '../memory/service';
import { logFor } from '../obs/logger';
import { type ReplayInput, replayedResult } from '../obs/replay';
import { refusalForModel } from '../permissions/decide';
import type { Gate } from '../permissions/gate';
import { APPROVAL_TTL_MS } from '../permissions/reconcile';
import type { ApprovalRecord, PermissionStore } from '../permissions/store';
import {
  type RunContext,
  type RunHandler,
  type RunOutcome,
  RunOwnershipLost,
  type RunRecord,
  StepUncertain,
} from '../runs/engine';
import type { RunEventInput } from '../runs/events';
import { allowedSources, type ScopeResolver } from '../scopes';
import type { BranchStore } from '../threads/branches';
import { contextWatch, prepareTurnContext } from '../threads/compact';
import { ancestorPath } from '../threads/path';
import { asTree, type MessageRecord, type SentForm, type ThreadRepo, textOf } from '../threads/repo';
import type { ToolRegistry, ToolSpec } from '../tools/registry';
import { applyCitations } from './citations';
import { branchKeyFor, historyFor, pathFor, systemPrompt, withPartial, withTurnContext } from './context';
import {
  bridgeTarget,
  cacheTtlMs,
  contextBlock,
  type EpochRecord,
  type EpochStore,
  epochReason,
  frozenSystem,
  logEpochStart,
  MCP_BRIDGE_NAME,
  MemoryEpochStore,
  newTrack,
  shortSha,
  systemBlocks,
  toolDrift,
  toolsBlock,
  toolsInScope,
  warnToolsChanged,
} from './epoch';
import { explainLinks, searchWithLinks } from './links';
import { type LoopState, noteResult } from './loopguard';
import { noteCall, noteRecovery, recoveryOf, stopOf, usageOut } from './receipt';
import {
  capPerSource,
  DEFAULT_LIMITS,
  emptyNote,
  type Grounding,
  groundingFrom,
  queryFor,
  type RetrievalLimits,
  type Retriever,
} from './retrieval';

const log = logFor('conductor');

export interface TurnInput {
  threadId: string;
  workspaceId: string;
  notebookId: string | null;
  userMessageId: string;
  assistantMessageId: string;
  explicitModel: string | null;
  /**
   * Where explicitModel came from. A model chosen for this message (@model,
   * "just the next message", regenerate with another model) answers instead
   * of any flow; a thread's model only answers when no flow does.
   */
  modelFrom?: 'message' | 'thread' | null;
  /** The thread's model could not answer, so it was passed over (provenance.route). */
  threadModelUnready?: string;
  taskClass: string;
  /** Sources the user @-mentioned: retrieval looks only at these. */
  sourceIds?: string[];
  /** A repository the user @-mentioned: git tools on this turn act on it. */
  repoId?: string;
  /** A re-run (Phase 5 replay): tools are answered from this record, never run. */
  replay?: ReplayInput;
  /** Parts the answer starts with (a re-run keeps the steps before its start). */
  seedParts?: Part[];
  /** Flows (Phase 5b): answer through this flow (`@flow` on the message). */
  flowId?: string;
  /** Flows: repeat a recorded answer's route (regenerate, same route). */
  flowReplay?: FlowReplay;
  /** Flows: answer through this flow version (route again). */
  routeAgain?: RouteAgain;
  /** Extra instructions for this answer only, after the system prompt. */
  instructions?: string;
  /** The caller's own record for this answer, kept in its provenance. */
  provenanceExtra?: Record<string, unknown>;
  /** Started by an automation: tool calls are decided as unattended (base.cedar). */
  automation?: boolean;
}

export interface QueuedCall {
  callId: string;
  tool: string;
  args: unknown;
  /** Step number for the run's idempotency ledger, fixed when the call is queued. */
  seq: number;
}

export interface TurnCheckpoint {
  v: 1;
  input: TurnInput;
  parts: Part[];
  rounds: number;
  nextSeq: number;
  queue: QueuedCall[];
  waiting: { approvalId: string; callId: string } | null;
  /** The last model round produced no tool calls: the answer is complete. */
  answered: boolean;
  /** LB1: the call that has been failing the same way, and how many times in a row. */
  loop?: LoopState;
  /** LB1: set when that reached the limit; the line the user reads, added once the queue is settled. */
  loopStop?: string;
  answeredBy: string | null;
  chain: string[];
  attempts: { model: string; reason: string; detail: string }[];
  usage: {
    input: number;
    output: number;
    cached: number;
    /** What the answer cost: provider-billed where it said, else list price (Usage.cost_usd). */
    costUsd: number;
    /** Roadmap WY1, all absent on older checkpoints: cache writes, list price, the provider's bill, and each call. */
    written?: number;
    listUsd?: number;
    billedUsd?: number;
    cacheReported?: boolean;
    calls?: UsageCall[];
    /** OpenRouter: who served the last call, and whether it hit the output cap. */
    served?: { provider: string | null; model: string | null; cut_off: boolean };
  };
  /** When the turn began (epoch ms), so each call records its start as an offset (Usage.calls). */
  startedAt?: number;
  /** Retries that worked, for the receipt's "Worth knowing" (provenance.recovered). */
  recovered?: Recovered[];
  /** Retrieval ran for this turn (notebook threads only); absent on older checkpoints. */
  retrieved?: boolean;
  grounding?: Grounding | null;
  retrievalError?: { code: string; title: string } | null;
  /** Compaction was considered for this turn (DESIGN.md §8.4); absent on older checkpoints. */
  compactionChecked?: boolean;
  compaction?: (CompactionProvenance & { note: string; skipThrough: string }) | null;
  /** The memory pack last injected (Phase 4); becomes provenance.memory. */
  memory?: MemoryProvenance | null;
  /** Flows (Phase 5b): the flow answering this turn was resolved (null: plain chat). */
  flowChecked?: boolean;
  flow?: FlowState | null;
  /** How this answer was routed and why (provenance.route). */
  route?: AnswerRoute;
  /** Flows: each flow tool call's fixed step number (idempotent across restarts) and its node. */
  flowToolSeq?: Record<string, number>;
  flowToolNodes?: Record<string, string>;
  /** Recorded calls a re-run has already answered from (indexes into input.replay.calls). */
  replayUsed?: number[];
  /** Engines (docs/engines.md): how a mixed thread's context was fitted (provenance.engine_context). */
  engineContext?: EngineContextReport | null;
  /** Context links read for this turn (provenance.links); absent on older checkpoints. */
  linked?: TurnLinks | null;
  /**
   * When each tool call still to settle was made (epoch ms), so its result
   * records how long the step took (tool_result.duration_ms), across a
   * pause for approval or a restart. Absent on older checkpoints: those
   * results carry no duration.
   */
  stepStarted?: Record<string, number>;
  /** CA2: the prompt epoch this turn answers in, fixed before the first model round. */
  frame?: TurnFrame | null;
  /** CA5: calls that left a provider's cache on purpose (an OpenRouter pin whose upstream was down). Absent when none. */
  cacheResets?: { model_id: string; reason: string; provider: string | null; detail: string }[];
}

/** What a turn's request is built from, fixed at its first model round so every round starts alike. */
export interface TurnFrame {
  epochId: string;
  reason: EpochReason;
  /** This turn began the epoch. */
  started: boolean;
  /** The varying context rides at the end of the request (false: the family's switch is off). */
  endContext: boolean;
  lane: string;
  toolsHash: string;
  memoryCommit: string | null;
  /** The context in front of the newest question: the whole block when endContext, else the sources. */
  block: string;
}

/** A step's duration from when it was called; undefined when the start was never recorded. */
export function stepDuration(started: unknown, now: number): number | undefined {
  if (typeof started !== 'number' || !Number.isFinite(started) || !Number.isFinite(now)) return undefined;
  // A clock stepped back between the call and its result is not a negative duration.
  return Math.max(0, Math.round(now - started));
}

/** Engines (docs/engines.md): what a model round is given beyond the conductor's own parts. */
export type EngineContextHook = (a: {
  threadId: string;
  notebookId: string | null;
  messages: import('../threads/repo').MessageRecord[];
  userMessageId: string;
  model: ModelConfig | undefined;
  /** The compaction summary this turn already chose, if any. */
  compaction: { summaryId: string; skipThrough: string; note: string } | null;
  /** Tokens of the system prompt, memory, sources and instructions. */
  fixedTokens: number;
}) => Promise<{
  /** The fitted history for a mixed thread; null: the conductor's own (historyFor). */
  history: ModelMessage[] | null;
  /** With history: the summary and recalled turns, in place of the compaction note. */
  note: string;
  /** The thread's and notebook's instructions and persona, every turn. */
  instructions: string;
  report: EngineContextReport | null;
}>;

/** What an answer records about the memory it was given (contracts MemoryProvenance). */
export interface MemoryProvenance {
  files: { path: string; commit: string; entries: string[]; tokens: number; dropped: number }[];
  tokens: number;
  truncated: number;
}

export function initialCheckpoint(input: TurnInput): TurnCheckpoint {
  return {
    v: 1,
    input,
    parts: input.seedParts ? [...input.seedParts] : [],
    rounds: 0,
    nextSeq: 1,
    queue: [],
    waiting: null,
    answered: false,
    answeredBy: null,
    chain: [],
    attempts: [],
    usage: { input: 0, output: 0, cached: 0, costUsd: 0 },
  };
}

export interface ConductorDeps {
  repo: ThreadRepo;
  registry: ModelRegistry;
  gateway: Gateway;
  tools: ToolRegistry;
  gate: Gate;
  permissions: PermissionStore;
  bus?: EventBus;
  userId: string;
  promptsDir: string;
  /** Tool rounds per turn before the conductor stops and says so. */
  maxRounds?: number;
  toolTimeoutMs?: number;
  /** Delta batching window; 0 sends every delta (tests). */
  deltaMs?: number;
  /** How long a question waits for an answer before it expires (default 24 h). */
  approvalTtlMs?: number;
  /** The same, for a question an automation raised (ANCILE_APPROVAL_TTL_AUTOMATION_S). */
  automationApprovalTtlMs?: number;
  /** Finds passages in a notebook's sources; without it, turns are never grounded. */
  retriever?: Retriever;
  /** Passages per turn and per source (config/retrieval.yaml); defaults to 8, at most 4 from one source. */
  retrievalLimits?: RetrievalLimits;
  notebookTitle?: (id: string) => Promise<string | null>;
  /** Branch names and summaries; without it, turns are never compacted. */
  branches?: BranchStore;
  /** Memory: injected before each model call, learned from after the turn. */
  memory?: Pick<MemoryService, 'pack' | 'afterTurn'>;
  /**
   * Called once an answer has finished (status complete), after it is saved.
   * Phase 4 uses it for grounded mode: the answer is fact-checked. Its errors
   * are logged and never touch the answer.
   */
  afterAnswer?: (a: AnsweredTurn) => Promise<void>;
  /** Flows (Phase 5b): when a flow applies, it answers instead of the single model round. */
  flows?: FlowsService;
  /** Scopes (docs/scopes.md): which sources retrieval reads, and whether memory is read or written. */
  scopes?: ScopeResolver;
  /** Engines (docs/engines.md): fitted context for mixed threads, and NVX Ancile's instructions. */
  engineContext?: EngineContextHook;
  /** Context links (docs/notebooks.md): other notebooks' sources and threads' summaries, scope-checked now. */
  links?: { forTurn(threadId: string): Promise<TurnLinks> };
  /** The built-in automations' switches (Watch the context window); absent: all on. */
  switches?: JobSwitches;
  /** CA2: where prompt epochs are kept; absent: in memory only (tests). */
  epochs?: EpochStore;
  /**
   * CA2: whether a model family gets what varies (date, memory ranked for the
   * question, notes, this answer's instructions) at the end of the request
   * instead of in the system prompt. Default on; the Flow lab can turn it off
   * for a family whose small models follow end-of-request instructions badly.
   */
  endContext?: (family: string) => boolean | Promise<boolean>;
  /** The clock epochs read (cold points, the date in the context block); tests move it. */
  now?: () => number;
}

export interface AnsweredTurn {
  messageId: string;
  threadId: string;
  workspaceId: string;
  notebookId: string | null;
  /** The question it answers. */
  userMessageId?: string;
  /** The flow that answered, if one did. */
  flowId?: string | null;
  /** The model that answered (the first in its chain). */
  modelId?: string | null;
  /** What the caller who started the turn recorded for it (StartTurn.provenanceExtra). */
  extra?: Record<string, unknown>;
}

const PRINCIPAL = 'agent:default';

/** What the reply records about its compaction (the note itself lives in the summary). */
/** provenance.route: recorded at the flow check; a turn without Flows answers by model. */
const routeOf = (cp: TurnCheckpoint): AnswerRoute => {
  let r: AnswerRoute = cp.route ?? { kind: 'model', from: cp.input.modelFrom ?? 'default' };
  if (cp.input.threadModelUnready) r = { ...r, thread_model_unready: cp.input.threadModelUnready };
  return r.kind === 'model' && cp.answeredBy ? { ...r, model_id: cp.answeredBy } : r;
};

/** provenance.epoch: which epoch the answer was written in, and why it began. */
const epochOut = (f: TurnFrame): EpochProvenance => ({
  id: f.epochId,
  reason: f.reason,
  started: f.started,
  model_family: f.lane,
  tools_hash: f.toolsHash,
  memory_commit: f.memoryCommit,
  end_context: f.endContext,
});

const compactionOut = ({ note: _n, skipThrough: _s, ...rest }: NonNullable<TurnCheckpoint['compaction']>) =>
  rest satisfies CompactionProvenance;

function argsPreview(args: unknown): unknown {
  const s = JSON.stringify(args ?? {});
  if (s.length <= 2_000) return args;
  return { preview: `${s.slice(0, 2_000)}…`, truncated: true };
}

function resultPreview(result: unknown): string {
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return s.length > 280 ? `${s.slice(0, 280)}…` : s;
}

/** Keep who served an OpenRouter call, and flag an answer cut off at the endpoint's output cap. */
function noteServed(
  cp: TurnCheckpoint,
  c: { finishReason: string; served?: { provider: string | null; model: string | null } },
) {
  if (!c.served) return;
  cp.usage.served = { ...c.served, cut_off: c.finishReason === 'length' };
}

/**
 * Iterate `source` with every step run inside a recovery collector, so a retry
 * that worked anywhere under the model call is noted. Async iteration resumes in
 * the caller's context, which is why each `next()` is wrapped, not the loop.
 */
async function* watched<T>(source: AsyncIterable<T>, sink: (info: RecoveryInfo) => void): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await collectRecoveries(sink, () => it.next());
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await it.return?.().catch(() => undefined);
  }
}

function appendText(parts: Part[], type: 'text' | 'reasoning', delta: string) {
  const last = parts.at(-1);
  if (last && last.type === type) last.text += delta;
  else parts.push(type === 'text' ? { type: 'text', text: delta } : { type: 'reasoning', text: delta });
}

/**
 * CA1: reasoning exactly as it arrived. A new block starts its own part; what the
 * provider signed (Anthropic's signature, OpenRouter's reasoning_details) is kept
 * on that part and goes back verbatim. `state.fresh` marks that the next piece
 * opens a new part rather than extending the last.
 */
export function appendReasoning(
  parts: Part[],
  c: { delta: string; block?: true; meta?: Record<string, unknown> },
  state: { fresh: boolean },
) {
  if (c.block) state.fresh = true;
  if (!c.delta && !c.meta) return;
  const last = parts.at(-1);
  let target: Extract<Part, { type: 'reasoning' }>;
  if (last?.type === 'reasoning' && !state.fresh) target = last;
  else {
    target = { type: 'reasoning', text: '' };
    parts.push(target);
    state.fresh = false;
  }
  target.text += c.delta;
  if (c.meta) target.provider_meta = { ...target.provider_meta, ...c.meta };
}

/** Batches text and reasoning deltas so the event log gets a row per ~40 ms, not per token. */
class DeltaBatcher {
  private buf = '';
  private kind: 'text.delta' | 'reasoning.delta' = 'text.delta';
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The first words of an answer go out at once: batching only helps after them. */
  private started = false;

  constructor(
    private readonly emit: (e: RunEventInput) => Promise<unknown>,
    private readonly messageId: string,
    private readonly ms: number,
  ) {}

  push(kind: 'text.delta' | 'reasoning.delta', delta: string) {
    if (kind !== this.kind) this.flushQuietly();
    this.kind = kind;
    this.buf += delta;
    if (this.ms === 0 || !this.started) {
      this.started = true;
      this.flushQuietly();
    } else this.timer ??= setTimeout(() => this.flushQuietly(), this.ms);
  }

  /** A flush nobody awaits: a failed write loses a live delta, never the answer (parts are checkpointed). */
  private flushQuietly() {
    void this.flush().catch((err) => log.warn({ err }, 'could not write a text delta'));
  }

  flush(): Promise<unknown> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buf) return Promise.resolve();
    const delta = this.buf;
    this.buf = '';
    this.started = true;
    return this.emit({ type: this.kind, message_id: this.messageId, delta });
  }
}

export function chatTurnHandler(deps: ConductorDeps): RunHandler {
  const maxRounds = deps.maxRounds ?? 8;
  const epochs = deps.epochs ?? new MemoryEpochStore();

  async function finalise(
    cp: TurnCheckpoint,
    status: 'complete' | 'stopped' | 'error',
    ctx: { emit: (e: RunEventInput) => Promise<unknown> },
    error?: { code: string; title: string; hint: string },
  ) {
    const model = cp.answeredBy ? deps.registry.get(cp.answeredBy) : undefined;
    // CA4: what the model was sent of this answer, as text, before citations are tidied.
    // Next turn starts with these bytes. A flow's answer is not built from its parts, so none.
    const sent = status === 'complete' && !cp.flow ? sentOfAnswer(cp.parts) : null;
    // Hold the answer to its sources: invented citation numbers go.
    let retrieval: Record<string, unknown> = {};
    if (cp.grounding?.trace.hits.length && status !== 'error') {
      const checked = applyCitations(cp.parts, cp.grounding.trace, new Map(cp.grounding.spans));
      cp.parts = checked.parts;
      retrieval = { retrieval: checked.trace };
      for (const part of checked.parts)
        if (part.type === 'citation_ref')
          await ctx.emit({ type: 'citation', message_id: cp.input.assistantMessageId, part });
      if (checked.trace.invalid_markers)
        log.info({ invalid: checked.trace.invalid_markers }, 'stripped citations that matched no passage');
    } else if (cp.grounding) retrieval = { retrieval: cp.grounding.trace };
    if (cp.retrievalError) retrieval = { ...retrieval, retrieval_error: cp.retrievalError };
    const links = explainLinks(
      cp.linked ?? null,
      (retrieval.retrieval as RetrievalTrace | undefined) ?? null,
    );
    const usage: Usage = usageOut(cp.usage, {
      model,
      // Who paid, as it is now: a later sign-in change must not rewrite this answer's receipt.
      billing: cp.answeredBy ? (deps.registry.billingFor?.(cp.answeredBy) ?? null) : null,
      ms: cp.startedAt !== undefined ? Date.now() - cp.startedAt : undefined,
      // The rates in force when the answer began (a model can have off-peak prices).
      ...(cp.startedAt !== undefined && { at: cp.startedAt }),
    });
    await deps.repo.updateMessage(cp.input.assistantMessageId, {
      parts: cp.parts,
      status,
      model_id: cp.answeredBy,
      usage: cp.answeredBy ? usage : null,
      provenance: {
        ...cp.input.provenanceExtra,
        chain: cp.chain,
        attempts: cp.attempts,
        ...(cp.recovered?.length && { recovered: cp.recovered }),
        model_name: model?.display_name ?? null,
        ...retrieval,
        ...(cp.memory && { memory: cp.memory }),
        ...(cp.input.replay && {
          rerun_of: { run_id: cp.input.replay.fromRunId, from_step: cp.input.replay.fromStep },
        }),
        ...(cp.compaction && { compaction: compactionOut(cp.compaction) }),
        ...(cp.engineContext && { engine_context: cp.engineContext }),
        ...(links.length && { links }),
        ...(cp.flow && { flow: provenanceOf(cp.flow) }),
        route: routeOf(cp),
        ...(cp.frame && { epoch: epochOut(cp.frame) }),
        ...(cp.cacheResets?.length && { cache_resets: cp.cacheResets }),
        ...(error && { error }),
      },
      ...(sent && { sent }),
    });
    await deps.repo.patchThread(cp.input.threadId, {});
    if (cp.answeredBy) await ctx.emit({ type: 'usage', message_id: cp.input.assistantMessageId, usage });
  }

  return {
    async execute(ctx: RunContext): Promise<RunOutcome> {
      const run = ctx.run;
      const cp = structuredClone(run.checkpoint) as TurnCheckpoint;
      const msgId = cp.input.assistantMessageId;
      const emit = (e: RunEventInput) => ctx.events.append(run.id, e);
      const deltas = new DeltaBatcher(emit, msgId, deps.deltaMs ?? 40);
      // CA1: where the next piece of reasoning goes (a new block, or on to the last).
      const reasoningState = { fresh: false };
      // Bookkeeping writes that need not hold up the stream; awaited at the end of each round.
      const pendingWrites: Promise<unknown>[] = [];
      // Roadmap WY1: when the turn began, so each model call records its start as an offset.
      cp.startedAt ??= Date.now();
      const turnStarted = cp.startedAt;
      /** Where retries that worked are noted (provenance.recovered): the model call or a tool. */
      const recorder = (what: Recovered['what'], tool?: string) => (info: RecoveryInfo) => {
        cp.recovered = noteRecovery(
          cp.recovered,
          recoveryOf(
            what,
            what === 'tool'
              ? (tool ?? 'tool')
              : (deps.registry.get(cp.answeredBy ?? '')?.display_name ?? 'model'),
            info,
          ),
        );
      };
      /** Add a finished model call to the answer's usage; returns what it cost. */
      const countCall = (
        model: ModelConfig | undefined,
        modelId: string,
        c: Extract<StreamChunk, { type: 'finish' }>,
        callStarted: number,
      ): number => {
        noteServed(cp, c);
        const now = Date.now();
        const stop = stopOf(c.finishReason);
        return noteCall(cp.usage, {
          model,
          modelId: model?.id ?? modelId,
          usage: c.usage,
          billedUsd: c.costUsd,
          startedMs: callStarted - turnStarted,
          at: callStarted,
          ms: now - callStarted,
          ...(stop && { stop }),
          ...(c.served && { served: { ...c.served, cut_off: c.finishReason === 'length' } }),
        });
      };
      // Retrieval, compaction, memory and the model round all read the same
      // history before the first word; nothing in this step changes it.
      let historyRead: ReturnType<typeof deps.repo.messages> | null = null;
      const messages = () => {
        historyRead ??= deps.repo.messages(cp.input.threadId);
        return historyRead;
      };

      // Reads the first word waits on start now, beside the status write:
      // the history, and (once per turn) the thread and the flow it resolves to.
      void messages().catch(() => undefined);
      const flowLookup =
        deps.flows && !cp.flowChecked
          ? deps.repo.getThread(cp.input.threadId).then(async (thread) => ({
              thread,
              resolved: thread ? await deps.flows?.resolve(thread, cp.input.flowId ?? null) : null,
            }))
          : null;
      flowLookup?.catch(() => undefined);
      await deps.repo.updateMessage(msgId, { status: 'streaming', run_id: run.id });
      // Anything a previous attempt streamed but never checkpointed is
      // discarded; the client redraws from what is actually committed.
      if (cp.parts.length || run.attempt > 0 || cp.waiting) {
        await emit({ type: 'message.snapshot', message_id: msgId, parts: cp.parts });
      }

      const scope = {
        threadId: cp.input.threadId,
        notebookId: cp.input.notebookId,
        workspaceId: cp.input.workspaceId,
        repoId: cp.input.repoId ?? null,
      };

      /** Note when a call was made, for its result's duration_ms. */
      const started = (callId: string) => {
        cp.stepStarted = { ...cp.stepStarted, [callId]: Date.now() };
      };

      const settle = async (
        call: QueuedCall,
        result: Extract<Part, { type: 'tool_result' }>,
        guard = true,
      ) => {
        // LB1: the same call failing the same way, again and again, ends the turn out loud.
        if (guard && !cp.input.replay) {
          const text =
            typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '');
          const noted = noteResult(
            cp.loop,
            { tool: call.tool, args: call.args, polls: deps.tools.get(call.tool)?.polls === true },
            { ok: result.ok, text, declinedByUser: result.result === 'declined' },
          );
          cp.loop = noted.state;
          if (noted.stop) {
            result = {
              ...result,
              result: `${text}

${noted.stop.forModel}`,
            };
            cp.loopStop = noted.stop.forUser;
            log.warn(
              { run_id: run.id, tool: call.tool, failures: noted.stop.count, call_sig: noted.stop.sig },
              'the same tool call failed repeatedly; the turn is stopped',
            );
          }
        }
        // A re-run answers from the record without running anything: it has no duration of its own.
        const ms = cp.input.replay ? undefined : stepDuration(cp.stepStarted?.[call.callId], Date.now());
        if (cp.stepStarted && call.callId in cp.stepStarted) {
          const { [call.callId]: _done, ...rest } = cp.stepStarted;
          cp.stepStarted = rest;
        }
        cp.parts.push(ms === undefined ? result : { ...result, duration_ms: ms });
        await emit({
          type: 'tool.result',
          call_id: call.callId,
          ok: result.ok && result.declined_reason === undefined,
          preview:
            result.declined_reason !== undefined
              ? `Declined${result.declined_reason ? `: ${result.declined_reason}` : ''}`
              : resultPreview(result.result),
          ...(cp.flowToolNodes?.[call.callId] && { node_id: cp.flowToolNodes[call.callId] }),
        });
      };

      const runTool = async (call: QueuedCall, spec: ToolSpec) => {
        try {
          const result = await ctx.once(
            call.seq,
            'tool_call',
            { tool: call.tool, args: call.args },
            async () => {
              const timeout = AbortSignal.timeout(spec.timeoutMs ?? deps.toolTimeoutMs ?? 60_000);
              const signal = AbortSignal.any([ctx.signal, timeout]);
              return collectRecoveries(recorder('tool', call.tool), () =>
                spec.execute(call.args, {
                  idempotencyKey: `${run.id}:${call.seq}`,
                  signal,
                  scope,
                  callId: call.callId,
                }),
              );
            },
            // A read can safely run again after a crash; anything else is not
            // repeated without a person (DESIGN.md §5.5).
            { rerunnable: spec.readOnly === true },
          );
          await settle(call, { type: 'tool_result', call_id: call.callId, ok: true, result });
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          if (err instanceof StepUncertain) {
            log.warn(
              { run_id: run.id, tool: call.tool, seq: call.seq },
              'tool step left unfinished by a restart',
            );
            // TODO(phase-5): offer Run again / Skip in the Cockpit instead of telling the model.
            await settle(call, {
              type: 'tool_result',
              call_id: call.callId,
              ok: false,
              result: `${err.title}. It was not run again, so check its effect before asking for it again.`,
            });
            return;
          }
          await settle(call, {
            type: 'tool_result',
            call_id: call.callId,
            ok: false,
            result: (err as Error).message,
          });
        }
      };

      /**
       * CA3: a call to the mcp_call bridge is the call it names, from here on: the
       * permission check, the approval and the run all see the real tool and its real
       * arguments. The stored call stays as the model made it.
       */
      const bridge = (call: QueuedCall): { call: QueuedCall } | { refused: string } => {
        if (call.tool !== MCP_BRIDGE_NAME) return { call };
        const t = bridgeTarget(call.args);
        if ('error' in t) return { refused: t.error };
        const spec = deps.tools.get(t.name);
        if (!spec) return { refused: `There is no tool called "${t.name}", so nothing was run.` };
        if (spec.source.kind !== 'mcp')
          return {
            refused: `${MCP_BRIDGE_NAME} only reaches tools from connected MCP servers. Call ${t.name} directly.`,
          };
        if (spec.notebookId != null && spec.notebookId !== cp.input.notebookId)
          return { refused: `There is no tool called "${t.name}", so nothing was run.` };
        return { call: { ...call, tool: t.name, args: t.args } };
      };

      /** A tool the epoch declared that is gone now (its server went away): refused, with the reason. */
      const goneReason = async (name: string): Promise<string | null> => {
        const e = cp.frame ? await epochs.get(cp.frame.epochId) : undefined;
        return e && name in e.track.tool_hashes
          ? `The tool "${name}" is not available now: its server has disconnected or been removed, so it was not run. Do not call it again in this conversation; tell the user if you need it.`
          : null;
      };

      /** Act on an answered approval: run the tool, or tell the model it was declined. */
      const answer = async (queued: QueuedCall, approval: ApprovalRecord) => {
        const b = bridge(queued);
        const call = 'call' in b ? b.call : queued;
        const spec = deps.tools.get(call.tool);
        if (approval.status === 'approved' && spec) {
          await runTool(call, spec);
          return;
        }
        const reason =
          approval.status === 'expired'
            ? 'Nobody answered in time'
            : approval.status === 'cancelled'
              ? 'The request was withdrawn'
              : (approval.reason ?? '');
        await settle(call, {
          type: 'tool_result',
          call_id: call.callId,
          ok: false,
          result: 'declined',
          declined_reason: reason,
        });
      };

      /** Settle one queued call: done, waiting on a person, or stopped while asking. */
      const handleCall = async (queued: QueuedCall): Promise<'done' | 'waiting' | 'stopped'> => {
        // ---- Phase 5: a re-run never runs a tool; it is answered from the record ----
        if (cp.input.replay) {
          const r = replayedResult(cp.input.replay, cp.replayUsed ?? [], queued);
          if (r.index !== null) cp.replayUsed = [...(cp.replayUsed ?? []), r.index];
          await settle(queued, { type: 'tool_result', call_id: queued.callId, ok: r.ok, result: r.result });
          return 'done';
        }
        // ---- end Phase 5 replay ----
        const b = bridge(queued);
        if ('refused' in b) {
          await settle(queued, { type: 'tool_result', call_id: queued.callId, ok: false, result: b.refused });
          return 'done';
        }
        const call = b.call;
        const spec = deps.tools.get(call.tool);
        if (!spec) {
          await settle(call, {
            type: 'tool_result',
            call_id: call.callId,
            ok: false,
            result: (await goneReason(call.tool)) ?? `There is no tool called "${call.tool}".`,
          });
          return 'done';
        }
        const decision = await deps.gate.check({
          userId: deps.userId,
          principal: PRINCIPAL,
          action: spec.action,
          resource: spec.resource(call.args, scope),
          toolTier: spec.tier,
          destructive: spec.destructive,
          scope,
          runId: run.id,
          traceId: run.traceId,
          ...(cp.input.automation && { automation: true }),
          tool: call.tool,
          args: call.args,
          callId: call.callId,
        });
        if (decision.outcome === 'allow') {
          await runTool(call, spec);
          return 'done';
        }
        if (decision.outcome === 'deny') {
          const why = refusalForModel(decision);
          await settle(call, {
            type: 'tool_result',
            call_id: call.callId,
            ok: false,
            result: why,
            declined_reason: why,
          });
          return 'done';
        }
        // Idempotent on (run, call): a retry after a crash gets the same approval.
        const approval = await deps.permissions.createApproval({
          runId: run.id,
          stepSeq: call.seq,
          threadId: cp.input.threadId,
          callId: call.callId,
          principal: PRINCIPAL,
          tool: call.tool,
          action: spec.action,
          resource: decision.resource,
          args: call.args,
          argsPreview: spec.preview
            ? await spec.preview(call.args, scope).catch(() => argsPreview(call.args))
            : argsPreview(call.args),
          tier: decision.tier,
          suggestions: decision.tier === 'critical' ? [] : decision.suggestions,
          expiresAt: new Date(
            Date.now() +
              ((cp.input.automation ? deps.automationApprovalTtlMs : undefined) ??
                deps.approvalTtlMs ??
                APPROVAL_TTL_MS),
          ).toISOString(),
        });
        // Stop was pressed while asking: withdraw the question instead of pausing.
        if (ctx.signal.aborted) {
          await deps.permissions.resolveApproval(approval.id, { status: 'cancelled' });
          return 'stopped';
        }
        // Already answered before a crash: act on that answer instead of asking again.
        if (approval.status !== 'pending') {
          await answer(call, approval);
          return 'done';
        }
        cp.waiting = { approvalId: approval.id, callId: call.callId };
        await emit({
          type: 'approval.required',
          approval_id: approval.id,
          tool: call.tool,
          action: spec.action,
          resource: decision.resource,
          tier: decision.tier,
          call_id: call.callId,
          args_preview: approval.args_preview,
          suggestions: approval.suggestions,
        });
        await deps.bus
          ?.publish({
            type: 'approval.requested',
            approval_id: approval.id,
            run_id: run.id,
            tool: call.tool,
            tier: decision.tier,
          })
          .catch(() => undefined);
        return 'waiting';
      };

      /** Once per turn, in a notebook or through links: find the passages this question needs. */
      const retrieve = async () => {
        cp.retrieved = true;
        const notebookId = cp.input.notebookId;
        // Context links, checked against both scopes now (docs/notebooks.md).
        cp.linked = deps.links
          ? await deps.links.forTurn(cp.input.threadId).catch((err: unknown) => {
              log.warn({ err }, 'context links could not be read; answering without them');
              return null;
            })
          : null;
        const linked = cp.linked?.notebooks ?? [];
        if (!deps.retriever || (!notebookId && !linked.length)) return;
        const started = Date.now();
        const all = await messages();
        const questions = historyFor(all, cp.input.userMessageId)
          .filter((m) => m.role === 'user')
          .map((m) => m.content);
        const query = queryFor(questions);
        // The scope's sources, read now: a source outside it is never searched.
        const scope = notebookId
          ? await deps.scopes?.effective({ notebookId, threadId: cp.input.threadId })
          : undefined;
        const sourceIds = scope ? allowedSources(scope, cp.input.sourceIds) : cp.input.sourceIds;
        const ownAllowed = !!notebookId && !(scope?.scope.sources && !sourceIds?.length);
        if (!ownAllowed && !linked.length) return;
        // The notebook's title is only for the answer's wording: read it beside the search.
        const titleRead = notebookId
          ? (deps.notebookTitle?.(notebookId).catch(() => null) ?? Promise.resolve(null))
          : Promise.resolve(null);
        try {
          const limits = deps.retrievalLimits ?? DEFAULT_LIMITS;
          const { response, via } = await searchWithLinks({
            retriever: deps.retriever,
            workspaceId: cp.input.workspaceId,
            query,
            limits,
            own: ownAllowed && notebookId ? { notebookId, sourceIds } : null,
            linked,
          });
          // One source gives at most perSource passages, whatever the retriever returned.
          const capped = { ...response, hits: capPerSource(response.hits, limits.k, limits.perSource) };
          cp.grounding = groundingFrom(capped, {
            query,
            notebookId,
            notebookTitle: (await titleRead) ?? null,
            via,
          });
        } catch (err) {
          cp.grounding = null;
          cp.retrievalError = {
            code: err instanceof AncileError ? err.code : 'knowledge.failed',
            title: err instanceof AncileError ? err.title : 'The sources could not be searched',
          };
          log.warn({ err }, 'retrieval failed; answering without sources');
        }
        const hits = cp.grounding?.trace.hits ?? [];
        // EV2: what was searched for and what came back, not only how many: the query, where it looked,
        // and each passage's source with its score (the same figures the receipt shows afterwards).
        await emit({
          type: 'retrieval.done',
          chunks: hits.length,
          sources: new Set(hits.map((h) => h.source_id)).size,
          ms: Date.now() - started,
          query: query.slice(0, 300),
          searched: linked.length ? 'links' : cp.input.sourceIds?.length ? 'mentioned' : 'notebook',
          found: hits.slice(0, 24).map((h) => ({
            source_title: h.source_title,
            page: h.page,
            score: Math.round(h.score * 1000) / 1000,
          })),
        });
      };

      type PackOut = Awaited<ReturnType<NonNullable<ConductorDeps['memory']>['pack']>>;

      /** Memory for the model about to be called; null when there is none or it may not be read. */
      const readPack = async (
        target: ModelConfig | undefined,
        part?: 'pinned' | 'ranked',
      ): Promise<PackOut | null> => {
        if (!deps.memory || !target) return null;
        try {
          const scope = await deps.scopes?.effective({
            notebookId: cp.input.notebookId,
            threadId: cp.input.threadId,
          });
          if (scope && !scope.scope.memory_read) return null;
          const all = await messages();
          const query =
            [...historyFor(all, cp.input.userMessageId)].reverse().find((m) => m.role === 'user')?.content ??
            '';
          return await deps.memory.pack({
            notebookId: cp.input.notebookId,
            modelId: target.id,
            contextWindow: target.context_window,
            query,
            ...(part && { part }),
          });
        } catch (err) {
          log.warn({ err }, 'memory could not be read; answering without it');
          return null;
        }
      };

      /** What the answer records about the memory it was given (provenance.memory). */
      const recordMemory = async (packs: (PackOut | null)[]) => {
        const got = packs.filter((p): p is PackOut => !!p);
        if (!got.length) return;
        const record: MemoryProvenance = {
          files: got.flatMap((p) => p.files),
          tokens: got.reduce((n, p) => n + p.tokens, 0),
          truncated: got.reduce((n, p) => n + p.truncated, 0),
        };
        if (JSON.stringify(record) !== JSON.stringify(cp.memory ?? null)) {
          cp.memory = record;
          await emit({
            type: 'memory.injected',
            files: record.files.map((f) => ({
              path: f.path,
              commit: f.commit,
              entries: f.entries.length,
              tokens: f.tokens,
            })),
            truncated: record.truncated,
          });
        }
      };

      /** The memory pack for the model about to be called, as one block; '' when there is none. */
      const injectMemory = async (target: ModelConfig | undefined): Promise<string> => {
        const pack = await readPack(target);
        await recordMemory([pack]);
        return pack?.text ?? '';
      };

      /** Once per turn: summarise an over-full path, and use any summary that covers it. */
      const compaction = async () => {
        cp.compactionChecked = true;
        if (!deps.branches) return;
        const all = await messages();
        // A flow can answer when no route can (its steps name their own models):
        // an empty route is no reason to fail the turn here.
        let model: ModelConfig | undefined;
        try {
          model = deps.registry.chain(cp.input.taskClass, cp.input.explicitModel)[0];
        } catch (err) {
          if (!(err instanceof NoRouteError)) throw err;
        }
        const prepared = await prepareTurnContext(
          {
            gateway: deps.gateway,
            registry: deps.registry,
            promptsDir: deps.promptsDir,
            branches: deps.branches,
          },
          {
            threadId: cp.input.threadId,
            messages: all,
            userMessageId: cp.input.userMessageId,
            model,
            system: 600,
            retrieval: cp.grounding?.block ? approxTokens(cp.grounding.block) : 0,
            signal: ctx.signal,
            watch: contextWatch(deps.switches),
          },
        );
        cp.compaction =
          prepared.provenance && prepared.skipThrough
            ? { ...prepared.provenance, note: prepared.note, skipThrough: prepared.skipThrough }
            : null;
      };

      // ---- Flows (Phase 5b): what a flow needs from this turn ----
      /** One model call for a flow node: streamed, costed, fallbacks recorded. */
      const flowCall = async (
        chain: ModelConfig[],
        req: ModelRequest,
        onDelta: (channel: 'text' | 'reasoning', delta: string) => void,
        opts: { computeWaitMs?: number },
      ): Promise<ModelCallResult> => {
        const out: ModelCallResult = {
          text: '',
          reasoning: '',
          modelId: chain[0]?.id ?? '',
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        };
        let current: ModelConfig | undefined = chain[0];
        let callStarted = Date.now();
        for await (const ev of watched(
          deps.gateway.stream(chain, req, ctx.signal, opts),
          recorder('model'),
        )) {
          if (ev.type === 'model') {
            current = deps.registry.get(ev.modelId);
            out.modelId = ev.modelId;
          } else if (ev.type === 'fallback') {
            cp.attempts.push({ model: ev.from, reason: ev.reason, detail: ev.detail });
            await emit({
              type: 'fallback',
              from_model: ev.from,
              to_model: ev.to,
              reason: ev.reason,
              detail: ev.detail,
            });
          } else if (ev.type === 'compute_waiting') {
            await emit({
              type: 'compute.waiting',
              node_id: ev.nodeId ?? ev.modelId,
              eta_s: ev.etaS,
              can_use_cloud: ev.canUseCloud,
              model_id: ev.modelId,
              detail: ev.detail,
            });
          } else if (ev.type === 'chunk') {
            const c = ev.chunk;
            if (c.type === 'text') {
              out.text += c.delta;
              onDelta('text', c.delta);
            } else if (c.type === 'reasoning') {
              out.reasoning += c.delta;
              if (c.delta) onDelta('reasoning', c.delta);
            } else if (c.type === 'tool_call') {
              out.toolCalls = [...(out.toolCalls ?? []), { callId: c.callId, tool: c.tool, args: c.args }];
            } else if (c.type === 'finish') {
              const spent = countCall(current, out.modelId, c, callStarted);
              callStarted = Date.now();
              out.tokensIn += c.usage.inputTokens;
              out.tokensOut += c.usage.outputTokens;
              out.costUsd += spent;
            }
          }
        }
        return out;
      };

      /** A Tool node: through the permission gate, pausing for a person like any tool call. */
      const flowTool = async (key: string, tool: string, args: unknown, nodeId?: string) => {
        const callId = `flow-${key}`;
        if (nodeId) cp.flowToolNodes = { ...(cp.flowToolNodes ?? {}), [callId]: nodeId };
        const settled = () => {
          const r = cp.parts.find((p) => p.type === 'tool_result' && p.call_id === callId);
          if (r?.type !== 'tool_result') return null;
          const output =
            r.declined_reason !== undefined
              ? `Declined${r.declined_reason ? `: ${r.declined_reason}` : ''}`
              : typeof r.result === 'string'
                ? r.result
                : JSON.stringify(r.result);
          return { status: 'done' as const, value: { ok: r.ok && r.declined_reason === undefined, output } };
        };
        const done = settled();
        if (done) return done;
        if (!cp.parts.some((p) => p.type === 'tool_call' && p.call_id === callId)) {
          cp.parts.push({ type: 'tool_call', call_id: callId, tool, args });
          started(callId);
          await emit({
            type: 'tool.call',
            call_id: callId,
            tool,
            args_preview: argsPreview(args),
            tier: deps.tools.get(tool)?.tier ?? 'gated',
            ...(nodeId && { node_id: nodeId }),
            title: stepTitle(tool, args),
          });
        }
        // The same step number every time this call is reached, so a restart replays it, never repeats it.
        const seq = cp.flowToolSeq?.[callId] ?? cp.nextSeq++;
        cp.flowToolSeq = { ...(cp.flowToolSeq ?? {}), [callId]: seq };
        const call: QueuedCall = { callId, tool, args, seq };
        const r = await handleCall(call);
        if (r === 'waiting') {
          cp.queue.push(call);
          return { status: 'waiting' as const };
        }
        return (
          settled() ?? { status: 'done' as const, value: { ok: false, output: 'The tool was stopped.' } }
        );
      };

      /** A Human node: a question to you, answered from the approval dialog. */
      const flowAsk = async (key: string, question: string, context: string) => {
        const callId = `flow-ask-${key}`;
        const approval = await deps.permissions.createApproval({
          runId: run.id,
          stepSeq: cp.nextSeq++,
          threadId: cp.input.threadId,
          callId,
          principal: PRINCIPAL,
          tool: 'flow.ask',
          action: 'flow.ask',
          resource: question.slice(0, 200),
          args: { question, context },
          argsPreview: { question, context: context.slice(0, 2_000) },
          tier: 'gated',
          suggestions: [],
          expiresAt: new Date(Date.now() + (deps.approvalTtlMs ?? APPROVAL_TTL_MS)).toISOString(),
        });
        if (approval.status === 'pending') {
          cp.waiting = { approvalId: approval.id, callId };
          await emit({
            type: 'approval.required',
            approval_id: approval.id,
            tool: 'flow.ask',
            action: 'flow.ask',
            resource: question.slice(0, 200),
            tier: 'gated',
            call_id: callId,
            args_preview: approval.args_preview,
            suggestions: [],
          });
          await deps.bus
            ?.publish({
              type: 'approval.requested',
              approval_id: approval.id,
              run_id: run.id,
              tool: 'flow.ask',
              tier: 'gated',
            })
            .catch(() => undefined);
          return { status: 'waiting' as const };
        }
        if (approval.status !== 'approved' && approval.status !== 'denied' && !approval.reason?.trim())
          return { status: 'expired' as const };
        const answer = approval.reason?.trim() || (approval.status === 'approved' ? 'Yes, go ahead.' : 'No.');
        return { status: 'done' as const, value: answer };
      };

      const runFlowTurn = async (): Promise<'done' | 'waiting'> => {
        const flows = deps.flows as FlowsService;
        const state = cp.flow as FlowState;
        const thread = await deps.repo.getThread(cp.input.threadId);
        const all = await deps.repo.messages(cp.input.threadId);
        const user = all.find((m) => m.id === cp.input.userMessageId);
        const byId = new Map(asTree(all).map((m) => [m.id, m] as const));
        const depth = ancestorPath(byId, cp.input.userMessageId).length;
        const notebookTitle = cp.input.notebookId
          ? ((await deps.notebookTitle?.(cp.input.notebookId).catch(() => null)) ?? null)
          : null;
        const rt = makeTurnRuntime({
          flows,
          input: {
            text: user ? textOf(user.parts) : '',
            threadId: cp.input.threadId,
            notebookId: cp.input.notebookId,
            notebookTitle,
            workspaceId: cp.input.workspaceId,
            messageId: msgId,
            userMessageId: cp.input.userMessageId,
            hasAttachment: !!user?.parts.some((p) => p.type === 'file' || p.type === 'image'),
            branchDepth: depth,
          },
          signal: ctx.signal,
          messages: () => deps.repo.messages(cp.input.threadId),
          compaction: cp.compaction
            ? { skipThrough: cp.compaction.skipThrough, summary: cp.compaction.note }
            : null,
          groundingBlock: [cp.grounding?.block ?? '', summariesBlock(cp.linked?.summaries ?? [])]
            .filter(Boolean)
            .join('\n\n'),
          ...(cp.input.sourceIds?.length && { mentionedSources: cp.input.sourceIds }),
          memory: injectMemory,
          // Scopes and context links hold inside a flow too, read again before every step.
          ...(deps.scopes && {
            scope: () =>
              (deps.scopes as ScopeResolver).effective({
                notebookId: cp.input.notebookId,
                threadId: cp.input.threadId,
              }),
          }),
          ...(deps.links && {
            linked: async () =>
              (await (deps.links as NonNullable<typeof deps.links>).forTurn(cp.input.threadId)).notebooks,
          }),
          emit: (e) => emit(e),
          call: flowCall,
          tool: flowTool,
          toolDefs: (names) =>
            deps.tools
              .list()
              .filter((t) => names.includes(t.name))
              .map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as Record<string, unknown>,
              })),
          ask: flowAsk,
          speak: (d) => {
            appendText(cp.parts, 'text', d);
            deltas.push('text.delta', d);
          },
          setAnswer: async (answer) => {
            await deltas.flush();
            cp.parts = [
              ...cp.parts.filter((p) => p.type !== 'text' && p.type !== 'reasoning'),
              { type: 'text', text: answer },
            ];
            await emit({ type: 'message.snapshot', message_id: msgId, parts: cp.parts });
          },
          save: () => ctx.checkpoint(cp),
          // A thread's step overrides apply only to the flow they were made for.
          ...(thread?.settings.flow_overrides &&
            thread.settings.flow_overrides_flow === state.flow.id && {
              overrides: thread.settings.flow_overrides,
            }),
        });
        const outcome = await executeFlow(state, withFlow(rt, state, flows.deps.store, cp.input.threadId));
        await deltas.flush();
        const models = state.steps.map((s) => s.model_id).filter((m): m is string => !!m);
        cp.chain = [...new Set(models)];
        const by = models.at(-1) ?? null;
        if (by && cp.answeredBy !== by) {
          cp.answeredBy = by;
          await emit({
            type: 'model',
            message_id: msgId,
            model_id: by,
            display_name: deps.registry.get(by)?.display_name ?? by,
          });
        }
        return outcome.kind;
      };
      // ---- end Flows ----

      type EngineOut = Awaited<ReturnType<EngineContextHook>> | null;

      /** Engines: a mixed thread's context fitted for this model, and the thread's instructions. */
      const callEngine = (
        chain: ModelConfig[],
        all: MessageRecord[],
        fixedTokens: number,
      ): Promise<EngineOut> =>
        deps.engineContext
          ? deps
              .engineContext({
                threadId: cp.input.threadId,
                notebookId: cp.input.notebookId,
                messages: all,
                userMessageId: cp.input.userMessageId,
                model: chain[0],
                compaction: cp.compaction
                  ? {
                      summaryId: cp.compaction.summary_id,
                      skipThrough: cp.compaction.skipThrough,
                      note: cp.compaction.note,
                    }
                  : null,
                fixedTokens,
              })
              .catch((err: unknown) => {
                log.warn({ err }, 'engine context could not be assembled; using the plain path');
                return null;
              })
          : Promise.resolve(null);

      /** This turn's passages and linked summaries, or the note that there were none. */
      const sourcesText = async (): Promise<string> =>
        [
          cp.grounding?.block ||
            (cp.grounding && cp.input.notebookId
              ? emptyNote((await deps.notebookTitle?.(cp.input.notebookId).catch(() => null)) ?? null)
              : ''),
          summariesBlock(cp.linked?.summaries ?? []),
        ]
          .filter(Boolean)
          .join('\n\n');

      /**
       * CA2 and CA3, once per turn before the first model round: find the epoch this
       * branch is in (or start one, for a reason on the closed list), and build the
       * context that goes in front of the newest question. What is frozen (system
       * prompt, tools, pinned memory) comes from the epoch; what varies is in the block.
       * Returns the engine's context when it had to be read to freeze the instructions.
       */
      const openFrame = async (
        chain: ModelConfig[],
        all: MessageRecord[],
        specs: ToolSpec[],
        withTools: boolean,
        sentMap: ReadonlyMap<string, SentForm>,
      ): Promise<EngineOut> => {
        const model0 = chain[0];
        const family = model0?.family ?? 'unknown';
        const endCtx = (await deps.endContext?.(family)) ?? true;
        const lane = `${family}${withTools ? '' : ':no-tools'}${endCtx ? '' : ':legacy'}`;
        const thread = await deps.repo.getThread(cp.input.threadId);
        const thinking = (thread?.settings as { thinking?: unknown } | undefined)?.thinking === true;
        // The epoch of the latest answer on this branch.
        let prev: EpochRecord | undefined;
        const path = pathFor(all, cp.input.userMessageId);
        for (let i = path.length - 1; i >= 0 && !prev; i--) {
          const id = sentMap.get((path[i] as MessageRecord).id)?.epoch_id;
          if (id) prev = await epochs.get(id);
        }
        const now = (deps.now ?? Date.now)();
        const sources = await sourcesText();
        const toolsNow = toolsBlock(specs, withTools);
        const compactionId = cp.compaction?.summary_id ?? null;

        let base = '';
        let pinned: PackOut | null = null;
        let ranked: PackOut | null = null;
        let engine: EngineOut = null;
        if (endCtx) {
          [base, pinned, ranked] = await Promise.all([
            systemPrompt({ promptsDir: deps.promptsDir, model: model0, tools: withTools, dated: false }),
            readPack(model0, 'pinned'),
            readPack(model0, 'ranked'),
          ]);
          engine = await callEngine(
            chain,
            all,
            approxTokens(
              [base, pinned?.text ?? '', ranked?.text ?? '', sources, cp.input.instructions ?? ''].join('\n'),
            ),
          );
        }
        const fresh = endCtx
          ? frozenSystem({
              base,
              memory: pinned?.text ?? '',
              instructions: engine?.instructions ?? '',
            })
          : '';
        const reason = epochReason(
          {
            prev,
            lane,
            thinking,
            specs,
            compactionId,
            now,
            ttlMs: cacheTtlMs(model0?.provider ?? ''),
            // Something frozen would read differently if it were frozen now.
            frozenIsStale:
              !!prev && (toolsNow.hash !== prev.tools_hash || (endCtx && fresh !== prev.system_text)),
          },
          withTools,
        );
        if (reason === 'tools_changed' && prev) warnToolsChanged(prev, specs, cp.input.threadId);

        const at = new Date(now).toISOString();
        let epoch: EpochRecord;
        if (reason || !prev) {
          const files = pinned?.files ?? [];
          const snapshot = Object.fromEntries(files.map((f) => [f.path, f.commit]));
          const commit = files.find((f) => f.commit)?.commit;
          epoch = {
            id: `${ID_PREFIX.epoch}_${ulid()}`,
            thread_id: cp.input.threadId,
            reason: reason ?? 'new_thread',
            model_family: lane,
            thinking,
            system_text: fresh,
            tools_json: toolsNow.json,
            tools_hash: toolsNow.hash,
            memory_commit: commit ? shortSha(commit) : null,
            memory_text: pinned?.text ?? '',
            instructions: engine?.instructions ?? '',
            display_name: model0?.display_name ?? '',
            compaction_id: compactionId,
            track: newTrack({
              snapshot,
              sent: snapshot,
              instructions_sent: engine?.instructions ?? '',
              tool_hashes: toolsNow.hashes,
            }),
            started_at: at,
            last_used_at: at,
          };
          await epochs.create(epoch);
          logEpochStart(epoch);
        } else epoch = prev;
        const started = epoch !== prev;

        // What the model has not been told yet goes at the end, and is remembered as told.
        const track = structuredClone(epoch.track);
        let memoryUpdate: { text: string; commits: string[] } | null = null;
        let instructionsUpdate = '';
        let note = '';
        if (endCtx) {
          if (!started) {
            const cur = Object.fromEntries((pinned?.files ?? []).map((f) => [f.path, f.commit]));
            const changed = Object.keys(cur).filter((k) => track.sent[k] !== cur[k]);
            if (changed.length) {
              memoryUpdate = {
                text: pinned?.text || '(No pinned notes remain.)',
                commits: [...new Set(changed.map((k) => shortSha(cur[k] as string)))],
              };
              track.sent = cur;
            }
            const instructions = engine?.instructions ?? '';
            if (instructions !== track.instructions_sent) {
              instructionsUpdate = instructions || 'No instructions are set now.';
              track.instructions_sent = instructions;
            }
          }
          if (engine?.history) note = engine.note;
          else if (cp.compaction && cp.compaction.summary_id !== track.summary_sent) {
            note = cp.compaction.note;
            track.summary_sent = cp.compaction.summary_id;
          }
        }
        await epochs.patch(epoch.id, { last_used_at: at, track });
        if (endCtx) await recordMemory([pinned, ranked]);

        const block = endCtx
          ? contextBlock({
              date: at.slice(0, 10),
              memoryUpdate,
              memoryRanked: ranked?.text ?? '',
              instructionsUpdate,
              note,
              answerInstructions: cp.input.instructions ?? '',
              bridged: withTools ? toolDrift(epoch, specs).bridged : [],
              sources,
            })
          : sources;
        cp.frame = {
          epochId: epoch.id,
          reason: epoch.reason,
          started,
          endContext: endCtx,
          lane,
          toolsHash: epoch.tools_hash,
          memoryCommit: epoch.memory_commit,
          block,
        };
        pendingWrites.push(
          deps.repo
            .updateMessage(msgId, { epoch_id: epoch.id })
            .catch((err) => log.warn({ err }, 'could not record the epoch of this answer')),
        );
        return engine;
      };

      const modelRound = async () => {
        // A later round follows tool calls: read again so nothing is stale.
        if (cp.rounds > 0) historyRead = null;
        const all = await messages();
        let chain: ModelConfig[];
        try {
          chain = deps.registry.chain(cp.input.taskClass, cp.input.explicitModel);
        } catch (err) {
          // The thread's model runs on a GPU node that is stopped (its models are not
          // offered while it is): say that, with Start node, not "No model is ready".
          const asked = cp.input.explicitModel ?? cp.input.threadModelUnready ?? null;
          if (err instanceof NoRouteError && asked?.startsWith('node/')) throw nodeStopped(asked);
          throw err;
        }
        cp.chain = chain.map((m) => m.id);
        // CA3: the tools are one epoch's canonical superset for this notebook, whatever
        // the permissions say; a model without the tools capability is offered none.
        const withTools = !!chain[0]?.capabilities.includes('tools');
        const specs = toolsInScope(deps.tools.list(), cp.input.notebookId);
        // CA4: what earlier messages were sent as, and the epochs answers were written in.
        const sentMap = await deps.repo.sentForms(pathFor(all, cp.input.userMessageId).map((m) => m.id));
        if (cp.frame && !(await epochs.get(cp.frame.epochId))) cp.frame = null;
        const opened = cp.frame ? null : await openFrame(chain, all, specs, withTools, sentMap);
        const frame = cp.frame as TurnFrame;
        const epoch = (await epochs.get(frame.epochId)) as EpochRecord;
        const tools = withTools ? (JSON.parse(epoch.tools_json) as ToolDef[]) : [];
        let system: string;
        let engine: EngineOut;
        if (frame.endContext) {
          system = epoch.system_text;
          engine =
            opened ?? (await callEngine(chain, all, approxTokens(`${epoch.system_text}\n${frame.block}`)));
        } else {
          // The family's switch is off: everything that varies is in the system prompt, as before.
          const [base, memory] = await Promise.all([
            systemPrompt({ promptsDir: deps.promptsDir, model: chain[0], tools: withTools }),
            injectMemory(chain[0]),
          ]);
          engine = await callEngine(
            chain,
            all,
            approxTokens([base, memory, frame.block, cp.input.instructions ?? ''].join('\n')),
          );
          system = [
            base,
            memory,
            engine?.instructions,
            engine?.history ? engine.note : cp.compaction?.note,
            cp.input.instructions,
          ]
            .filter(Boolean)
            .join('\n\n');
        }
        if (engine?.report) cp.engineContext = engine.report;
        const splitSystem = frame.endContext ? systemBlocks(epoch) : null;
        const history = withPartial(
          engine?.history ?? historyFor(all, cp.input.userMessageId, cp.compaction?.skipThrough, sentMap),
          cp.parts,
        );
        const req: ModelRequest = {
          // What stays the same from turn to turn comes first, so providers' prompt
          // caches (Anthropic, OpenAI, vLLM's prefix cache, Ollama's KV cache) hold
          // across turns: the tools and the system prompt are frozen for the epoch, and
          // everything that varies rides on the question (docs/prompt-caching.md).
          system,
          // CA5: the rules and the snapshot apart, so Anthropic can mark both ends.
          ...(splitSystem && { systemBlocks: splitSystem }),
          messages: withTurnContext(history, frame.block),
          meta: { threadId: cp.input.threadId, notebookId: cp.input.notebookId },
          // CA5: provider cache keys: the same on every turn of this branch in this epoch.
          cache: {
            threadId: cp.input.threadId,
            branch: branchKeyFor(all, cp.input.userMessageId),
            epochId: frame.epochId,
          },
          ...(tools.length && { tools, toolChoice: 'auto' as const }),
        };
        // CA4: the newest question as it is sent now, stored as text for the turns that follow.
        if (cp.rounds === 0) {
          const q = req.messages.findLast((m) => m.role === 'user');
          if (q && !q.parts?.some((p) => p.type === 'image' || p.type === 'file')) {
            const text = sentText(toSdkMessages([q], { tools: true }));
            if (text)
              pendingWrites.push(
                deps.repo
                  .updateMessage(cp.input.userMessageId, { sent: text })
                  .catch((err) => log.warn({ err }, 'could not store the question as it was sent')),
              );
          }
        }
        let current: ModelConfig | undefined;
        const callStarted = Date.now();
        for await (const ev of watched(deps.gateway.stream(chain, req, ctx.signal), recorder('model'))) {
          switch (ev.type) {
            case 'model':
              current = deps.registry.get(ev.modelId);
              if (cp.answeredBy !== ev.modelId) {
                cp.answeredBy = ev.modelId;
                await deltas.flush();
                await emit({
                  type: 'model',
                  message_id: msgId,
                  model_id: ev.modelId,
                  display_name: current?.display_name ?? ev.modelId,
                });
                // Recorded without holding up the first word; awaited before the step ends.
                pendingWrites.push(
                  deps.repo
                    .updateMessage(msgId, { model_id: ev.modelId })
                    .catch((err) => log.warn({ err }, 'could not record which model answered')),
                );
              }
              break;
            case 'fallback':
              cp.attempts.push({ model: ev.from, reason: ev.reason, detail: ev.detail });
              await deltas.flush();
              await emit({
                type: 'fallback',
                from_model: ev.from,
                to_model: ev.to,
                reason: ev.reason,
                detail: ev.detail,
              });
              log.warn({ from: ev.from, to: ev.to, reason: ev.reason }, 'model fell back');
              break;
            case 'seam':
              cp.parts.push({ type: 'seam', from_model: ev.from, to_model: ev.to, reason: ev.reason });
              break;
            // ---- Phase 5: the model's GPU node is waking (gateway/compute.ts) ----
            case 'compute_waiting':
              await deltas.flush();
              await emit({
                type: 'compute.waiting',
                node_id: ev.nodeId ?? ev.modelId,
                eta_s: ev.etaS,
                can_use_cloud: ev.canUseCloud,
                model_id: ev.modelId,
                detail: ev.detail,
              });
              break;
            // ---- end Phase 5 ----
            case 'chunk': {
              const c = ev.chunk;
              if (c.type === 'text') {
                appendText(cp.parts, 'text', c.delta);
                deltas.push('text.delta', c.delta);
              } else if (c.type === 'reasoning') {
                appendReasoning(cp.parts, c, reasoningState);
                if (c.delta) deltas.push('reasoning.delta', c.delta);
              } else if (c.type === 'tool_call') {
                await deltas.flush();
                const seq = cp.nextSeq++;
                cp.parts.push({
                  type: 'tool_call',
                  call_id: c.callId,
                  tool: c.tool,
                  args: c.args,
                  ...(c.meta && { provider_meta: c.meta }),
                });
                cp.queue.push({ callId: c.callId, tool: c.tool, args: c.args, seq });
                started(c.callId);
                // A bridged call is shown as the tool it reaches.
                const shown = bridge({ callId: c.callId, tool: c.tool, args: c.args, seq });
                const real = 'call' in shown ? shown.call : { tool: c.tool, args: c.args };
                const spec = deps.tools.get(real.tool);
                await emit({
                  type: 'tool.call',
                  call_id: c.callId,
                  tool: real.tool,
                  args_preview: argsPreview(real.args),
                  tier: spec?.tier ?? 'gated',
                  title: stepTitle(real.tool, real.args),
                });
              } else if (c.type === 'warning') {
                await deltas.flush();
                await emit({ type: 'warning', code: c.code, message: c.message });
              } else if (c.type === 'finish') {
                countCall(current, cp.answeredBy ?? '', c, callStarted);
                if (c.cacheReset) {
                  cp.cacheResets = [
                    ...(cp.cacheResets ?? []),
                    { model_id: cp.answeredBy ?? '', ...c.cacheReset },
                  ];
                  log.info(
                    { model: cp.answeredBy, reason: c.cacheReset.reason, provider: c.cacheReset.provider },
                    'cache reset on purpose',
                  );
                }
              }
              break;
            }
          }
        }
        await deltas.flush();
        await Promise.all(pendingWrites.splice(0));
        cp.rounds += 1;
        if (cp.queue.length === 0) cp.answered = true;
      };

      try {
        // An approval this run was waiting on has been answered.
        if (cp.waiting) {
          const approval = await deps.permissions.getApproval(cp.waiting.approvalId);
          if (approval?.status === 'pending') return { kind: 'pause', reason: 'approval', checkpoint: cp };
          const call = cp.queue.find((q) => q.callId === cp.waiting?.callId);
          cp.waiting = null;
          // No approval on record (lost before it was saved): the call stays
          // queued and asks again below.
          if (call && approval) {
            cp.queue = cp.queue.filter((q) => q !== call);
            await answer(call, approval);
          }
          await ctx.checkpoint(cp);
        }

        // Retrieval and the compaction check are reads, safe to repeat after a
        // restart, so they share the checkpoint written once the route is known.
        if (!cp.retrieved) await retrieve();

        // ---- Branching (DESIGN.md §8.4): compact past the critical line, then substitute.
        if (!cp.compactionChecked) await compaction();

        // ---- Flows (Phase 5b): a flow answers instead of the single model round ----
        if (deps.flows && !cp.flowChecked) {
          cp.flowChecked = true;
          const { thread, resolved: found } = await (flowLookup ??
            deps.repo.getThread(cp.input.threadId).then(async (thread) => ({
              thread,
              resolved: thread ? await deps.flows?.resolve(thread, cp.input.flowId ?? null) : null,
            })));
          const resolved = found ?? null;
          const chosenForAnswer = !!(cp.input.flowId || cp.input.flowReplay || cp.input.routeAgain);
          // A model chosen for this message answers instead of any flow
          // (DESIGN.md §16.3): the flow is set aside, and the answer says so.
          const messageModel = cp.input.modelFrom === 'message' && !chosenForAnswer;
          cp.flow =
            thread && !messageModel
              ? await deps.flows.startState(thread, {
                  resolved,
                  flowId: cp.input.flowId ?? null,
                  replay: cp.input.flowReplay ?? null,
                  routeAgain: cp.input.routeAgain ?? null,
                })
              : null;
          if (cp.flow) {
            cp.route = {
              kind: 'flow',
              from: chosenForAnswer || !resolved || resolved.from === 'none' ? 'message' : resolved.from,
              flow_id: cp.flow.flow.id,
            };
          } else {
            const set =
              messageModel && resolved?.flow && resolved.from !== 'message' && resolved.from !== 'none'
                ? {
                    flow_id: resolved.flow.id,
                    name: resolved.flow.name,
                    from: resolved.from,
                    because: 'message_model' as const,
                  }
                : resolved?.paused
                  ? { ...resolved.paused, flow_id: resolved.paused.id, because: 'thread_paused' as const }
                  : undefined;
            cp.route = {
              kind: 'model',
              from: cp.input.modelFrom ?? 'default',
              ...(set && {
                skipped_flow: { flow_id: set.flow_id, name: set.name, from: set.from, because: set.because },
              }),
            };
          }
          await ctx.checkpoint(cp);
        }
        if (cp.flow && !cp.answered) {
          const outcome = await runFlowTurn();
          if (outcome === 'waiting') return { kind: 'pause', reason: 'approval', checkpoint: cp };
          cp.answered = true;
          await ctx.checkpoint(cp);
        }
        // ---- end Flows ----

        /** LB1: a call that kept failing ends the turn here, in words the user reads. */
        const stopForLoop = async () => {
          if (!cp.loopStop) return;
          // Every call the model made needs an answer; the rest are not run.
          for (const rest of cp.queue.splice(0))
            await settle(
              rest,
              {
                type: 'tool_result',
                call_id: rest.callId,
                ok: false,
                result: 'Not run: the turn was stopped because an earlier call kept failing.',
              },
              false,
            );
          appendText(
            cp.parts,
            'text',
            `

${cp.loopStop}`,
          );
          cp.loopStop = undefined;
          cp.answered = true;
        };

        for (;;) {
          while (cp.queue.length) {
            const call = cp.queue[0] as QueuedCall;
            const settled = await handleCall(call);
            if (settled === 'waiting') return { kind: 'pause', reason: 'approval', checkpoint: cp };
            if (settled === 'stopped') break;
            cp.queue.shift();
            await stopForLoop();
            await ctx.checkpoint(cp);
          }
          await stopForLoop(); // a call answered after an approval may have been the one that tripped it
          if (cp.answered || ctx.signal.aborted) break;
          if (cp.rounds >= maxRounds) {
            appendText(
              cp.parts,
              'text',
              `\n\nI stopped after ${maxRounds} rounds of tool calls. Ask me to continue if you want me to keep going.`,
            );
            break;
          }
          await modelRound();
          await ctx.checkpoint(cp);
        }

        if (ctx.signal.aborted) {
          if (ctx.signal.reason instanceof RunOwnershipLost) throw ctx.signal.reason;
          await finalise(cp, 'stopped', { emit });
          return { kind: 'cancelled' };
        }
        await finalise(cp, 'complete', { emit });
        // Learn from the turn in the background; it never holds the answer up.
        const memoryScope = await deps.scopes
          ?.effective({ notebookId: cp.input.notebookId, threadId: cp.input.threadId })
          .catch(() => null);
        // Memory is only learned from where the scope allows writing it (a failed read writes nothing).
        if (!deps.scopes || memoryScope?.scope.memory_write)
          void deps.memory?.afterTurn({
            threadId: cp.input.threadId,
            notebookId: cp.input.notebookId,
            userMessageId: cp.input.userMessageId,
            assistantMessageId: cp.input.assistantMessageId,
            runId: run.id,
            parts: cp.parts,
          });
        // ---- Phase 4: after-answer hook (grounded mode fact-check) ----
        if (deps.afterAnswer && cp.answeredBy) {
          await deps
            .afterAnswer({
              messageId: cp.input.assistantMessageId,
              threadId: cp.input.threadId,
              workspaceId: cp.input.workspaceId,
              notebookId: cp.input.notebookId,
              userMessageId: cp.input.userMessageId,
              flowId: cp.flow?.flow.id ?? null,
              modelId: cp.answeredBy,
              ...(cp.input.provenanceExtra && { extra: cp.input.provenanceExtra }),
            })
            .catch((err) => log.warn({ err }, 'the after-answer step failed; the answer is unaffected'));
        }
        // ---- end Phase 4 hook ----
        return { kind: 'done' };
      } catch (err) {
        await deltas.flush().catch(() => undefined);
        // Another worker owns this run now: write nothing more.
        if (err instanceof RunOwnershipLost || ctx.signal.reason instanceof RunOwnershipLost) throw err;
        if (ctx.signal.aborted) {
          await finalise(cp, 'stopped', { emit });
          return { kind: 'cancelled' };
        }
        const failure = describeFailure(err);
        if (!failure) throw err;
        const { code, title, hint } = failure.event;
        await finalise(cp, 'error', { emit }, { code, title, hint });
        await emit({ type: 'error', ...failure.event });
        return {
          kind: 'failed',
          error: { code: failure.event.code, title: failure.event.title, hint: failure.event.hint },
        };
      }
    },

    async cancelled(run: RunRecord) {
      const cp = run.checkpoint as TurnCheckpoint;
      await deps.permissions.cancelApprovalsForRun(run.id);
      await deps.repo.updateMessage(cp.input.assistantMessageId, { status: 'stopped', parts: cp.parts });
    },

    async failed(run: RunRecord, error) {
      const cp = run.checkpoint as TurnCheckpoint;
      await deps.permissions.cancelApprovalsForRun(run.id);
      await deps.repo.updateMessage(cp.input.assistantMessageId, {
        status: 'error',
        parts: cp.parts,
        provenance: { chain: cp.chain, attempts: cp.attempts, error },
      });
      await deps.repo.patchThread(cp.input.threadId, {});
    },
  };
}

/** A turn for a GPU node's model that no route can answer while the node is stopped. */
export function nodeStopped(modelId: string): AncileError {
  return new AncileError({
    code: 'compute.node_stopped',
    title: 'Your GPU node is stopped',
    hint: `Start node to wake it (usually a minute or two), then try again. It serves ${modelId.replace(/^node\//, '')}.`,
    status: 409,
    errorClass: 'permanent',
    context: { model_id: modelId },
  });
}

function describeFailure(
  err: unknown,
): { event: Omit<Extract<RunEvent, { type: 'error' }>, 'seq' | 'at' | 'type'> } | null {
  if (err instanceof NoRouteError) {
    return {
      event: {
        code: 'model.not_configured',
        title: 'No model is ready to answer',
        hint: 'Add a provider key in Settings → Models, or start Ancile with the offline test model.',
        attempts: [],
      },
    };
  }
  if (err instanceof ChainFailedError) {
    const attempts: Attempt[] = err.attempts.map((a) => ({
      target: a.model,
      class: a.errorClass,
      ms: 0,
      note: a.detail.slice(0, 300),
    }));
    // The last model's trouble, when its provider's adapter named it (no credit, wrong region...).
    const named = err.attempts.at(-1);
    if (named?.code && named.title && named.hint)
      return { event: { code: named.code, title: named.title, hint: named.hint, attempts } };
    const auth = err.attempts.some((a) => /401|403|api key|x-api-key|unauthor/i.test(a.detail));
    return {
      event: {
        code: 'model.chain_exhausted',
        title: 'No model could answer',
        hint: auth
          ? 'A provider rejected its key. Update it in Settings → Models.'
          : 'Each attempt and its reason are listed. Check your keys and Health.',
        attempts,
      },
    };
  }
  if (err instanceof AncileError) {
    return { event: { code: err.code, title: err.title, hint: err.hint, attempts: err.attempts } };
  }
  return null;
}

/** One line of markdown as plain text: '## **Plan** for [Q3](x)' → 'Plan for Q3'. */
export function plainLine(l: string): string {
  return l
    .replace(/^\s*```.*$/, '')
    .replace(/^\s*[-*_]{3,}\s*$/, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`|\*|_)(\S(?:.*?\S)?)\1/g, '$2')
    .trim();
}

/** The first line of the user's message that says something, as a thread title. */
export function titleFrom(parts: Part[]): string {
  const line =
    textOf(parts)
      .replace(/^\/\w+\s*/, '')
      .split('\n')
      .map(plainLine)
      .find(Boolean) ?? '';
  const t = line.replace(/\s+/g, ' ').trim();
  if (!t) return 'New thread';
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}
