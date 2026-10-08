/**
 * ------------------------------------------------------------------
 *  Title    |  Try a message
 *  Ref      |  DESIGN.md §16.6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Run a flow (saved, or the graph in the editor) on a
 *           |  message without writing anything to a thread, streaming
 *           |  the same teamwork events a real answer does.
 *  How      |  A durable run of kind `flow_try`. A thread may lend its
 *           |  context: the message is answered as if it were sent at
 *           |  `head_id`. Tools and questions to you do not run here.
 *           |  With `mock`, every node uses the offline test model at
 *           |  no cost (a dry run of the routing itself).
 * ------------------------------------------------------------------
 */

import type { Flow, FlowGraph, ModelConfig } from '@nvx/contracts';
import { OFFLINE_MODELS } from '../gateway/fake';
import type { RunContext, RunHandler, RunOutcome } from '../runs/engine';
import type { RunEventInput } from '../runs/events';
import type { MessageRecord } from '../threads/repo';
import { streamCall } from './call';
import { executeFlow, type FlowRuntime, type FlowState, initialFlowState } from './execute';
import { type FlowsService, makeTurnRuntime } from './turn';

export interface TryCheckpoint {
  v: 1;
  state: FlowState;
  text: string;
  threadId: string | null;
  headId: string | null;
  workspaceId: string;
  notebookId: string | null;
  mock: boolean;
  messageId: string;
  /** A saved flow's id, for its nodes' "last run". */
  savedFlowId: string | null;
}

export const TRY_USER_ID = '__try__';

export function tryState(
  flow: (Pick<Flow, 'id' | 'name' | 'version' | 'scope'> & FlowGraph) | null,
  graph: FlowGraph | undefined,
): FlowState {
  if (graph)
    return initialFlowState({
      id: flow?.id ?? 'draft',
      name: flow?.name ?? 'Draft',
      version: flow?.version ?? 0,
      scope: flow?.scope ?? 'workspace',
      ...graph,
    });
  return initialFlowState(flow as Pick<Flow, 'id' | 'name' | 'version' | 'scope'> & FlowGraph);
}

/** Messages with the tried text added as a reply to `headId`, so context is built as for a real send. */
export function withVirtual(
  all: MessageRecord[],
  headId: string | null,
  text: string,
  threadId: string,
): MessageRecord[] {
  const virtual = {
    id: TRY_USER_ID,
    thread_id: threadId,
    parent_id: headId,
    role: 'user',
    parts: [{ type: 'text', text }],
    status: 'complete',
    model_id: null,
    requested_model_id: null,
    edit_of_id: null,
    provenance: {},
    usage: null,
    run_id: null,
    trace_id: '0'.repeat(32),
    created_at: new Date().toISOString(),
    deleted_at: null,
  } as unknown as MessageRecord;
  return [...all, virtual];
}

export function mockModels(): ModelConfig[] {
  return OFFLINE_MODELS.filter((m) => m.id === 'offline/test');
}

export function flowTryHandler(flows: FlowsService): RunHandler {
  return {
    async execute(ctx: RunContext): Promise<RunOutcome> {
      const cp = structuredClone(ctx.run.checkpoint) as TryCheckpoint;
      const { repo, gateway, registry } = flows.deps;
      const emit = (e: RunEventInput) => ctx.events.append(ctx.run.id, e);
      const all = cp.threadId
        ? withVirtual(await repo.messages(cp.threadId), cp.headId, cp.text, cp.threadId)
        : withVirtual([], null, cp.text, 'try');
      const grounding = cp.notebookId
        ? await flows.retrievePassages({
            workspaceId: cp.workspaceId,
            notebookId: cp.notebookId,
            query: cp.text,
            k: 8,
          })
        : '';
      let answer = '';
      const rt: FlowRuntime = makeTurnRuntime({
        flows,
        input: {
          text: cp.text,
          threadId: cp.threadId,
          notebookId: cp.notebookId,
          notebookTitle: null,
          workspaceId: cp.workspaceId,
          messageId: cp.messageId,
          userMessageId: TRY_USER_ID,
          hasAttachment: false,
          branchDepth: all.length,
        },
        signal: ctx.signal,
        messages: async () => all,
        compaction: null,
        groundingBlock: grounding,
        memory: async (model) =>
          (await flows.deps.memory?.({ notebookId: cp.notebookId, model, query: cp.text }).catch(() => '')) ??
          '',
        emit,
        call: (chain, req, onDelta, opts) =>
          streamCall({ gateway, registry }, chain, req, ctx.signal, onDelta, opts),
        speak: (delta) => {
          answer += delta;
          void emit({ type: 'text.delta', message_id: cp.messageId, delta });
        },
        setAnswer: async (text) => {
          answer = text;
          await emit({ type: 'message.snapshot', message_id: cp.messageId, parts: [{ type: 'text', text }] });
        },
        save: () => ctx.checkpoint(cp),
        ...(cp.mock && { mock: { models: mockModels() } }),
      });
      const withRuns: FlowRuntime = cp.savedFlowId
        ? {
            ...rt,
            recordDecision: undefined,
            recordNodeRun: async (nodeId, payload, output, meta) => {
              await flows.deps.store
                .recordNodeRun({ flow_id: cp.savedFlowId as string, node_id: nodeId, payload, output, meta })
                .catch(() => undefined);
            },
          }
        : { ...rt, recordDecision: undefined };
      try {
        const out = await executeFlow(cp.state, withRuns);
        if (out.kind === 'waiting') {
          // Nothing can pause in try mode; finish with what there is.
          await emit({
            type: 'warning',
            code: 'flow.try_paused',
            message: 'This flow asks a person or runs a tool; that part is skipped when trying.',
          });
        }
        void answer;
        await emit({ type: 'done', message_id: cp.messageId });
        return { kind: 'done' };
      } catch (err) {
        if (ctx.signal.aborted) return { kind: 'cancelled' };
        const e = err as { code?: string; title?: string; hint?: string; message?: string };
        await emit({
          type: 'error',
          code: e.code ?? 'flow.failed',
          title: e.title ?? 'The flow could not finish',
          hint: e.hint ?? e.message ?? 'Check the node that failed in the teamwork view.',
          attempts: [],
        });
        return {
          kind: 'failed',
          error: {
            code: e.code ?? 'flow.failed',
            title: e.title ?? 'The flow could not finish',
            hint: e.hint ?? '',
          },
        };
      }
    },
  };
}

