/**
 * ------------------------------------------------------------------
 *  Title    |  Flow executor
 *  Ref      |  DESIGN.md §16.4, §16.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Answer one message by running a flow: each node in
 *           |  turn, as soon as everything leading to it has finished,
 *           |  side branches at the same time, every step streamed
 *           |  live and recorded on the answer.
 *  How      |  Dead-path elimination over the graph. A node runs when
 *           |  every incoming edge is settled (fired or dead) and at
 *           |  least one fired; routers, rules and fact-check nodes
 *           |  fire only the edges they choose. Managers and loops
 *           |  call their workers themselves. After each wave the
 *           |  state (outputs, settled edges, decisions, costs) is
 *           |  checkpointed, so a restart resumes where it stopped and
 *           |  never re-runs a finished node. Tool and Human nodes
 *           |  pause the run through the approval machinery.
 *  Note     |  The runtime (FlowRuntime) is the seam: the chat turn
 *           |  provides one that writes the answer; "Try a message"
 *           |  provides one that writes nothing.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import {
  AncileError,
  type ContextPolicy,
  type Flow,
  type FlowDecision,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowNodeOverrides,
  type FlowProvenance,
  type FlowStepRecord,
  FULL_CONTEXT,
  type ModelConfig,
  type ModelParams,
  type RuleCondition,
} from '@nvx/contracts';
import { z } from 'zod';
import type { ModelMessage, ModelRequest, ToolDef } from '../gateway/types';
import type { RunEventInput } from '../runs/events';
import { assemble, type ContextSources, type Upstream } from './context';
import { buildGraph, flowEdges, incomingFlowEdges } from './graph';

/* ---- The runtime a flow runs against ------------------------------------------ */

export interface ModelCallResult {
  text: string;
  reasoning: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Tools the model asked to call this round. */
  toolCalls?: { callId: string; tool: string; args: unknown }[];
}

export type Waitable<T> = { status: 'done'; value: T } | { status: 'waiting' };

/** A router asking whether its route is already known (Pro: a router learned from your choices). */
export interface RouteHintQuery {
  flowId: string;
  nodeId: string;
  text: string;
  labels: string[];
}

/** A confident answer to a RouteHintQuery: the router takes it without a model call. */
export interface RouteHint {
  label: string;
  confidence: number;
  reason: string;
}

export interface FlowRuntime {
  signal: AbortSignal;
  input: {
    text: string;
    threadId: string | null;
    notebookId: string | null;
    notebookTitle: string | null;
    workspaceId: string;
    messageId: string;
    hasAttachment: boolean;
    branchDepth: number;
  };
  model(id: string): ModelConfig | undefined;
  /** Whether a model can be called now (absent: assume it can). */
  status?(m: ModelConfig): 'ready' | 'needs_key' | 'disabled';
  /** Context for one node: conversation, passages, memory (per model for memory). */
  contextFor(model: ModelConfig | undefined): ContextSources;
  call(
    chain: ModelConfig[],
    req: ModelRequest,
    onDelta: (channel: 'text' | 'reasoning', delta: string) => void,
    opts: { waitForWakeS?: number },
  ): Promise<ModelCallResult>;
  /** Run a tool through the permission gate; `nodeId` tags its events. Idempotent per key. */
  tool?(
    key: string,
    tool: string,
    args: unknown,
    nodeId?: string,
  ): Promise<Waitable<{ ok: boolean; output: string }>>;
  /** The definitions of the named tools, as a model is offered them. */
  toolDefs?(names: string[]): ToolDef[];
  ask?(key: string, question: string, preview: string): Promise<Waitable<string>>;
  retrieve?(q: { query: string; k: number; sourceIds?: string[]; rerank: boolean }): Promise<string>;
  factcheck?(answer: string, verifier?: string): Promise<{ confidence: number | null; summary: string }>;
  loadFlow(id: string): Promise<Flow | undefined>;
  emit(e: RunEventInput): Promise<unknown>;
  /** Stream a delta into the visible answer. */
  speak(delta: string): void;
  /** Replace the visible answer (the final text differs from what was spoken). */
  setAnswer(text: string): Promise<void>;
  save(): Promise<void>;
  recordDecision?(d: FlowDecision & { scores?: Record<string, number> }): Promise<void>;
  recordNodeRun?(
    nodeId: string,
    payload: unknown,
    output: string,
    meta: Record<string, unknown>,
  ): Promise<void>;
  facts?: {
    monthSpendUsd?: () => Promise<number>;
    nodeAwake?: (nodeId: string) => Promise<boolean>;
  };
  /** A thread's node overrides (ThreadSettings.flow_overrides). */
  overrides?: FlowNodeOverrides;
  /** Use the offline models for every call (dry run). */
  mock?: { models: ModelConfig[] };
  now?: () => number;
  /** A route already known for this request; null to ask the router's model as usual. */
  routeHint?(q: RouteHintQuery): Promise<RouteHint | null>;
}

/* ---- State (lives in the run checkpoint) ------------------------------------------- */

interface ManagerState {
  round: number;
  log: { worker: string; task: string; output: string }[];
  /** Calls asked for this round, done so far. */
  pending: { worker: string; task: string }[];
  answer?: string;
}

type ToolCallRecord = NonNullable<FlowStepRecord['tool_calls']>[number];

interface ToolLoop {
  round: number;
  /** Assistant turns with their tool calls and results, appended to the payload each round. */
  extra: ModelMessage[];
  text: string;
  /** Calls asked for in the latest round, not yet settled. */
  pending: { key: string; callId: string; tool: string; args: unknown }[];
  records: ToolCallRecord[];
  done: boolean;
}

/** Rounds of tool calls one model node may make before it must answer. */
export const MAX_TOOL_ROUNDS = 8;

interface LoopState {
  i: number;
  last: string;
}

export interface FlowState {
  flow: { id: string; name: string; version: number; scope: Flow['scope']; graph: FlowGraph };
  startedAt: number;
  announced: boolean;
  outputs: Record<string, string>;
  status: Record<string, FlowStepRecord['status']>;
  /** Edge id → true (fired) or false (dead). */
  fired: Record<string, boolean>;
  decisions: FlowDecision[];
  steps: FlowStepRecord[];
  path: string[];
  cost: number;
  stepsRun: number;
  managers: Record<string, ManagerState>;
  loops: Record<string, LoopState>;
  subs: Record<string, FlowState>;
  /** A model node's rounds of tool calls, by its loop key (survives restarts). */
  toolLoops?: Record<string, ToolLoop>;
  /** Decisions to repeat (regenerate "same route"): node id → labels. */
  replay?: Record<string, string[]>;
  spoken: string;
  /** Node parameter changes for this run only (rerun a step with another model). */
  overrides?: FlowNodeOverrides;
  stopped?: { code: string; message: string };
  done: boolean;
  answer?: string;
  depth: number;
}

