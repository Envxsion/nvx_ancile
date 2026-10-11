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
  type ModelConfig,
  type Part,
  type RunEvent,
  type Usage,
} from '@nvx/contracts';
import type { EventBus } from '../events/bus';
import { executeFlow, type FlowState, type ModelCallResult, provenanceOf } from '../flows/execute';
import {
  type FlowReplay,
  type FlowsService,
  makeTurnRuntime,
  type RouteAgain,
  withFlow,
} from '../flows/turn';
import { ChainFailedError, type Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import { NoRouteError } from '../gateway/router';
import type { ModelRequest, ToolDef } from '../gateway/types';
import { approxTokens } from '../memory/inject';
import type { MemoryService } from '../memory/service';
import { logFor } from '../obs/logger';
import { type ReplayInput, replayedResult } from '../obs/replay';
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
import type { BranchStore } from '../threads/branches';
import { prepareTurnContext } from '../threads/compact';
import { ancestorPath } from '../threads/path';
import { asTree, type ThreadRepo, textOf } from '../threads/repo';
import type { ToolRegistry, ToolSpec } from '../tools/registry';
import { applyCitations } from './citations';
import { historyFor, systemPrompt, withPartial } from './context';
import { DEFAULT_K, emptyNote, type Grounding, groundingFrom, queryFor, type Retriever } from './retrieval';

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
  answeredBy: string | null;
  chain: string[];
  attempts: { model: string; reason: string; detail: string }[];
  usage: { input: number; output: number; cached: number; costUsd: number };
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
}

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

function cost(
  m: ModelConfig | undefined,
  u: { inputTokens: number; outputTokens: number; cachedTokens?: number },
): number {
  if (!m) return 0;
  const cached = u.cachedTokens ?? 0;
  const p = m.price;
  return (
    ((u.inputTokens - cached) * p.input_per_mtok +
      cached * (p.cached_per_mtok ?? p.input_per_mtok) +
      u.outputTokens * p.output_per_mtok) /
    1_000_000
  );
}