/** What one off-the-record run of a flow produced. */
export interface FlowOnceResult {
  answer: string;
  cost_usd: number;
  ms: number;
  path: string[];
  steps: FlowState['steps'];
  /** A guard stopped it (steps, cost or time limit): the answer is what there was. */
  stopped?: { code: string; message: string };
  error?: { code: string; title: string; hint: string };
}

/**
 * Run a flow once, off the record: nothing is written to a thread, no route
 * decision is recorded and no run is created. Used to compare flows (a test
 * set, a flow running in the shadow of another). Context is built as for a
 * real send: the thread up to `headId`, then `text` as a new message.
 */
export async function runFlowOnce(
  flows: FlowsService,
  opts: {
    flow: Pick<Flow, 'id' | 'name' | 'version' | 'scope'> & FlowGraph;
    text: string;
    workspaceId: string;
    threadId?: string | null;
    headId?: string | null;
    notebookId?: string | null;
    mock?: boolean;
    signal: AbortSignal;
  },
): Promise<FlowOnceResult> {
  const { repo, gateway, registry } = flows.deps;
  const started = Date.now();
  const threadId = opts.threadId ?? null;
  const notebookId = opts.notebookId ?? null;
  const messageId = `once_${started.toString(36)}`;
  const all = threadId
    ? withVirtual(await repo.messages(threadId), opts.headId ?? null, opts.text, threadId)
    : withVirtual([], null, opts.text, 'once');
  const grounding = notebookId
    ? await flows
        .retrievePassages({ workspaceId: opts.workspaceId, notebookId, query: opts.text, k: 8 })
        .catch(() => '')
    : '';
  const state = tryState(opts.flow, undefined);
  let answer = '';
  const rt = makeTurnRuntime({
    flows,
    input: {
      text: opts.text,
      threadId,
      notebookId,
      notebookTitle: null,
      workspaceId: opts.workspaceId,
      messageId,
      userMessageId: TRY_USER_ID,
      hasAttachment: false,
      branchDepth: all.length,
    },
    signal: opts.signal,
    messages: async () => all,
    compaction: null,
    groundingBlock: grounding,
    memory: async (model) =>
      (await flows.deps.memory?.({ notebookId, model, query: opts.text }).catch(() => '')) ?? '',
    emit: async () => undefined,
    call: (chain, req, onDelta, o) => streamCall({ gateway, registry }, chain, req, opts.signal, onDelta, o),
    speak: (delta) => {
      answer += delta;
    },
    setAnswer: async (text) => {
      answer = text;
    },
    save: async () => undefined,
    ...(opts.mock && { mock: { models: mockModels() } }),
  });
  const quiet: FlowRuntime = {
    ...rt,
    recordDecision: undefined,
    recordNodeRun: undefined,
    routeHint: undefined,
  };
  const done = (extra: Partial<FlowOnceResult> = {}): FlowOnceResult => ({
    answer: state.answer ?? answer,
    cost_usd: Math.round(state.cost * 1e6) / 1e6,
    ms: Date.now() - started,
    path: state.path,
    steps: state.steps,
    ...(state.stopped && { stopped: state.stopped }),
    ...extra,
  });
  try {
    await executeFlow(state, quiet);
    return done();
  } catch (err) {
    const e = err as { code?: string; title?: string; hint?: string; message?: string };
    return done({
      error: {
        code: e.code ?? 'flow.failed',
        title: e.title ?? 'The flow could not finish',
        hint: e.hint ?? e.message ?? '',
      },
    });
  }
}
