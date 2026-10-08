/**
 * ------------------------------------------------------------------
 *  Title    |  Flows in a chat turn
 *  Ref      |  DESIGN.md §16.3, §16.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Decide which flow answers a message (the message's own,
 *           |  the thread's, the notebook's, the workspace default, or
 *           |  none for plain chat), and give the executor what it needs
 *           |  from the turn: conversation, passages, memory, tools,
 *           |  questions to you, and the visible answer.
 *  How      |  FlowsService holds the long-lived pieces (store, models,
 *           |  retrieval, fact-check steps); makeTurnRuntime wraps the
 *           |  conductor's closures for one turn.
 * ------------------------------------------------------------------
 */

import type {
  ContextPolicy,
  Flow,
  FlowDecision,
  FlowProvenance,
  ModelConfig,
  Part,
  ResolvedFlow,
} from '@nvx/contracts';
import type { z } from 'zod';
import type { Retriever } from '../conductor/retrieval';
import { groundingFrom } from '../conductor/retrieval';
import { messageScore, scoreOutcome } from '../factcheck/pipeline';
import { extractClaims, gatherEvidence, verifyClaim } from '../factcheck/steps';
import type { Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import type { ModelMessage, ModelRequest } from '../gateway/types';
import type { KnowledgeClient } from '../knowledge/client';
import { logFor } from '../obs/logger';
import { ancestorPath } from '../threads/path';
import { asTree, type MessageRecord, type ThreadRecord, type ThreadRepo, textOf } from '../threads/repo';
import type { ContextSources } from './context';
import {
  type FlowRuntime,
  type FlowState,
  initialFlowState,
  type ModelCallResult,
  type RouteHint,
  type RouteHintQuery,
} from './execute';
import { buildGraph, flowEdges, reachable } from './graph';
import type { FlowStore } from './store';

const log = logFor('flows');

export interface FlowsDeps {
  store: FlowStore;
  repo: ThreadRepo;
  registry: ModelRegistry;
  gateway: Gateway;
  promptsDir: string;
  retriever?: Retriever;
  kn?: Pick<KnowledgeClient, 'post'>;
  monthSpendUsd?: () => Promise<number>;
  nodeAwake?: (nodeId: string) => Promise<boolean>;
  /** The memory pack outside a chat turn ("Try a message"). */
  memory?: (q: {
    notebookId: string | null;
    model: ModelConfig | undefined;
    query: string;
  }) => Promise<string>;
  /** Routes already known for a request (set once Pro has loaded; absent in the free build). */
  routeHint?: (q: RouteHintQuery) => Promise<RouteHint | null>;
}

/** Answer through a flow version; optionally rerun from one step with another model. */
export interface RouteAgain {
  flowId?: string;
  version?: number;
  fromNode?: string;
  model?: string;
  /** The answer being rerun: its recorded steps feed the nodes before fromNode. */
  recorded?: FlowProvenance;
}

/**
 * Rerun from a step: every node before `fromNode` on the recorded path keeps
 * its output (marked cached, no call made), and the edges it took are taken
 * again; `fromNode` and everything after it run afresh, with `model` swapped in.
 */
export function seedFrom(state: FlowState, rec: FlowProvenance, fromNode: string, model?: string): void {
  const g = buildGraph(state.flow.graph);
  if (!g.nodes.has(fromNode)) return;
  const after = reachable(g, fromNode);
  const chose = new Map(rec.decisions.map((d) => [d.node_id, d.chose] as const));
  for (const id of rec.path) {
    if (after.has(id) || !g.nodes.has(id)) continue;
    const step = rec.steps.find((s) => s.node_id === id);
    const n = g.nodes.get(id);
    state.outputs[id] = step?.output ?? (n?.kind === 'input' ? '' : '');
    state.status[id] = 'cached';
    state.path.push(id);
    if (step) state.steps.push({ ...step, status: 'cached', cost_usd: 0, ms: 0 });
    const labels = chose.get(id);
    for (const e of flowEdges(g, id)) state.fired[e.id] = !labels || !e.label || labels.includes(e.label);
  }
  // Input's text is the message itself; let the executor fill it.
  delete state.outputs[g.input?.id ?? ''];
  if (g.input) delete state.status[g.input.id];
  if (g.input) state.path = state.path.filter((p) => p !== g.input?.id);
  if (model) state.overrides = { ...(state.overrides ?? {}), [fromNode]: { model } };
}

/** Repeat a recorded answer's route ("regenerate, same route"). */
export interface FlowReplay {
  flowId: string;
  version: number;
  decisions: Record<string, string[]>;
}

export class FlowsService {
  constructor(readonly deps: FlowsDeps) {}

  /** Which flow answers in this thread now (precedence: message, thread, notebook, workspace). */
  async resolve(
    thread: Pick<ThreadRecord, 'id' | 'notebook_id' | 'settings'>,
    flowId?: string | null,
  ): Promise<z.infer<typeof ResolvedFlow>> {
    const { store } = this.deps;
    if (flowId) {
      const f = await store.getLive(flowId);
      if (f) return { flow: f, from: 'message' };
    }
    const own = (thread.settings as { flow_id?: string | null }).flow_id;
    // 'off': this thread answers without a flow, whatever its notebook uses.
    // Say which flow is paused, so it can be offered back.
    if (own === 'off') {
      const below = await this.inherited(thread);
      return {
        flow: null,
        from: 'thread',
        paused: below.flow ? { id: below.flow.id, name: below.flow.name, from: below.from } : null,
      };
    }
    if (own) {
      const f = await store.getLive(own);
      if (f) return { flow: f, from: 'thread' };
    }
    return this.inherited(thread);
  }

  /** The flow a thread gets without its own choice: a thread-scoped flow, its notebook's, the workspace's. */
  private async inherited(
    thread: Pick<ThreadRecord, 'id' | 'notebook_id'>,
  ): Promise<{ flow: Flow; from: 'thread' | 'notebook' | 'workspace' } | { flow: null; from: 'none' }> {
    const { store } = this.deps;
    const threadFlow = await store.activeFor('thread', thread.id);
    if (threadFlow) return { flow: threadFlow, from: 'thread' };
    if (thread.notebook_id) {
      const nb = await store.activeFor('notebook', thread.notebook_id);
      if (nb) return { flow: nb, from: 'notebook' };
    }
    const ws = await store.activeFor('workspace', null);
    if (ws) return { flow: ws, from: 'workspace' };
    return { flow: null, from: 'none' };
  }

  /** The state a turn starts from, or null for a plain chat turn. */
  async startState(
    thread: ThreadRecord,
    opts: { flowId?: string | null; replay?: FlowReplay | null; routeAgain?: RouteAgain | null },
  ): Promise<FlowState | null> {
    const { store } = this.deps;
    let flow: Flow | undefined;
    let replay: Record<string, string[]> | undefined;
    const again = opts.routeAgain;
    if (opts.replay) {
      flow =
        (await store.getVersion(opts.replay.flowId, opts.replay.version)) ??
        (await store.getLive(opts.replay.flowId));
      replay = opts.replay.decisions;
    } else if (again?.flowId) {
      flow =
        again.version !== undefined
          ? await store.getVersion(again.flowId, again.version)
          : await store.getLive(again.flowId);
    } else {
      flow = (await this.resolve(thread, opts.flowId)).flow ?? undefined;
    }
    // The flow a regenerate asked for was deleted (or that version is gone):
    // answer the way the thread answers now, without the old route.
    if (!flow && (opts.replay || again?.flowId)) {
      flow = (await this.resolve(thread)).flow ?? undefined;
      replay = undefined;
    }
    if (!flow) return null;
    const state = initialFlowState(flow, replay ? { replay } : {});
    if (again?.fromNode && again.recorded) seedFrom(state, again.recorded, again.fromNode, again.model);
    return state;
  }

  /** A quick fact-check of an answer for a Fact-check node: confidence in [0,1] and a line of words. */
  async factcheck(
    answer: string,
    opts: { question: string; workspaceId: string; notebookId: string | null; signal: AbortSignal },
  ): Promise<{ confidence: number | null; summary: string }> {
    const steps = {
      gateway: this.deps.gateway,
      registry: this.deps.registry,
      promptsDir: this.deps.promptsDir,
      ...(this.deps.kn && { kn: this.deps.kn }),
    };
    try {
      const { claims } = await extractClaims(steps, { answer, question: opts.question }, opts.signal);
      const checkable = claims.filter((c) => c.checkable).slice(0, 8);
      if (!checkable.length) return { confidence: null, summary: 'There was nothing in it to check.' };
      const gathered = await gatherEvidence(steps, {
        workspaceId: opts.workspaceId,
        notebookId: opts.notebookId,
        claims: checkable.map((c) => c.text),
      });
      const checked = [];
      for (let i = 0; i < checkable.length; i++) {
        const g = gathered[i] ?? { evidence: [], coverage: 0 };
        const v = await verifyClaim(
          steps,
          { claim: (checkable[i] as { text: string }).text, evidence: g.evidence, generatorFamily: null },
          opts.signal,
        );
        checked.push(
          scoreOutcome({
            claim: checkable[i] as never,
            evidence: v.evidence,
            coverage: g.coverage,
            verdict: v.verdict,
            rationale: v.rationale,
          }),
        );
      }
      const confidence = messageScore(checked);
      const verified = checked.filter((c) => c.score.verdict === 'verified').length;
      return { confidence, summary: `${verified} of ${checked.length} claims supported by your sources.` };
    } catch (err) {
      log.warn({ err }, 'a flow fact-check failed');
      return { confidence: null, summary: 'The check could not run.' };
    }
  }

  async retrievePassages(q: {
    workspaceId: string;
    notebookId: string | null;
    query: string;
    k: number;
    sourceIds?: string[];
  }): Promise<string> {
    if (!this.deps.retriever || !q.notebookId) return '';
    try {
      const res = await this.deps.retriever.search({
        workspaceId: q.workspaceId,
        notebookId: q.notebookId,
        query: q.query,
        k: q.k,
        ...(q.sourceIds?.length && { sourceIds: q.sourceIds }),
      });
      return groundingFrom(res, { query: q.query, notebookId: q.notebookId, notebookTitle: null }).block;
    } catch (err) {
      log.warn({ err }, 'flow retrieval failed');
      return '';
    }
  }
}

/* ---- Conversation views for context policies -------------------------------------- */

function asModel(m: MessageRecord): ModelMessage {
  return {
    role: m.role === 'tool' ? 'assistant' : (m.role as ModelMessage['role']),
    content: textOf(m.parts),
  };
}

const firstLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The conversation for a mode, oldest first, ending before the message being answered. */
export function conversationFor(
  all: MessageRecord[],
  userMessageId: string | null,
  mode: ContextPolicy['conversation'],
  opts: { skipThrough?: string | null; summary?: string | null } = {},
): ModelMessage[] {
  if (!userMessageId || mode.mode === 'none') return [];
  const live = all.filter((m) => !m.deleted_at);
  const tree = asTree(live);
  const byId = new Map(tree.map((m) => [m.id, m] as const));
  const path = ancestorPath(byId, userMessageId).filter((m) => m.role !== 'system');
  const before = path.slice(0, -1);
  const from = opts.skipThrough ? before.findIndex((m) => m.id === opts.skipThrough) + 1 : 0;
  const branch = before
    .slice(Math.max(0, from))
    .map(asModel)
    .filter((m) => m.content.trim());
  const summaryMsg: ModelMessage[] =
    from > 0 && opts.summary
      ? [{ role: 'user', content: `Summary of the earlier conversation:\n${opts.summary}` }]
      : [];

  switch (mode.mode) {
    case 'branch':
      return [...summaryMsg, ...branch];
    case 'last_n':
      return branch.slice(-mode.n * 2);
    case 'tldr': {
      if (opts.summary)
        return [{ role: 'user', content: `Summary of the conversation so far:\n${opts.summary}` }];
      return branch.slice(-4);
    }
    case 'siblings': {
      const onPath = new Set(path.map((m) => m.id));
      const notes: string[] = [];
      for (const m of before) {
        const kids = tree.filter((k) => k.parent_id === m.id && !onPath.has(k.id));
        for (const k of kids) {
          const text = textOf(k.parts);
          if (!text.trim()) continue;
          notes.push(
            `- After "${firstLine(textOf(m.parts), 80)}", another branch ${k.role === 'user' ? 'asked' : 'answered'}: ${firstLine(text)}`,
          );
        }
      }
      const extra: ModelMessage[] = notes.length
        ? [
            {
              role: 'user',
              content: `Other branches of this conversation (for context; not the path you are on):\n${notes.slice(0, 20).join('\n')}`,
            },
          ]
        : [];
      return [...extra, ...summaryMsg, ...branch];
    }
    case 'tree_summary': {
      const kids = new Map<string | null, typeof tree>();
      for (const m of tree) kids.set(m.parent_id, [...(kids.get(m.parent_id) ?? []), m]);
      const leaves = tree.filter((m) => !(kids.get(m.id) ?? []).length);
      const lines = leaves.slice(0, 30).map((leaf) => {
        const p = ancestorPath(byId, leaf.id).filter((m) => m.role === 'user');
        const q = p.at(-1);
        return `- ${firstLine(q ? textOf(q.parts) : '', 100)} → ${firstLine(textOf(leaf.parts), 120)}`;
      });
      return [{ role: 'user', content: `Every branch of this conversation, in brief:\n${lines.join('\n')}` }];
    }
  }
}

/* ---- The runtime for one chat turn ------------------------------------------------- */

export interface TurnHooks {
  flows: FlowsService;
  input: FlowRuntime['input'] & { userMessageId: string };
  signal: AbortSignal;
  /** Every message in the thread (read per call, so new ones are seen). */
  messages: () => Promise<MessageRecord[]>;
  compaction: { skipThrough: string | null; summary: string | null } | null;
  /** The passages retrieval found for this turn. */
  groundingBlock: string;
  /**
   * Sources you @-mentioned on the message. A Retrieve node (or a "named
   * sources" edge) with no sources of its own searches only these, so your
   * narrowing holds inside a flow too.
   */
  mentionedSources?: string[];
  /** The conductor's memory pack for a model ('' when none). */
  memory: (model: ModelConfig | undefined) => Promise<string>;
  emit: FlowRuntime['emit'];
  call: (
    chain: ModelConfig[],
    req: ModelRequest,
    onDelta: (channel: 'text' | 'reasoning', delta: string) => void,
    opts: { computeWaitMs?: number },
  ) => Promise<ModelCallResult>;
  tool?: FlowRuntime['tool'];
  toolDefs?: FlowRuntime['toolDefs'];
  ask?: FlowRuntime['ask'];
  speak: FlowRuntime['speak'];
  setAnswer: FlowRuntime['setAnswer'];
  save: FlowRuntime['save'];
  overrides?: FlowRuntime['overrides'];
  mock?: FlowRuntime['mock'];
}

export function makeTurnRuntime(h: TurnHooks): FlowRuntime {
  const { flows } = h;
  const reg = flows.deps.registry;
  return {
    signal: h.signal,
    input: h.input,
    model: (id) => reg.get(id),
    status: (m) => reg.status(m),
    contextFor: (model): ContextSources => ({
      conversation: async (mode) =>
        conversationFor(await h.messages(), h.input.userMessageId, mode, {
          skipThrough: h.compaction?.skipThrough ?? null,
          summary: h.compaction?.summary ?? null,
        }),
      sources: async (p) => {
        if (p.mode === 'none') return '';
        if (p.mode === 'retrieved') return h.groundingBlock;
        return flows.retrievePassages({
          workspaceId: h.input.workspaceId,
          notebookId: h.input.notebookId,
          query: h.input.text,
          k: 8,
          sourceIds: p.source_ids?.length ? p.source_ids : (h.mentionedSources ?? []),
        });
      },
      memory: async (mode) => {
        if (mode === 'none') return '';
        const pack = await h.memory(model);
        if (mode === 'pack' || !pack) return pack;
        // Only the notebook's project file.
        const parts = pack.split(/\n(?=## )/);
        const keep = parts.filter((p) => /^## .*\(PROJECTS\//.test(p));
        return keep.length ? keep.join('\n') : '';
      },
    }),
    call: (chain, req, onDelta, opts) =>
      h.call(
        chain,
        req,
        onDelta,
        opts.waitForWakeS !== undefined ? { computeWaitMs: opts.waitForWakeS * 1000 } : {},
      ),
    ...(h.tool && { tool: h.tool }),
    ...(h.toolDefs && { toolDefs: h.toolDefs }),
    ...(h.ask && { ask: h.ask }),
    retrieve: (q) =>
      flows.retrievePassages({
        workspaceId: h.input.workspaceId,
        notebookId: h.input.notebookId,
        query: q.query,
        k: q.k,
        ...((q.sourceIds?.length || h.mentionedSources?.length) && {
          sourceIds: q.sourceIds?.length ? q.sourceIds : h.mentionedSources,
        }),
      }),
    factcheck: (answer) =>
      flows.factcheck(answer, {
        question: h.input.text,
        workspaceId: h.input.workspaceId,
        notebookId: h.input.notebookId,
        signal: h.signal,
      }),
    loadFlow: (id) => flows.deps.store.getLive(id),
    emit: h.emit,
    speak: h.speak,
    setAnswer: h.setAnswer,
    save: h.save,
    recordDecision: async (d: FlowDecision & { scores?: Record<string, number> }) => {
      if (!h.input.threadId) return;
      await flows.deps.store
        .recordDecision({
          message_id: h.input.messageId,
          thread_id: h.input.threadId,
          flow_id: '',
          version: 0,
          node_id: d.node_id,
          chose: d.chose,
          confidence: d.confidence,
          ...(d.scores && { scores: d.scores }),
        })
        .catch((err) => log.warn({ err }, 'could not record a route decision'));
    },
    facts: {
      ...(flows.deps.monthSpendUsd && { monthSpendUsd: flows.deps.monthSpendUsd }),
      ...(flows.deps.nodeAwake && { nodeAwake: flows.deps.nodeAwake }),
    },
    ...(h.overrides && { overrides: h.overrides }),
    ...(h.mock && { mock: h.mock }),
    // Read at call time: Pro, which provides it, loads after the flows service.
    routeHint: async (q) => (flows.deps.routeHint ? flows.deps.routeHint(q) : null),
  };
}

/** Bind the decision recorder to the flow it belongs to. */
export function withFlow(
  rt: FlowRuntime,
  state: FlowState,
  store: FlowStore,
  threadId: string | null,
): FlowRuntime {
  return {
    ...rt,
    recordDecision: async (d) => {
      if (!threadId) return;
      await store
        .recordDecision({
          message_id: rt.input.messageId,
          thread_id: threadId,
          flow_id: state.flow.id,
          version: state.flow.version,
          node_id: d.node_id,
          chose: d.chose,
          confidence: d.confidence,
          ...(d.scores && { scores: d.scores }),
        })
        .catch((err) => log.warn({ err }, 'could not record a route decision'));
    },
    recordNodeRun: async (nodeId, payload, output, meta) => {
      await store
        .recordNodeRun({ flow_id: state.flow.id, node_id: nodeId, payload, output, meta })
        .catch((err) => log.warn({ err }, 'could not keep a node run'));
    },
  };
}

/** The decisions a recorded answer made, keyed by node (for "same route"). */
export function replayFrom(prov: unknown): FlowReplay | null {
  const f = (prov as { flow?: FlowProvenance } | null)?.flow;
  if (!f) return null;
  const decisions: Record<string, string[]> = {};
  for (const d of f.decisions) if (!d.node_id.includes(':')) decisions[d.node_id] = d.chose;
  return { flowId: f.flow_id, version: f.version, decisions };
}

/** Plain text of parts, for "has the answer changed?" */
export const partsText = (parts: Part[]) => textOf(parts);