function appendText(parts: Part[], type: 'text' | 'reasoning', delta: string) {
  const last = parts.at(-1);
  if (last && last.type === type) last.text += delta;
  else parts.push(type === 'text' ? { type: 'text', text: delta } : { type: 'reasoning', text: delta });
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

  async function finalise(
    cp: TurnCheckpoint,
    status: 'complete' | 'stopped' | 'error',
    ctx: { emit: (e: RunEventInput) => Promise<unknown> },
    error?: { code: string; title: string; hint: string },
  ) {
    const model = cp.answeredBy ? deps.registry.get(cp.answeredBy) : undefined;
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
    const usage: Usage = {
      input_tokens: cp.usage.input,
      output_tokens: cp.usage.output,
      cached_tokens: cp.usage.cached,
      cost_usd: cp.usage.costUsd,
    };
    await deps.repo.updateMessage(cp.input.assistantMessageId, {
      parts: cp.parts,
      status,
      model_id: cp.answeredBy,
      usage: cp.answeredBy ? usage : null,
      provenance: {
        ...cp.input.provenanceExtra,
        chain: cp.chain,
        attempts: cp.attempts,
        model_name: model?.display_name ?? null,
        ...retrieval,
        ...(cp.memory && { memory: cp.memory }),
        ...(cp.input.replay && {
          rerun_of: { run_id: cp.input.replay.fromRunId, from_step: cp.input.replay.fromStep },
        }),
        ...(cp.compaction && { compaction: compactionOut(cp.compaction) }),
        ...(cp.flow && { flow: provenanceOf(cp.flow) }),
        route: routeOf(cp),
        ...(error && { error }),
      },
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
      // Bookkeeping writes that need not hold up the stream; awaited at the end of each round.
      const pendingWrites: Promise<unknown>[] = [];
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

      const settle = async (call: QueuedCall, result: Extract<Part, { type: 'tool_result' }>) => {
        cp.parts.push(result);
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
              const timeout = AbortSignal.timeout(deps.toolTimeoutMs ?? 60_000);
              const signal = AbortSignal.any([ctx.signal, timeout]);
              return spec.execute(call.args, { idempotencyKey: `${run.id}:${call.seq}`, signal, scope });
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

      /** Act on an answered approval: run the tool, or tell the model it was declined. */
      const answer = async (call: QueuedCall, approval: ApprovalRecord) => {
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
      const handleCall = async (call: QueuedCall): Promise<'done' | 'waiting' | 'stopped'> => {
        // ---- Phase 5: a re-run never runs a tool; it is answered from the record ----
        if (cp.input.replay) {
          const r = replayedResult(cp.input.replay, cp.replayUsed ?? [], call);
          if (r.index !== null) cp.replayUsed = [...(cp.replayUsed ?? []), r.index];
          await settle(call, { type: 'tool_result', call_id: call.callId, ok: r.ok, result: r.result });
          return 'done';
        }
        // ---- end Phase 5 replay ----
        const spec = deps.tools.get(call.tool);
        if (!spec) {
          await settle(call, {
            type: 'tool_result',
            call_id: call.callId,
            ok: false,
            result: `There is no tool called "${call.tool}".`,
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
        });
        if (decision.outcome === 'allow') {
          await runTool(call, spec);
          return 'done';
        }
        if (decision.outcome === 'deny') {
          const why =
            decision.via === 'policy'
              ? `A policy blocks this (${decision.policyId ?? 'policy'}).`
              : decision.reason;
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

      /** Once per turn, in a notebook: find the passages this question needs. */
      const retrieve = async () => {
        cp.retrieved = true;
        const notebookId = cp.input.notebookId;
        if (!notebookId || !deps.retriever) return;
        const started = Date.now();
        const all = await messages();
        const questions = historyFor(all, cp.input.userMessageId)
          .filter((m) => m.role === 'user')
          .map((m) => m.content);
        const query = queryFor(questions);
        // The notebook's title is only for the answer's wording: read it beside the search.
        const titleRead = deps.notebookTitle?.(notebookId).catch(() => null) ?? Promise.resolve(null);
        try {
          const res = await deps.retriever.search({
            workspaceId: cp.input.workspaceId,
            notebookId,
            query,
            k: DEFAULT_K,
            ...(cp.input.sourceIds?.length && { sourceIds: cp.input.sourceIds }),
          });
          cp.grounding = groundingFrom(res, { query, notebookId, notebookTitle: (await titleRead) ?? null });
        } catch (err) {
          cp.grounding = null;
          cp.retrievalError = {
            code: err instanceof AncileError ? err.code : 'knowledge.failed',
            title: err instanceof AncileError ? err.title : 'The sources could not be searched',
          };
          log.warn({ err }, 'retrieval failed; answering without sources');
        }
        const hits = cp.grounding?.trace.hits ?? [];
        await emit({
          type: 'retrieval.done',
          chunks: hits.length,
          sources: new Set(hits.map((h) => h.source_id)).size,
          ms: Date.now() - started,
        });
      };

      /** The memory pack for the model about to be called; '' when there is none. */
      const injectMemory = async (target: ModelConfig | undefined): Promise<string> => {
        if (!deps.memory || !target) return '';
        try {
          const all = await messages();
          const query =
            [...historyFor(all, cp.input.userMessageId)].reverse().find((m) => m.role === 'user')?.content ??
            '';
          const pack = await deps.memory.pack({
            notebookId: cp.input.notebookId,
            modelId: target.id,
            contextWindow: target.context_window,
            query,
          });
          const record: MemoryProvenance = {
            files: pack.files,
            tokens: pack.tokens,
            truncated: pack.truncated,
          };
          if (JSON.stringify(record) !== JSON.stringify(cp.memory ?? null)) {
            cp.memory = record;
            await emit({
              type: 'memory.injected',
              files: pack.files.map((f) => ({
                path: f.path,
                commit: f.commit,
                entries: f.entries.length,
                tokens: f.tokens,
              })),
              truncated: pack.truncated,
            });
          }
          return pack.text;
        } catch (err) {
          log.warn({ err }, 'memory could not be read; answering without it');
          return '';
        }
      };

      /** Once per turn: summarise an over-full path, and use any summary that covers it. */
      const compaction = async () => {
        cp.compactionChecked = true;
        if (!deps.branches) return;
        const all = await messages();
        const model = deps.registry.chain(cp.input.taskClass, cp.input.explicitModel)[0];
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
        for await (const ev of deps.gateway.stream(chain, req, ctx.signal, opts)) {
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
              onDelta('reasoning', c.delta);
            } else if (c.type === 'tool_call') {
              out.toolCalls = [...(out.toolCalls ?? []), { callId: c.callId, tool: c.tool, args: c.args }];
            } else if (c.type === 'finish') {
              const spent = cost(current, c.usage);
              out.tokensIn += c.usage.inputTokens;
              out.tokensOut += c.usage.outputTokens;
              out.costUsd += spent;
              cp.usage.input += c.usage.inputTokens;
              cp.usage.output += c.usage.outputTokens;
              cp.usage.cached += c.usage.cachedTokens ?? 0;
              cp.usage.costUsd += spent;
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
          await emit({
            type: 'tool.call',
            call_id: callId,
            tool,
            args_preview: argsPreview(args),
            tier: deps.tools.get(tool)?.tier ?? 'gated',
            ...(nodeId && { node_id: nodeId }),
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
        const answer =
          approval.reason?.trim() ||
          (approval.status === 'approved'
            ? 'Yes, go ahead.'
            : approval.status === 'denied'
              ? 'No.'
              : 'Nobody answered in time.');
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
          groundingBlock: cp.grounding?.block ?? '',
          ...(cp.input.sourceIds?.length && { mentionedSources: cp.input.sourceIds }),
          memory: injectMemory,
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

      const modelRound = async () => {
        // A later round follows tool calls: read again so nothing is stale.
        if (cp.rounds > 0) historyRead = null;
        const all = await messages();
        const history = withPartial(
          historyFor(all, cp.input.userMessageId, cp.compaction?.skipThrough),
          cp.parts,
        );
        const chain = deps.registry.chain(cp.input.taskClass, cp.input.explicitModel);
        cp.chain = chain.map((m) => m.id);
        const tools: ToolDef[] = deps.tools.list().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));
        // ---- memory (Phase 4): read beside the system prompt ----
        const [base, memory] = await Promise.all([
          systemPrompt({
            promptsDir: deps.promptsDir,
            model: chain[0],
            tools: tools.length > 0,
          }),
          injectMemory(chain[0]),
        ]);
        // ---- end memory ----
        const sources =
          cp.grounding?.block ||
          (cp.grounding && cp.input.notebookId
            ? emptyNote((await deps.notebookTitle?.(cp.input.notebookId).catch(() => null)) ?? null)
            : '');
        const req: ModelRequest = {
          system: [base, memory, cp.compaction?.note, sources, cp.input.instructions]
            .filter(Boolean)
            .join('\n\n'),
          messages: history,
          ...(tools.length && { tools }),
        };
        let current: ModelConfig | undefined;
        for await (const ev of deps.gateway.stream(chain, req, ctx.signal)) {
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
                appendText(cp.parts, 'reasoning', c.delta);
                deltas.push('reasoning.delta', c.delta);
              } else if (c.type === 'tool_call') {
                await deltas.flush();
                const seq = cp.nextSeq++;
                cp.parts.push({ type: 'tool_call', call_id: c.callId, tool: c.tool, args: c.args });
                cp.queue.push({ callId: c.callId, tool: c.tool, args: c.args, seq });
                const spec = deps.tools.get(c.tool);
                await emit({
                  type: 'tool.call',
                  call_id: c.callId,
                  tool: c.tool,
                  args_preview: argsPreview(c.args),
                  tier: spec?.tier ?? 'gated',
                });
              } else if (c.type === 'finish') {
                cp.usage.input += c.usage.inputTokens;
                cp.usage.output += c.usage.outputTokens;
                cp.usage.cached += c.usage.cachedTokens ?? 0;
                cp.usage.costUsd += cost(current, c.usage);
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

        for (;;) {
          while (cp.queue.length) {
            const call = cp.queue[0] as QueuedCall;
            const settled = await handleCall(call);
            if (settled === 'waiting') return { kind: 'pause', reason: 'approval', checkpoint: cp };
            if (settled === 'stopped') break;
            cp.queue.shift();
            await ctx.checkpoint(cp);
          }
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
