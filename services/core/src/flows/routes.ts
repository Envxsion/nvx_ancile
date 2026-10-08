/**
 * ------------------------------------------------------------------
 *  Title    |  Flow routes
 *  Ref      |  DESIGN.md §16 · ROADMAP.md Phase 5b
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the flow editor and the thread need: list,
 *           |  create (from a template or another flow), save drafts,
 *           |  publish, activate, history and restore, validate with
 *           |  estimates, resolve which flow a thread uses, try a
 *           |  message, run one node, see a node's last run, estimate
 *           |  context per edge, decision records and labels, YAML
 *           |  export and import, and answer a past message again
 *           |  through a flow ("route again").
 *  How      |  A flow with errors can be saved as a draft but not
 *           |  activated, published or run. Saves are optimistic
 *           |  (base_version); a stale save is 409 flow.conflict.
 * ------------------------------------------------------------------
 */

import {
  ActivateFlowRequest,
  AncileError,
  CreateFlowRequest,
  EstimateContextRequest,
  type Flow,
  FlowGraph,
  type FlowProvenance,
  FULL_CONTEXT,
  LabelDecisionRequest,
  type ModelConfig,
  PublishFlowRequest,
  RestoreFlowRequest,
  RouteAgainRequest,
  RunNodeRequest,
  SaveFlowRequest,
  TryFlowRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { currentContext, newTraceId } from '../context';
import { badRequest, notFound } from '../obs/errors';
import type { RunStore } from '../runs/engine';
import type { RunWorker } from '../runs/worker';
import type { ThreadRepo } from '../threads/repo';
import { startTurn, type TurnDeps } from '../threads/service';
import type { ToolRegistry } from '../tools/registry';
import { streamCall } from './call';
import { assemble } from './context';
import { executeFlow, type FlowRuntime, initialFlowState } from './execute';
import { buildGraph, incomingFlowEdges } from './graph';
import { flowNotFound } from './store';
import { type TemplateModels, templates } from './templates';
import { mockModels, TRY_USER_ID, type TryCheckpoint, tryState, withVirtual } from './try';
import { conversationFor, type FlowsService, makeTurnRuntime } from './turn';
import { validateFlow } from './validate';

export interface FlowRouteDeps {
  workspaceId: string;
  flows: FlowsService;
  repo: ThreadRepo;
  runs: RunStore;
  worker: Pick<RunWorker, 'kick'>;
  tools: Pick<ToolRegistry, 'get'>;
  /** For "route again": the same turn machinery the thread routes use. */
  turn: TurnDeps;
}

const flowInvalid = (issues: unknown) =>
  new AncileError({
    code: 'flow.invalid',
    title: 'This flow has problems to fix first',
    hint: 'Open it in the editor: each problem is marked on its node or connection.',
    status: 422,
    errorClass: 'permanent',
    context: { issues },
  });

const ValidateBody = z.object({ graph: FlowGraph, flow_id: z.string().optional() }).strict();
const ImportBody = z.object({
  yaml: z.string().min(1).max(2_000_000),
  scope: z.enum(['workspace', 'notebook', 'thread']).default('workspace'),
  scope_ref: z.string().nullable().default(null),
});

export function flowRoutes(deps: FlowRouteDeps) {
  const r = new Hono<AppEnv>();
  const { flows } = deps;
  const store = flows.deps.store;
  const registry = flows.deps.registry;

  const pickModels = (): TemplateModels => {
    const first = (tc: string) => {
      try {
        return registry.chain(tc, null)[0]?.id;
      } catch {
        return undefined;
      }
    };
    const main = first('chat.default') ?? 'offline/test';
    return { main, cheap: first('utility') ?? main, deep: first('chat.deep') ?? main };
  };

  const validate = async (graph: FlowGraph, flow?: Flow | null, published = false) => {
    const known = new Set((await store.list({})).map((f) => f.id));
    let routeUsage: Map<string, Set<string>> | undefined;
    if (flow && Date.parse(flow.created_at) < Date.now() - 30 * 86_400_000) {
      routeUsage = new Map();
      for (const d of await store.decisions({ flowId: flow.id, sinceDays: 30, limit: 5_000 })) {
        const set = routeUsage.get(d.node_id) ?? new Set<string>();
        for (const c of d.chose) set.add(c);
        routeUsage.set(d.node_id, set);
      }
    }
    return validateFlow(graph, {
      model: (id) => registry.get(id),
      status: (m) => registry.status(m),
      tool: (name) => !!deps.tools.get(name),
      flowExists: (id) => known.has(id),
      selfId: flow?.id ?? null,
      published,
      ...(routeUsage && { routeUsage }),
    });
  };

  const mustGet = async (id: string) => {
    const f = await store.get(id);
    if (!f) throw flowNotFound();
    return f;
  };

  const graphOf = (f: Flow): FlowGraph => ({
    nodes: f.nodes,
    edges: f.edges,
    settings: f.settings,
    ...(f.viewport && { viewport: f.viewport }),
  });

  /* ---- Fixed paths first (before /flows/:id) ------------------------------------- */

  r.get('/flows', async (c) => {
    const scope = c.req.query('scope') as Flow['scope'] | undefined;
    const ref = c.req.query('ref');
    return c.json({
      items: await store.list({
        ...(scope && { scope }),
        ...(ref !== undefined && { ref: ref === '' ? null : ref }),
      }),
    });
  });

  r.get('/flows/templates', (c) => c.json({ items: templates(pickModels()) }));

  r.post('/flows', async (c) => {
    const req = CreateFlowRequest.parse(await c.req.json().catch(() => ({})));
    let graph: FlowGraph;
    if (req.from?.startsWith('tpl_')) {
      const t = templates(pickModels()).find((x) => x.id === req.from);
      if (!t) throw notFound('That template');
      graph = t.graph;
    } else if (req.from) {
      graph = graphOf(await mustGet(req.from));
    } else if (req.nodes?.length) {
      graph = FlowGraph.parse({
        nodes: req.nodes,
        edges: req.edges ?? [],
        settings: req.settings,
        viewport: req.viewport,
      });
    } else {
      graph = (templates(pickModels())[0] as { graph: FlowGraph }).graph;
    }
    if (req.activate) {
      const v = await validate(graph);
      if (!v.ok) throw flowInvalid(v.issues);
    }
    const f = await store.create({
      name: req.name,
      description: req.description,
      scope: req.scope,
      scope_ref: req.scope === 'workspace' ? null : req.scope_ref,
      graph,
      active: req.activate,
    });
    return c.json(f, 201);
  });

  r.post('/flows/validate', async (c) => {
    const req = ValidateBody.parse(await c.req.json());
    const flow = req.flow_id ? await store.get(req.flow_id) : null;
    return c.json(await validate(req.graph, flow));
  });

  r.get('/flows/resolve', async (c) => {
    const threadId = c.req.query('thread_id');
    const notebookId = c.req.query('notebook_id');
    if (threadId) {
      const t = await deps.repo.getThread(threadId);
      if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
      return c.json(await flows.resolve(t, c.req.query('flow_id') ?? null));
    }
    return c.json(
      await flows.resolve(
        { id: '', notebook_id: notebookId ?? null, settings: {} },
        c.req.query('flow_id') ?? null,
      ),
    );
  });

  r.post('/flows/import', async (c) => {
    const req = ImportBody.parse(await c.req.json());
    let raw: unknown;
    try {
      raw = parseYaml(req.yaml);
    } catch (err) {
      throw badRequest(`That is not valid YAML: ${(err as Error).message.split('\n')[0]}`);
    }
    const doc = z
      .object({ name: z.string().min(1).max(120), description: z.string().default('') })
      .passthrough()
      .parse(raw);
    const graph = FlowGraph.parse(raw);
    const f = await store.create({
      name: doc.name,
      description: doc.description,
      scope: req.scope,
      scope_ref: req.scope === 'workspace' ? null : req.scope_ref,
      graph,
      active: false,
    });
    return c.json(f, 201);
  });

  r.post('/flows/try', async (c) => {
    const req = TryFlowRequest.parse(await c.req.json());
    let saved: Flow | undefined;
    if (req.flow_id) saved = await mustGet(req.flow_id);
    if (!req.graph && !saved) throw badRequest('Give a graph, or the id of a saved flow.');
    const graph = req.graph ?? (saved as Flow);
    const v = await validate(graph, saved ?? null);
    if (!v.ok) throw flowInvalid(v.issues);
    let notebookId: string | null = null;
    if (req.thread_id) {
      const t = await deps.repo.getThread(req.thread_id);
      if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
      notebookId = t.notebook_id;
    }
    const runId = `run_${ulid()}`;
    const messageId = `try_${runId.slice(4)}`;
    const checkpoint: TryCheckpoint = {
      v: 1,
      state: tryState(saved ?? null, req.graph),
      text: req.text,
      threadId: req.thread_id ?? null,
      headId: req.head_id ?? null,
      workspaceId: deps.workspaceId,
      notebookId,
      mock: req.mock === true,
      messageId,
      savedFlowId: saved?.id ?? null,
    };
    await deps.runs.create({
      id: runId,
      kind: 'flow_try',
      traceId: currentContext()?.traceId ?? newTraceId(),
      threadId: null,
      messageId: null,
      checkpoint,
    });
    deps.worker.kick();
    return c.json({ run_id: runId, stream_url: `/api/v1/runs/${runId}/stream`, message_id: messageId }, 202);
  });

  r.post('/flows/estimate-context', async (c) => {
    const req = EstimateContextRequest.parse(await c.req.json());
    let all = [] as Awaited<ReturnType<ThreadRepo['messages']>>;
    let headId: string | null = null;
    if (req.thread_id) {
      const t = await deps.repo.getThread(req.thread_id);
      if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
      all = await deps.repo.messages(t.id);
      headId = t.active_head_id;
    }
    const text = req.text ?? 'A typical question of a few sentences, to estimate with.';
    const msgs = withVirtual(all, headId, text, req.thread_id ?? 'estimate');
    const g = buildGraph(req.graph);
    const out = [];
    for (const n of g.nodes.values()) {
      if (n.kind !== 'model' && n.kind !== 'manager') continue;
      const m = registry.get(n.params.model);
      const edges = (g.in.get(n.id) ?? []).filter((e) => !g.returnEdges.has(e.id));
      for (const e of edges.length ? edges : [undefined]) {
        const policy = e?.context ?? FULL_CONTEXT;
        const upstreamCount =
          policy.upstream === 'all' ? Math.max(1, g.nodes.size - 2) : incomingFlowEdges(g, n.id).length;
        const payload = await assemble({
          policy,
          role: n.params.role,
          input: text,
          upstream: Array.from({ length: policy.upstream === 'none' ? 0 : upstreamCount }, (_, i) => ({
            node: `u${i}`,
            label: 'An earlier step',
            text: 'x'.repeat(2_400),
          })),
          src: {
            conversation: async (mode) => conversationFor(msgs, TRY_USER_ID, mode),
            sources: async (p) =>
              p.mode === 'none' ? '' : 'x'.repeat((p.mode === 'retrieved' ? p.k : 8) * 1_400),
            memory: async (mode) => (mode === 'none' ? '' : 'x'.repeat(mode === 'pack' ? 6_000 : 1_600)),
          },
        });
        const total = Object.values(payload.tokens).reduce((a, b) => a + b, 0);
        out.push({
          edge_id: e?.id ?? null,
          node_id: n.id,
          tokens: payload.tokens,
          total,
          context_window: m?.context_window ?? null,
          over: !!m && total > m.context_window,
        });
      }
    }
    return c.json({ edges: out });
  });

  r.post('/flows/decisions/:message_id/:node_id/label', async (c) => {
    const req = LabelDecisionRequest.parse(await c.req.json());
    const ok = await store.labelDecision(c.req.param('message_id'), c.req.param('node_id'), req.label);
    if (!ok) throw notFound('That decision');
    return c.json({ ok: true });
  });

  /* ---- One flow ------------------------------------------------------------------- */

  r.get('/flows/:id', async (c) => c.json(await mustGet(c.req.param('id'))));

  r.put('/flows/:id', async (c) => {
    const req = SaveFlowRequest.parse(await c.req.json());
    const f = await store.save(
      c.req.param('id'),
      {
        name: req.name,
        description: req.description,
        graph: {
          nodes: req.nodes,
          edges: req.edges,
          settings: req.settings,
          ...(req.viewport && { viewport: req.viewport }),
        },
        message: req.message ?? null,
      },
      req.base_version,
    );
    return c.json(f);
  });

  r.delete('/flows/:id', async (c) => {
    if (!(await store.remove(c.req.param('id')))) throw flowNotFound();
    return c.body(null, 204);
  });

  r.post('/flows/:id/activate', async (c) => {
    const req = ActivateFlowRequest.parse(await c.req.json().catch(() => ({})));
    const f = await mustGet(c.req.param('id'));
    if (req.on) {
      const live = (await store.getLive(f.id)) ?? f;
      const v = await validate(live, f, true);
      if (!v.ok) throw flowInvalid(v.issues);
      // Turning on a flow none of whose models can answer would make every
      // message fail, so refuse and say why.
      if (v.issues.some((i) => i.code === 'flow.no_model_ready'))
        throw new AncileError({
          code: 'flow.no_model_ready',
          title: "None of this flow's models can answer yet",
          hint: 'Add a key in Settings → Models, or choose models you have set up, then turn the flow on.',
          status: 422,
          errorClass: 'permanent',
        });
    }
    return c.json(await store.activate(f.id, req.on));
  });

  r.post('/flows/:id/publish', async (c) => {
    const req = PublishFlowRequest.parse(await c.req.json());
    const f = await mustGet(c.req.param('id'));
    if (req.version !== null) {
      const v = await store.getVersion(f.id, req.version);
      if (!v) throw notFound(`Version ${req.version}`);
      const checked = await validate(v, f, true);
      if (!checked.ok) throw flowInvalid(checked.issues);
    }
    return c.json(await store.publish(f.id, req.version));
  });

  r.get('/flows/:id/versions', async (c) => {
    await mustGet(c.req.param('id'));
    return c.json({ items: await store.versions(c.req.param('id')) });
  });

  r.get('/flows/:id/versions/:v', async (c) => {
    const v = await store.getVersion(c.req.param('id'), Number(c.req.param('v')));
    if (!v) throw notFound('That version');
    return c.json(v);
  });

  r.post('/flows/:id/restore', async (c) => {
    const req = RestoreFlowRequest.parse(await c.req.json());
    const f = await mustGet(c.req.param('id'));
    const v = await store.getVersion(f.id, req.version);
    if (!v) throw notFound('That version');
    return c.json(
      await store.save(
        f.id,
        {
          name: v.name,
          description: f.description,
          graph: graphOf(v),
          message: `Restored version ${req.version}`,
        },
        f.version,
      ),
    );
  });

  r.get('/flows/:id/export', async (c) => {
    const f = await mustGet(c.req.param('id'));
    const text = toYaml({ name: f.name, description: f.description, ...graphOf(f) });
    return c.body(text, 200, {
      'content-type': 'application/yaml; charset=utf-8',
      'content-disposition': `attachment; filename="${f.name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'flow'}.yaml"`,
    });
  });

  r.get('/flows/:id/decisions', async (c) => {
    const f = await mustGet(c.req.param('id'));
    const node = c.req.query('node');
    let items = await store.decisions({ flowId: f.id, ...(node && { nodeId: node }), limit: 500 });
    if (c.req.query('close') === '1')
      items = items.filter((d) => {
        const s = Object.values(d.scores ?? {}).sort((a, b) => b - a);
        if (s.length >= 2) return (s[0] as number) - (s[1] as number) <= 0.1;
        return d.confidence !== null && d.confidence < 0.6;
      });
    return c.json({ items });
  });

  r.get('/flows/:id/stats', async (c) => {
    const f = await mustGet(c.req.param('id'));
    return c.json({ nodes: await store.nodeStats(f.id) });
  });

  r.get('/flows/:id/nodes/:node/last', async (c) => {
    const run = await store.lastNodeRun(c.req.param('id'), c.req.param('node'));
    if (!run) throw notFound('A run of that node');
    return c.json({
      node_id: run.node_id,
      payload: run.payload,
      output: run.output,
      meta: run.meta,
      at: run.at,
    });
  });

  r.post('/flows/:id/nodes/:node/run', async (c) => {
    const req = RunNodeRequest.parse(await c.req.json());
    const f = await mustGet(c.req.param('id'));
    const graph = req.graph ?? graphOf(f);
    const nodeId = c.req.param('node');
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw notFound('That node');
    if (node.kind === 'note' || node.kind === 'group' || node.kind === 'input' || node.kind === 'output')
      throw badRequest('Only working nodes can run on their own.');
    // A small flow: input → this node (and a manager's or loop's workers) → output.
    const g = buildGraph(graph);
    const keep = new Set([nodeId]);
    for (const e of g.out.get(nodeId) ?? []) if (g.workerEdges.has(e.id)) keep.add(e.to);
    const mini: FlowGraph = {
      settings: graph.settings,
      nodes: [
        { id: '__in', kind: 'input', position: { x: 0, y: 0 }, params: {} },
        { id: '__out', kind: 'output', position: { x: 0, y: 0 }, params: { template: '' } },
        ...graph.nodes.filter((n) => keep.has(n.id)),
      ],
      edges: [
        { id: '__in-node', from: '__in', to: nodeId },
        ...graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
        { id: '__node-out', from: nodeId, to: '__out' },
      ],
    };
    let all = [] as Awaited<ReturnType<ThreadRepo['messages']>>;
    let notebookId: string | null = null;
    if (req.thread_id) {
      const t = await deps.repo.getThread(req.thread_id);
      if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
      all = await deps.repo.messages(t.id);
      notebookId = t.notebook_id;
    }
    const msgs = withVirtual(all, req.head_id ?? null, req.input, req.thread_id ?? 'node-run');
    const state = initialFlowState({ id: f.id, name: f.name, version: f.version, scope: f.scope, ...mini });
    let payload: unknown = null;
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(graph.settings.timeout_s * 1000)]);
    const base = makeTurnRuntime({
      flows,
      input: {
        text: req.input,
        threadId: req.thread_id ?? null,
        notebookId,
        notebookTitle: null,
        workspaceId: deps.workspaceId,
        messageId: `node_${ulid()}`,
        userMessageId: TRY_USER_ID,
        hasAttachment: false,
        branchDepth: msgs.length,
      },
      signal,
      messages: async () => msgs,
      compaction: null,
      groundingBlock: notebookId
        ? await flows.retrievePassages({ workspaceId: deps.workspaceId, notebookId, query: req.input, k: 8 })
        : '',
      memory: async (model) =>
        (await flows.deps.memory?.({ notebookId, model, query: req.input }).catch(() => '')) ?? '',
      emit: async () => undefined,
      call: (chain, mreq, onDelta, opts) =>
        streamCall({ gateway: flows.deps.gateway, registry }, chain, mreq, signal, onDelta, opts),
      speak: () => undefined,
      setAnswer: async () => undefined,
      save: async () => undefined,
      ...(req.mock && { mock: { models: mockModels() } }),
    });
    const rt: FlowRuntime = {
      ...base,
      recordDecision: undefined,
      recordNodeRun: async (id, p, output, meta) => {
        if (id === nodeId) payload = p;
        await store
          .recordNodeRun({ flow_id: f.id, node_id: id, payload: p, output, meta })
          .catch(() => undefined);
      },
    };
    const started = Date.now();
    await executeFlow(state, rt);
    const step = state.steps.find((s) => s.node_id === nodeId);
    if (!step)
      throw new AncileError({
        code: 'flow.failed',
        title: 'That node did not run',
        hint: 'Check its settings.',
        status: 500,
        errorClass: 'transient',
      });
    if (step.status === 'failed')
      throw new AncileError({
        code: 'flow.node_failed',
        title: `${node.label ?? node.id} failed`,
        hint: step.error ?? 'Check its model and settings.',
        status: 502,
        errorClass: 'transient',
      });
    const out = {
      node_id: nodeId,
      output: state.outputs[nodeId] ?? step.output,
      model_id: step.model_id,
      tokens_in: step.tokens_in,
      tokens_out: step.tokens_out,
      cost_usd: state.cost,
      ms: Date.now() - started,
      payload,
    };
    if (payload === null && node.kind !== 'model')
      await store
        .recordNodeRun({
          flow_id: f.id,
          node_id: nodeId,
          payload: { input: req.input },
          output: out.output,
          meta: { model_id: step.model_id, cost_usd: state.cost },
        })
        .catch(() => undefined);
    return c.json(out);
  });

  /* ---- Answer a past message again through a flow ---------------------------------- */

  r.post('/messages/:id/route-again', async (c) => {
    const req = RouteAgainRequest.parse(await c.req.json().catch(() => ({})));
    const m = await deps.repo.getMessage(c.req.param('id'));
    if (!m || m.deleted_at) throw notFound('That message');
    const t = await deps.repo.getThread(m.thread_id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That message');
    // An answer is routed again from its question; a question from itself.
    const userId = m.role === 'assistant' ? m.parent_id : m.id;
    if (!userId) throw notFound('The question for that message');
    // Rerun from a step: the earlier steps of this answer are reused as recorded.
    const recorded =
      req.from_node && m.role === 'assistant'
        ? ((m.provenance as { flow?: FlowProvenance } | null)?.flow ?? undefined)
        : undefined;
    if (req.from_node && !recorded)
      throw badRequest('That answer was not made by a flow, so there are no steps to rerun from.');
    if (req.model && !registry.get(req.model)) throw notFound(`A model called ${req.model}`);
    const flowId = req.flow_id ?? recorded?.flow_id ?? (await flows.resolve(t)).flow?.id;
    if (!flowId) throw badRequest('No flow applies here. Pick one to route through.');
    const version = req.version ?? (recorded && recorded.flow_id === flowId ? recorded.version : undefined);
    const target = version ? await store.getVersion(flowId, version) : await store.getLive(flowId);
    if (!target) throw notFound('That flow version');
    const v = await validate(target, await store.get(flowId), true);
    if (!v.ok) throw flowInvalid(v.issues);
    const started = await startTurn(deps.turn, {
      thread: t,
      user: { existingId: userId },
      routeAgain: {
        flowId,
        ...(version !== undefined && { version }),
        ...(req.from_node && { fromNode: req.from_node }),
        ...(req.model && { model: req.model }),
        ...(recorded && { recorded }),
      },
    });
    return c.json(started, 202);
  });

  return r;
}

/** The memory pack for a model outside a chat turn (Try, Run node). */
export function memoryText(
  pack: (q: {
    notebookId: string | null;
    modelId: string;
    contextWindow: number;
    query: string;
  }) => Promise<{ text: string }>,
) {
  return async (q: { notebookId: string | null; model: ModelConfig | undefined; query: string }) => {
    if (!q.model) return '';
    return (
      await pack({
        notebookId: q.notebookId,
        modelId: q.model.id,
        contextWindow: q.model.context_window,
        query: q.query,
      })
    ).text;
  };
}