export function initialFlowState(
  flow: Pick<Flow, 'id' | 'name' | 'version' | 'scope'> & FlowGraph,
  opts: { replay?: Record<string, string[]>; depth?: number; now?: number } = {},
): FlowState {
  return {
    flow: {
      id: flow.id,
      name: flow.name,
      version: flow.version,
      scope: flow.scope,
      graph: { nodes: flow.nodes, edges: flow.edges, settings: flow.settings },
    },
    startedAt: opts.now ?? Date.now(),
    announced: false,
    outputs: {},
    status: {},
    fired: {},
    decisions: [],
    steps: [],
    path: [],
    cost: 0,
    stepsRun: 0,
    managers: {},
    loops: {},
    subs: {},
    ...(opts.replay && { replay: opts.replay }),
    spoken: '',
    done: false,
    depth: opts.depth ?? 0,
  };
}

export function provenanceOf(s: FlowState): FlowProvenance {
  return {
    flow_id: s.flow.id,
    name: s.flow.name,
    version: s.flow.version,
    scope: s.flow.scope,
    path: s.path,
    decisions: s.decisions,
    steps: s.steps,
    cost_usd: Math.round(s.cost * 1e6) / 1e6,
  };
}

/* ---- Errors ------------------------------------------------------------------------- */

export const flowInvalid = (message: string) =>
  new AncileError({
    code: 'flow.invalid',
    title: 'This flow cannot run as drawn',
    hint: message,
    status: 422,
    errorClass: 'permanent',
  });

const MAX_SUBFLOW_DEPTH = 3;

/* ---- Structured outputs (routers, managers, judges, loops) --------------------------- */

const RouteChoice = z.object({
  routes: z.array(z.string()).default([]),
  reason: z.string().default(''),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  scores: z.record(z.string(), z.coerce.number()).optional(),
});
const ManagerTurn = z.object({
  done: z.boolean().default(false),
  answer: z.string().default(''),
  calls: z.array(z.object({ worker: z.string(), task: z.string() })).default([]),
  reason: z.string().default(''),
});
const JudgeChoice = z.object({ best: z.coerce.number().int(), reason: z.string().default('') });
const LoopVerdict = z.object({ done: z.boolean(), reason: z.string().default('') });

const JSON_SYSTEM = 'Reply with one JSON object only. No prose, no code fence.';

function parseJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return undefined;
  }
}

/* ---- Small helpers ------------------------------------------------------------------- */

const labelOf = (n: FlowNode) => n.label ?? n.id;

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

function applyOverrides(n: FlowNode, o: FlowNodeOverrides | undefined): FlowNode {
  const patch = o?.[n.id];
  if (!patch) return n;
  return { ...n, params: { ...(n.params as object), ...patch } } as FlowNode;
}

function cacheKey(models: string[], req: ModelRequest): string {
  return createHash('sha256').update(JSON.stringify({ models, req })).digest('hex');
}

const callCache = new Map<string, { at: number; result: ModelCallResult }>();

function evalCondition(c: RuleCondition, facts: Record<string, unknown>): boolean {
  const v = facts[c.field];
  const target = c.value;
  switch (c.op) {
    case 'contains':
      return String(v ?? '')
        .toLowerCase()
        .includes(String(target).toLowerCase());
    case 'matches':
      try {
        return new RegExp(String(target), 'i').test(String(v ?? ''));
      } catch {
        return false;
      }
    case 'equals':
      return String(v) === String(target);
    case 'not_equals':
      return String(v) !== String(target);
    case 'gt':
      return Number(v) > Number(target);
    case 'lt':
      return Number(v) < Number(target);
    case 'in':
      return (Array.isArray(target) ? target : String(target).split(',')).map(String).includes(String(v));
  }
}

/** Very rough language guess: enough for rules like "language equals fr". */
function language(text: string): string {
  const t = ` ${text.toLowerCase()} `;
  const score = (words: string[]) => words.reduce((n, w) => n + (t.includes(` ${w} `) ? 1 : 0), 0);
  const langs: [string, string[]][] = [
    ['en', ['the', 'and', 'is', 'of', 'to', 'what', 'how']],
    ['fr', ['le', 'la', 'et', 'est', 'les', 'des', 'pour']],
    ['de', ['der', 'die', 'und', 'ist', 'nicht', 'das', 'mit']],
    ['es', ['el', 'la', 'y', 'es', 'los', 'para', 'que']],
  ];
  let best = 'en';
  let bestScore = 0;
  for (const [code, words] of langs) {
    const s = score(words);
    if (s > bestScore) {
      best = code;
      bestScore = s;
    }
  }
  return best;
}

/* ---- The executor ------------------------------------------------------------------ */

type NodeResult =
  | {
      kind: 'done';
      output: string;
      fire: 'all' | string[];
      status?: FlowStepRecord['status'];
      toolCalls?: ToolCallRecord[];
    }
  | { kind: 'waiting' };

export type FlowOutcome = { kind: 'done'; answer: string } | { kind: 'waiting' };

export async function executeFlow(state: FlowState, rt: FlowRuntime): Promise<FlowOutcome> {
  const now = rt.now ?? Date.now;
  const g = buildGraph(state.flow.graph);
  const settings = state.flow.graph.settings;
  if (!g.input || !g.output) throw flowInvalid('Add an Input and an Output node.');
  const prefix = state.depth ? `${state.flow.id}:` : '';
  const evId = (id: string) => `${prefix}${id}`;

  if (!state.announced && state.depth === 0) {
    state.announced = true;
    await rt.emit({
      type: 'flow.started',
      message_id: rt.input.messageId,
      flow_id: state.flow.id,
      name: state.flow.name,
      version: state.flow.version,
    });
  }

  // Who speaks into the visible answer: the nodes marked so, else the single
  // model node that feeds the Output directly.
  const speakers = new Set<string>();
  for (const n of g.nodes.values())
    if ((n.kind === 'model' || n.kind === 'manager') && n.params.speaks) speakers.add(n.id);
  if (!speakers.size) {
    const feeders = incomingFlowEdges(g, g.output.id).map((e) => g.nodes.get(e.from));
    if (feeders.length === 1 && feeders[0]?.kind === 'model') speakers.add(feeders[0].id);
  }
  if (state.depth > 0) speakers.clear();

  const speak = (delta: string) => {
    state.spoken += delta;
    rt.speak(delta);
  };

  const nodeOf = (id: string) =>
    applyOverrides(applyOverrides(g.nodes.get(id) as FlowNode, rt.overrides), state.overrides);

  /** Mark nodes that can no longer run as dead and their edges with them. */
  const propagateDead = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of g.nodes.values()) {
        if (state.status[n.id] || g.workers.has(n.id) || n.id === g.input?.id) continue;
        const inc = incomingFlowEdges(g, n.id);
        if (!inc.length) continue;
        if (inc.every((e) => state.fired[e.id] === false)) {
          state.status[n.id] = 'skipped';
          for (const e of flowEdges(g, n.id)) state.fired[e.id] = false;
          changed = true;
        }
      }
    }
  };

  const readyNodes = (): FlowNode[] => {
    const out: FlowNode[] = [];
    for (const n of g.nodes.values()) {
      if (state.status[n.id] || g.workers.has(n.id)) continue;
      if (n.id === g.input?.id) {
        out.push(n);
        continue;
      }
      const inc = incomingFlowEdges(g, n.id);
      if (!inc.length) continue; // unreachable: never runs
      if (inc.every((e) => state.fired[e.id] !== undefined) && inc.some((e) => state.fired[e.id]))
        out.push(n);
    }
    return out;
  };

  /** Outputs that flowed into a node along fired edges, in edge order. */
  const upstreamOf = (id: string): Upstream[] =>
    incomingFlowEdges(g, id)
      .filter((e) => state.fired[e.id] && state.outputs[e.from] !== undefined)
      .map((e) => {
        const from = g.nodes.get(e.from) as FlowNode;
        return { node: from.id, label: labelOf(from), text: state.outputs[e.from] as string };
      })
      .filter((u) => (g.nodes.get(u.node)?.kind ?? '') !== 'input');

  const allOutputs = (): Upstream[] =>
    state.path
      .map((id) => g.nodes.get(id))
      .filter((n): n is FlowNode => !!n && n.kind !== 'input' && n.kind !== 'output')
      .filter((n) => state.outputs[n.id] !== undefined)
      .map((n) => ({ node: n.id, label: labelOf(n), text: state.outputs[n.id] as string }));

  /** The policy for a node reached by `edge`: the edge's own, a Context node's, or the default. */
  const policyFor = (id: string, edge?: FlowEdge): ContextPolicy => {
    if (edge?.context) return edge.context;
    for (const e of incomingFlowEdges(g, id)) {
      if (!state.fired[e.id]) continue;
      if (e.context) return e.context;
      const from = g.nodes.get(e.from);
      if (from?.kind === 'context') return from.params;
    }
    return FULL_CONTEXT;
  };

  const vars = (): Record<string, string> => ({
    input: rt.input.text,
    notebook: rt.input.notebookTitle ?? '',
    date: new Date(now()).toISOString().slice(0, 10),
    ...state.outputs,
  });

  const chainFor = (p: { model: string; fallbacks?: string[] }): ModelConfig[] => {
    if (rt.mock) return rt.mock.models;
    const ids = [p.model, ...(p.fallbacks ?? [])];
    const known = ids.map((id) => rt.model(id)).filter((m): m is ModelConfig => !!m);
    if (!known.length)
      throw new AncileError({
        code: 'flow.model_unknown',
        title: `There is no model called ${p.model}`,
        hint: 'Open the flow and pick a model this workspace has.',
        status: 422,
        errorClass: 'permanent',
      });
    // A model with no key would only fail with the provider's 401: skip it,
    // and when nothing is left, say which key is missing.
    const models = known.filter((m) => (rt.status?.(m) ?? 'ready') === 'ready');
    if (!models.length) {
      const first = known[0] as ModelConfig;
      const off = rt.status?.(first) === 'disabled';
      throw new AncileError({
        code: 'flow.model_unready',
        title: off ? `${first.display_name} is switched off` : `${first.display_name} needs its key`,
        hint: off
          ? 'Switch it on in Settings → Models, or pick another model for this step in the flow.'
          : 'Add the key in Settings → Models, or pick another model for this step in the flow.',
        status: 422,
        errorClass: 'permanent',
      });
    }
    return models;
  };

  /** One model call for a node, streamed live and costed. */
  const callModel = async (
    node: FlowNode,
    params: Pick<ModelParams, 'model' | 'fallbacks' | 'temperature' | 'max_output' | 'cache_s'> & {
      wait_for_wake_s?: number;
    },
    req: ModelRequest,
    opts: { speak: boolean; quiet?: boolean },
  ): Promise<ModelCallResult & { cached: boolean }> => {
    const chain = chainFor(params);
    const full: ModelRequest = {
      ...req,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.max_output !== undefined && { maxOutputTokens: params.max_output }),
    };
    const key =
      params.cache_s && !full.tools?.length
        ? cacheKey(
            chain.map((m) => m.id),
            full,
          )
        : null;
    const hit = key ? callCache.get(key) : undefined;
    if (hit && key && now() - hit.at < (params.cache_s as number) * 1000) {
      if (opts.speak) speak(hit.result.text);
      return { ...hit.result, costUsd: 0, cached: true };
    }
    let buf = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let channel: 'text' | 'reasoning' = 'text';
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!buf) return;
      const delta = buf;
      buf = '';
      void rt.emit({
        type: 'flow.node.delta',
        message_id: rt.input.messageId,
        node_id: evId(node.id),
        channel,
        delta,
      });
    };
    const result = await rt.call(
      chain,
      full,
      (ch, delta) => {
        if (opts.speak && ch === 'text') speak(delta);
        if (opts.quiet) return;
        if (ch !== channel) flush();
        channel = ch;
        buf += delta;
        if (buf.length > 400) flush();
        else timer ??= setTimeout(flush, 60);
      },
      { ...(params.wait_for_wake_s !== undefined && { waitForWakeS: params.wait_for_wake_s }) },
    );
    flush();
    if (key) callCache.set(key, { at: now(), result });
    return { ...result, cached: false };
  };

  /** A structured call (router, manager, judge, loop): JSON back, schema-checked. */
  const structured = async <T>(
    node: FlowNode,
    model: string,
    prompt: string,
    schema: z.ZodType<T>,
  ): Promise<{ value: T; call: ModelCallResult }> => {
    const req: ModelRequest = {
      system: JSON_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    };
    const r = await callModel(node, { model, fallbacks: [] }, req, { speak: false });
    const parsed = schema.safeParse(parseJson(r.text));
    if (!parsed.success)
      throw new AncileError({
        code: 'flow.bad_output',
        title: `${labelOf(node)} did not answer in the expected shape`,
        hint: 'Try a stronger model for this node, or tighten its instructions.',
        status: 502,
        errorClass: 'transient',
      });
    return { value: parsed.data, call: r };
  };

  let usage = { tokensIn: 0, tokensOut: 0, cost: 0, modelId: null as string | null };
  const account = (r: ModelCallResult) => {
    usage.tokensIn += r.tokensIn;
    usage.tokensOut += r.tokensOut;
    usage.cost += r.costUsd;
    usage.modelId ??= r.modelId;
    state.cost += r.costUsd;
  };

  /**
   * Run one model-like node (also used for workers and loop bodies). With tools
   * listed, the model may call them: each call goes through the permission gate
   * on its real arguments (pausing for you when it must), the results go back
   * to the model, and it answers within MAX_TOOL_ROUNDS rounds. Every round and
   * call is checkpointed under `loopKey`, so a restart never repeats a call.
   */
  const runModelNode = async (
    n: Extract<FlowNode, { kind: 'model' }>,
    via: { edge?: FlowEdge; task?: string; upstream?: Upstream[] },
    loopKey: string = n.id,
  ): Promise<
    { output: string; status: FlowStepRecord['status']; toolCalls?: ToolCallRecord[] } | { waiting: true }
  > => {
    if (n.params.pinned_output !== undefined) return { output: n.params.pinned_output, status: 'pinned' };
    const model = rt.mock ? rt.mock.models[0] : rt.model(n.params.model);
    const policy = policyFor(n.id, via.edge);
    const upstream = via.upstream ?? (policy.upstream === 'all' ? allOutputs() : upstreamOf(n.id));
    const payload = await assemble({
      policy,
      role: n.params.role,
      input: rt.input.text,
      upstream,
      ...(via.task !== undefined && { task: via.task }),
      src: rt.contextFor(model),
    });
    const allowed = new Set(n.params.tools);
    const defs = allowed.size && rt.toolDefs ? rt.toolDefs([...allowed]) : [];
    const speaksHere = speakers.has(n.id) && !via.task;

    state.toolLoops ??= {};
    const loops = state.toolLoops;
    loops[loopKey] ??= { round: 0, extra: [], text: '', pending: [], records: [], done: false };
    const tl = loops[loopKey] as ToolLoop;
    let cached = false;

    for (;;) {
      // Settle the calls the last round asked for (a restart lands here too).
      while (tl.pending.length) {
        const c = tl.pending[0] as ToolLoop['pending'][number];
        let ok = false;
        let output: string;
        let refused = false;
        if (!allowed.has(c.tool)) {
          output = `${c.tool} is not one of this step's tools, so it was not run. Answer without it, or use ${[...allowed].join(', ') || 'no tools'}.`;
          refused = true;
          await rt.emit({
            type: 'tool.result',
            call_id: c.callId,
            ok: false,
            preview: `Refused: ${c.tool} is not allowed here`,
            node_id: evId(n.id),
          });
        } else if (!rt.tool) {
          output = 'Tools cannot run here (try mode).';
          refused = true;
        } else {
          const r = await rt.tool(c.key, c.tool, c.args, evId(n.id));
          if (r.status === 'waiting') return { waiting: true };
          ok = r.value.ok;
          output = r.value.output;
          refused = /^Declined/.test(output);
        }
        tl.records.push({
          call_id: c.callId,
          tool: c.tool,
          args_preview: c.args,
          ok,
          output: output.slice(0, 2_000),
          ...(refused && { refused: true }),
        });
        tl.extra.at(-1)?.parts?.push({ type: 'tool_result', call_id: c.callId, ok, result: output });
        tl.pending.shift();
        await rt.save();
      }
      if (tl.done) break;
      if (tl.round >= MAX_TOOL_ROUNDS) {
        const note = `\n\n_Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls._`;
        tl.text += note;
        if (speaksHere) speak(note);
        tl.done = true;
        break;
      }
      tl.round += 1;
      const r = await callModel(
        n,
        n.params,
        {
          system: payload.system,
          messages: [...payload.messages, ...tl.extra],
          ...(defs.length && { tools: defs }),
        },
        { speak: speaksHere },
      );
      account(r);
      cached = r.cached;
      tl.text += r.text;
      const calls = r.toolCalls ?? [];
      if (!calls.length) {
        tl.done = true;
        break;
      }
      tl.extra.push({
        role: 'assistant',
        content: r.text,
        parts: [
          ...(r.text ? [{ type: 'text' as const, text: r.text }] : []),
          ...calls.map((c) => ({
            type: 'tool_call' as const,
            call_id: c.callId,
            tool: c.tool,
            args: c.args,
          })),
        ],
      });
      tl.pending = calls.map((c, i) => ({
        key: `${loopKey}:${tl.round}:${i}`,
        callId: c.callId,
        tool: c.tool,
        args: c.args,
      }));
      await rt.save();
    }

    await rt.recordNodeRun?.(n.id, payload, tl.text, {
      model_id: usage.modelId,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      cost_usd: usage.cost,
      trimmed: payload.trimmed,
      ...(tl.records.length && { tool_calls: tl.records }),
    });
    const out = { output: tl.text, status: (cached ? 'cached' : 'done') as FlowStepRecord['status'] };
    return tl.records.length ? { ...out, toolCalls: tl.records } : out;
  };

  /** Call a manager's or loop's worker by node id. */
  const runWorker = async (
    workerId: string,
    edge: FlowEdge,
    task: string,
    stepKey: string,
  ): Promise<{ output: string } | { waiting: true }> => {
    const w = nodeOf(workerId);
    const started = now();
    await rt.emit({
      type: 'flow.node.started',
      message_id: rt.input.messageId,
      node_id: evId(w.id),
      kind: w.kind,
      label: w.label ?? null,
      model_id: w.kind === 'model' || w.kind === 'manager' ? w.params.model : null,
      from: [edge.from],
    });
    const before = { ...usage };
    usage = { tokensIn: 0, tokensOut: 0, cost: 0, modelId: null };
    let output = '';
    let status: FlowStepRecord['status'] = 'done';
    let toolCalls: ToolCallRecord[] | undefined;
    try {
      if (w.kind === 'model') {
        const r = await runModelNode(w, { edge, task }, stepKey);
        if ('waiting' in r) {
          usage = before;
          return { waiting: true };
        }
        output = r.output;
        status = r.status;
        toolCalls = r.toolCalls;
      } else if (w.kind === 'tool') {
        const res = await runTool(w, task, stepKey);
        if (res.kind === 'waiting') {
          usage = before;
          return { waiting: true };
        }
        output = res.output;
      } else if (w.kind === 'human') {
        const res = await runHuman(w, task, stepKey);
        if (res.kind === 'waiting') {
          usage = before;
          return { waiting: true };
        }
        output = res.output;
      } else if (w.kind === 'subflow') {
        const res = await runSubflow(w, task);
        if (res.kind === 'waiting') {
          usage = before;
          return { waiting: true };
        }
        output = res.output;
      } else if (w.kind === 'manager') {
        // A manager as a worker answers its task with its own model, without delegating.
        const r = await runModelNode(
          { ...w, kind: 'model', params: w.params } as Extract<FlowNode, { kind: 'model' }>,
          {
            edge,
            task,
          },
          stepKey,
        );
        if ('waiting' in r) {
          usage = before;
          return { waiting: true };
        }
        output = r.output;
        toolCalls = r.toolCalls;
      }
    } catch (err) {
      const mine = { ...usage };
      usage = {
        tokensIn: before.tokensIn + mine.tokensIn,
        tokensOut: before.tokensOut + mine.tokensOut,
        cost: before.cost + mine.cost,
        modelId: before.modelId ?? mine.modelId,
      };
      await recordStep(w, started, '', 'failed', mine, (err as Error).message);
      throw err;
    }
    const mine = { ...usage };
    usage = {
      tokensIn: before.tokensIn + mine.tokensIn,
      tokensOut: before.tokensOut + mine.tokensOut,
      cost: before.cost + mine.cost,
      modelId: before.modelId ?? mine.modelId,
    };
    await recordStep(w, started, output, status, mine, undefined, toolCalls);
    return { output };
  };

  const recordStep = async (
    n: FlowNode,
    started: number,
    output: string,
    status: FlowStepRecord['status'],
    u: { tokensIn: number; tokensOut: number; cost: number; modelId: string | null },
    error?: string,
    toolCalls?: ToolCallRecord[],
  ) => {
    const ms = now() - started;
    state.steps.push({
      node_id: evId(n.id),
      kind: n.kind,
      label: n.label ?? null,
      model_id: u.modelId,
      status,
      started_at: new Date(started).toISOString(),
      ms,
      tokens_in: u.tokensIn,
      tokens_out: u.tokensOut,
      cost_usd: Math.round(u.cost * 1e6) / 1e6,
      output: output.slice(0, 20_000),
      ...(error && { error }),
      ...(toolCalls?.length && { tool_calls: toolCalls }),
    });
    state.stepsRun += 1;
    await rt.emit({
      type: 'flow.node.finished',
      message_id: rt.input.messageId,
      node_id: evId(n.id),
      status,
      ms,
      tokens_in: u.tokensIn,
      tokens_out: u.tokensOut,
      cost_usd: Math.round(u.cost * 1e6) / 1e6,
      ...(error && { error }),
    });
  };

  const decide = async (
    n: FlowNode,
    chose: string[],
    reason: string,
    confidence: number | null,
    scores?: Record<string, number>,
  ) => {
    const d: FlowDecision = { node_id: evId(n.id), chose, reason, confidence };
    state.decisions.push(d);
    await rt.emit({ type: 'flow.decision', message_id: rt.input.messageId, ...d });
    if (state.depth === 0) await rt.recordDecision?.({ ...d, node_id: n.id, ...(scores && { scores }) });
  };

  const runTool = async (
    n: Extract<FlowNode, { kind: 'tool' }>,
    input: string,
    key: string,
  ): Promise<{ kind: 'done'; output: string } | { kind: 'waiting' }> => {
    if (!rt.tool) return { kind: 'done', output: 'Tools cannot run here (try mode).' };
    let args: unknown;
    const text = render(n.params.args, { ...vars(), input: JSON.stringify(input).slice(1, -1) });
    try {
      args = JSON.parse(text);
    } catch {
      throw flowInvalid(`The arguments for ${labelOf(n)} are not valid JSON once filled in.`);
    }
    const r = await rt.tool(key, n.params.tool, args, evId(n.id));
    if (r.status === 'waiting') return { kind: 'waiting' };
    return { kind: 'done', output: r.value.ok ? r.value.output : `The tool failed: ${r.value.output}` };
  };

  const runHuman = async (
    n: Extract<FlowNode, { kind: 'human' }>,
    upstreamText: string,
    key: string,
  ): Promise<{ kind: 'done'; output: string } | { kind: 'waiting' }> => {
    if (!rt.ask) return { kind: 'done', output: '(No one to ask in try mode.)' };
    const r = await rt.ask(
      key,
      render(n.params.question, vars()),
      n.params.show_upstream ? upstreamText : '',
    );
    if (r.status === 'waiting') return { kind: 'waiting' };
    return { kind: 'done', output: r.value };
  };

  const runSubflow = async (
    n: Extract<FlowNode, { kind: 'subflow' }>,
    input: string,
  ): Promise<{ kind: 'done'; output: string } | { kind: 'waiting' }> => {
    if (state.depth + 1 > MAX_SUBFLOW_DEPTH) throw flowInvalid('Subflows can be nested three deep at most.');
    let sub = state.subs[n.id];
    if (!sub) {
      const f = await rt.loadFlow(n.params.flow_id);
      if (!f) throw flowInvalid(`${labelOf(n)} runs a flow that no longer exists.`);
      sub = initialFlowState({ ...f, id: `${n.id}` }, { depth: state.depth + 1, now: now() });
      state.subs[n.id] = sub;
    }
    const inner: FlowRuntime = {
      ...rt,
      input: { ...rt.input, text: input || rt.input.text },
      speak: () => undefined,
      setAnswer: async () => undefined,
      save: rt.save,
      overrides: undefined,
    };
    const r = await executeFlow(sub, inner);
    state.cost += sub.cost;
    if (r.kind === 'waiting') return { kind: 'waiting' };
    return { kind: 'done', output: r.answer };
  };

  /* ---- Each kind ---------------------------------------------------------------- */

  const runNode = async (n: FlowNode): Promise<NodeResult> => {
    const upstream = upstreamOf(n.id);
    const upText = upstream.map((u) => u.text).join('\n\n');
    const replay = state.replay?.[n.id];

    if (n.disabled && n.kind !== 'input' && n.kind !== 'output')
      return { kind: 'done', output: upText || rt.input.text, fire: 'all', status: 'skipped' };

    switch (n.kind) {
      case 'input':
        return { kind: 'done', output: rt.input.text, fire: 'all' };

      case 'output': {
        const text = n.params.template
          ? render(n.params.template, vars())
          : upstream
              .map((u) => u.text.trim())
              .filter(Boolean)
              .join('\n\n');
        return { kind: 'done', output: text, fire: 'all' };
      }

      case 'model': {
        const r = await runModelNode(n, {});
        if ('waiting' in r) return { kind: 'waiting' };
        return {
          kind: 'done',
          output: r.output,
          fire: 'all',
          status: r.status,
          ...(r.toolCalls && { toolCalls: r.toolCalls }),
        };
      }

      case 'router': {
        const labels = n.params.routes.map((r) => r.label);
        if (replay) {
          await decide(n, replay, 'The same route as the answer this one replaces.', null);
          return { kind: 'done', output: replay.join(', '), fire: replay };
        }
        if (!rt.mock && rt.routeHint) {
          const hint = await rt
            .routeHint({ flowId: state.flow.id, nodeId: n.id, text: rt.input.text, labels })
            .catch(() => null);
          if (hint && labels.includes(hint.label)) {
            await decide(n, [hint.label], hint.reason, hint.confidence);
            return { kind: 'done', output: hint.label, fire: [hint.label] };
          }
        }
        const model = rt.mock ? (rt.mock.models[0] as ModelConfig) : rt.model(n.params.model);
        const src = rt.contextFor(model);
        const recent = await src.conversation({ mode: 'last_n', n: 6 }).catch(() => [] as ModelMessage[]);
        const prompt = [
          n.params.instructions || 'Choose which route should handle the request.',
          '',
          'Routes:',
          ...n.params.routes.map((r) => `- ${r.label}: ${r.when || '(no description)'}`),
          '',
          recent.length
            ? `Recent conversation:\n${recent.map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join('\n')}\n`
            : '',
          rt.input.notebookTitle ? `Notebook: ${rt.input.notebookTitle}\n` : '',
          upText ? `Earlier steps:\n${upText.slice(0, 4_000)}\n` : '',
          'Request:',
          rt.input.text,
          '',
          `Choose ${n.params.multi ? 'one or more routes' : 'exactly one route'} by label. Give your reason in one sentence, a confidence from 0 to 1, and a score for every route.`,
          'Return JSON matching RouteChoice: { "routes": [label], "reason": string, "confidence": number, "scores": { label: number } }',
        ]
          .filter((l) => l !== '')
          .join('\n');
        const { value, call } = await structured(n, n.params.model, prompt, RouteChoice);
        account(call);
        let chose = value.routes.filter((l) => labels.includes(l));
        if (!n.params.multi) chose = chose.slice(0, 1);
        let reason = value.reason || 'No reason given.';
        if (!chose.length || value.confidence < n.params.min_confidence) {
          const fallback = n.params.default_route ?? labels[0];
          if (fallback) {
            reason = chose.length
              ? `Not sure enough (${Math.round(value.confidence * 100)}%), so the default route. ${reason}`
              : `No clear route, so the default. ${reason}`;
            chose = [fallback];
          }
        }
        await decide(n, chose, reason, value.confidence, value.scores);
        return { kind: 'done', output: chose.join(', '), fire: chose };
      }

      case 'rule': {
        if (replay) {
          await decide(n, replay, 'The same route as the answer this one replaces.', null);
          return { kind: 'done', output: replay.join(', '), fire: replay };
        }
        const facts: Record<string, unknown> = {
          text: rt.input.text,
          notebook: rt.input.notebookId ?? '',
          mentions_model: /(^|\s)@[\w./-]+/.test(rt.input.text),
          has_attachment: rt.input.hasAttachment,
          length: rt.input.text.length,
          hour: new Date(now()).getHours(),
          budget_left_usd: Math.max(0, settings.cost_cap_usd - state.cost),
          branch_depth: rt.input.branchDepth,
          language: language(rt.input.text),
        };
        const needs = (f: string) => n.params.rules.some((r) => r.all.some((c) => c.field === f));
        if (needs('month_spend_usd')) facts.month_spend_usd = (await rt.facts?.monthSpendUsd?.()) ?? 0;
        for (const r of n.params.rules)
          for (const c of r.all)
            if (c.field === 'node_awake')
              facts.node_awake = (await rt.facts?.nodeAwake?.(String(c.value))) ?? false;
        let hit: string | undefined;
        for (const r of n.params.rules) {
          const ok = r.all.every((c) => {
            if (c.field === 'node_awake')
              return facts.node_awake === true || String(facts.node_awake) === 'true';
            return evalCondition(c, facts);
          });
          if (ok) {
            hit = r.label;
            break;
          }
        }
        const chose = hit ?? n.params.default_route;
        const reason = hit ? `Matched the rule for "${hit}".` : 'No rule matched, so the default route.';
        const labels = chose ? [chose] : [];
        await decide(n, labels, reason, hit ? 1 : null);
        return { kind: 'done', output: labels.join(', '), fire: labels };
      }

      case 'manager': {
        state.managers[n.id] ??= { round: 0, log: [], pending: [] };
        const ms = state.managers[n.id] as ManagerState;
        const workers = (g.out.get(n.id) ?? []).filter((e) => g.workerEdges.has(e.id));
        const workerName = (e: FlowEdge) => e.label ?? labelOf(g.nodes.get(e.to) as FlowNode);
        const byName = new Map(workers.map((e) => [workerName(e).toLowerCase(), e] as const));
        for (;;) {
          // Finish this round's calls first (they may have paused).
          while (ms.pending.length) {
            const call = ms.pending[0] as { worker: string; task: string };
            const e = byName.get(call.worker.toLowerCase());
            if (!e) {
              ms.log.push({
                worker: call.worker,
                task: call.task,
                output: `There is no worker called ${call.worker}.`,
              });
              ms.pending.shift();
              continue;
            }
            const res = await runWorker(e.to, e, call.task, `${n.id}:${ms.round}:${ms.log.length}`);
            if ('waiting' in res) return { kind: 'waiting' };
            ms.log.push({ worker: call.worker, task: call.task, output: res.output });
            ms.pending.shift();
            await rt.save();
          }
          if (ms.answer !== undefined) break;
          if (ms.round >= n.params.max_rounds) {
            // Out of rounds: answer from what the workers produced.
            ms.answer = ms.log.at(-1)?.output ?? '';
            break;
          }
          ms.round += 1;
          const prompt = [
            n.params.instructions ||
              'You manage a small team. Plan, delegate to your workers, check their work, then answer.',
            n.params.role ? `\nYour role: ${n.params.role}` : '',
            '',
            'Workers:',
            ...workers.map((e) => {
              const w = g.nodes.get(e.to) as FlowNode;
              const role = w.kind === 'model' || w.kind === 'manager' ? w.params.role.split('\n')[0] : w.kind;
              return `- ${workerName(e)}: ${role || 'a general model'}`;
            }),
            '',
            'Request:',
            rt.input.text,
            upText ? `\nEarlier steps:\n${upText.slice(0, 6_000)}` : '',
            ms.log.length
              ? `\nResults so far:\n${ms.log.map((l, i) => `[${i + 1}] ${l.worker} (asked: ${l.task.slice(0, 200)}):\n${l.output.slice(0, 6_000)}`).join('\n\n')}`
              : '\nResults so far: none yet.',
            `\nRound ${ms.round} of ${n.params.max_rounds}. Either ask workers for more (calls), or finish with the final answer for the user (done: true, answer).`,
            'Return JSON matching ManagerTurn: { "done": boolean, "answer": string, "calls": [{ "worker": string, "task": string }], "reason": string }',
          ]
            .filter((l) => l !== '')
            .join('\n');
          const { value, call } = await structured(n, n.params.model, prompt, ManagerTurn);
          account(call);
          if (value.calls.length)
            await decide(
              n,
              value.calls.map((c) => c.worker),
              value.reason || `Round ${ms.round}: asked ${value.calls.map((c) => c.worker).join(', ')}.`,
              null,
            );
          if (value.done || !value.calls.length) {
            ms.answer = value.answer || ms.log.at(-1)?.output || '';
            if (speakers.has(n.id) && ms.answer) speak(ms.answer);
            break;
          }
          ms.pending = value.calls.slice(0, 6);
          await rt.save();
        }
        return { kind: 'done', output: ms.answer ?? '', fire: 'all' };
      }

      case 'parallel':
      case 'context':
        return { kind: 'done', output: upText || rt.input.text, fire: 'all' };

      case 'join': {
        if (upstream.length <= 1 || n.params.mode === 'all') {
          const text =
            upstream.length <= 1
              ? (upstream[0]?.text ?? '')
              : upstream.map((u) => `### ${u.label}\n${u.text.trim()}`).join('\n\n');
          return { kind: 'done', output: text, fire: 'all' };
        }
        if (n.params.mode === 'first') return { kind: 'done', output: upstream[0]?.text ?? '', fire: 'all' };
        if (n.params.mode === 'vote') {
          const counts = new Map<string, number>();
          for (const u of upstream) {
            const k = u.text.trim().toLowerCase().replace(/\s+/g, ' ');
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
          const [bestKey] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [''];
          const winner =
            upstream.find((u) => u.text.trim().toLowerCase().replace(/\s+/g, ' ') === bestKey) ?? upstream[0];
          await decide(n, [winner?.label ?? ''], 'The answer most branches agreed on.', null);
          return { kind: 'done', output: winner?.text ?? '', fire: 'all' };
        }
        const prompt = [
          n.params.judge_instructions || 'Pick the best answer to the request.',
          '',
          'Request:',
          rt.input.text,
          '',
          'Candidates:',
          ...upstream.map((u, i) => `[${i + 1}] (${u.label})\n${u.text.slice(0, 8_000)}`),
          '',
          'Return JSON matching JudgeChoice: { "best": number (1-based), "reason": string }',
        ].join('\n');
        const { value, call } = await structured(n, n.params.judge_model as string, prompt, JudgeChoice);
        account(call);
        const winner = upstream[Math.min(Math.max(value.best, 1), upstream.length) - 1] as Upstream;
        await decide(n, [winner.label], value.reason || 'The judge preferred it.', null);
        return { kind: 'done', output: winner.text, fire: 'all' };
      }

      case 'tool': {
        const r = await runTool(n, upText || rt.input.text, `${n.id}:0`);
        if (r.kind === 'waiting') return { kind: 'waiting' };
        return { kind: 'done', output: r.output, fire: 'all' };
      }

      case 'template':
        return { kind: 'done', output: render(n.params.template, vars()), fire: 'all' };

      case 'human': {
        const r = await runHuman(n, upText, `${n.id}:0`);
        if (r.kind === 'waiting') return { kind: 'waiting' };
        return { kind: 'done', output: r.output, fire: 'all' };
      }

      case 'subflow': {
        const r = await runSubflow(n, upText || rt.input.text);
        if (r.kind === 'waiting') return { kind: 'waiting' };
        return { kind: 'done', output: r.output, fire: 'all' };
      }

      case 'retrieve': {
        if (!rt.retrieve) return { kind: 'done', output: '', fire: 'all' };
        const query = render(n.params.query, vars()).slice(0, 4_000) || rt.input.text;
        const out = await rt.retrieve({
          query,
          k: n.params.k,
          ...(n.params.source_ids && { sourceIds: n.params.source_ids }),
          rerank: n.params.rerank,
        });
        return { kind: 'done', output: out, fire: 'all' };
      }

      case 'factcheck': {
        const answer = upText;
        const labels = (g.out.get(n.id) ?? []).map((e) => e.label);
        const hasUnsure = labels.includes('unsure');
        if (replay) {
          await decide(n, replay, 'The same route as the answer this one replaces.', null);
          return { kind: 'done', output: answer, fire: replay };
        }
        const res = rt.factcheck
          ? await rt.factcheck(answer, n.params.verifier)
          : { confidence: null, summary: 'Fact-checking is not available here.' };
        const unsure = res.confidence !== null && res.confidence < n.params.min_confidence;
        const chose = unsure && hasUnsure ? ['unsure'] : ['ok'];
        await decide(
          n,
          chose,
          res.confidence === null
            ? `Nothing could be checked. ${res.summary}`
            : `Confidence ${Math.round(res.confidence * 100)}% (threshold ${Math.round(n.params.min_confidence * 100)}%). ${res.summary}`,
          res.confidence,
        );
        const caveat =
          unsure && n.params.caveat
            ? `\n\n_Not fully supported by your sources (confidence ${Math.round((res.confidence ?? 0) * 100)}%). ${res.summary}_`
            : '';
        return { kind: 'done', output: answer + caveat, fire: chose };
      }

      case 'loop': {
        const body = (g.out.get(n.id) ?? []).find((e) => e.label === 'body');
        if (!body) throw flowInvalid(`${labelOf(n)} has nothing labelled "body" to repeat.`);
        state.loops[n.id] ??= { i: 0, last: upText || rt.input.text };
        const ls = state.loops[n.id] as LoopState;
        while (ls.i < n.params.max_iterations) {
          const task =
            ls.i === 0
              ? upText || rt.input.text
              : `Improve this so that: ${n.params.until}\n\nCurrent version:\n${ls.last}`;
          const res = await runWorker(body.to, body, task, `${n.id}:${ls.i}`);
          if ('waiting' in res) return { kind: 'waiting' };
          ls.last = res.output;
          ls.i += 1;
          await rt.save();
          if (!n.params.until_model) continue;
          const prompt = [
            `Goal: ${n.params.until}`,
            '',
            'Request:',
            rt.input.text,
            '',
            `Iteration: ${ls.i}`,
            'Current version:',
            ls.last.slice(0, 10_000),
            '',
            'Is the goal met? Return JSON matching LoopVerdict: { "done": boolean, "reason": string }',
          ].join('\n');
          const { value, call } = await structured(n, n.params.until_model, prompt, LoopVerdict);
          account(call);
          await decide(
            n,
            [value.done ? 'done' : 'again'],
            value.reason || (value.done ? 'Good enough.' : 'Not there yet.'),
            null,
          );
          if (value.done) break;
        }
        return { kind: 'done', output: ls.last, fire: 'all' };
      }

      case 'note':
      case 'group':
        return { kind: 'done', output: '', fire: 'all' };
    }
  };

  /* ---- The schedule -------------------------------------------------------------- */

  propagateDead();
  for (;;) {
    if (rt.signal.aborted) throw rt.signal.reason ?? new Error('aborted');
    const ready = readyNodes();
    if (!ready.length) break;

    // Guards.
    if (state.stepsRun >= settings.max_steps)
      state.stopped = { code: 'flow.steps', message: `It reached its limit of ${settings.max_steps} steps.` };
    else if (state.cost >= settings.cost_cap_usd && ready.some((n) => n.kind !== 'output'))
      state.stopped = {
        code: 'flow.budget',
        message: `It reached its cost cap of $${settings.cost_cap_usd.toFixed(2)} for one message.`,
      };
    else if (now() - state.startedAt > settings.timeout_s * 1000)
      state.stopped = {
        code: 'flow.timeout',
        message: `It ran for more than ${settings.timeout_s} seconds.`,
      };
    if (state.stopped) break;

    const results = await Promise.all(
      ready.map(async (n0) => {
        const n = nodeOf(n0.id);
        const started = now();
        const resumed =
          !!state.managers[n.id] || !!state.loops[n.id] || !!state.subs[n.id] || !!state.toolLoops?.[n.id];
        if (!resumed && n.kind !== 'input')
          await rt.emit({
            type: 'flow.node.started',
            message_id: rt.input.messageId,
            node_id: evId(n.id),
            kind: n.kind,
            label: n.label ?? null,
            model_id:
              n.kind === 'model' || n.kind === 'manager' || n.kind === 'router'
                ? rt.mock
                  ? (rt.mock.models[0]?.id ?? null)
                  : n.params.model
                : null,
            from: incomingFlowEdges(g, n.id)
              .filter((e) => state.fired[e.id])
              .map((e) => evId(e.from)),
          });
        usage = { tokensIn: 0, tokensOut: 0, cost: 0, modelId: null };
        try {
          const r = await runNode(n);
          return { n, r, started, u: { ...usage } };
        } catch (err) {
          if (rt.signal.aborted) throw err;
          await recordStep(n, started, '', 'failed', { ...usage }, (err as Error).message);
          throw err;
        }
      }),
    );

    let waiting = false;
    for (const { n, r, started, u } of results) {
      if (r.kind === 'waiting') {
        waiting = true;
        continue;
      }
      state.outputs[n.id] = r.output;
      state.status[n.id] = r.status ?? 'done';
      state.path.push(n.id);
      if (n.kind !== 'input')
        await recordStep(n, started, r.output, r.status ?? 'done', u, undefined, r.toolCalls);
      // A chooser fires the edges it chose (and any unlabelled side line); everything else fires all.
      for (const e of flowEdges(g, n.id))
        state.fired[e.id] = r.fire === 'all' || !e.label || r.fire.includes(e.label);
    }
    propagateDead();
    await rt.save();
    if (waiting) return { kind: 'waiting' };
    if (state.status[g.output.id]) break;
  }

  // The answer.
  let answer = state.outputs[g.output.id] ?? '';
  if (state.stopped) {
    const best = answer || allOutputs().at(-1)?.text || '';
    answer = `${best ? `${best.trim()}\n\n` : ''}_The flow "${state.flow.name}" stopped early: ${state.stopped.message} Raise it in the flow's settings, or ask again._`;
  } else if (!state.status[g.output.id]) {
    answer = allOutputs().at(-1)?.text ?? '';
  }
  state.answer = answer;
  state.done = true;
  if (state.depth === 0 && answer.trim() !== state.spoken.trim()) await rt.setAnswer(answer);
  await rt.save();
  return { kind: 'done', answer };
}
