/**
 * Flows (DESIGN.md §16, ROADMAP Phase 5b): validation, precedence, the
 * executor on every template, context policies, resume after a crash, the
 * cost cap, regenerate "same route" versus "again", and the routes.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Flow,
  FlowGraph,
  FlowNode,
  FlowProvenance,
  Message,
  RunEvent,
  ThreadPath,
} from '@nvx/contracts';
import { FlowSettings, ModelParams } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeFlow,
  type FlowRuntime,
  initialFlowState,
  type ModelCallResult,
} from '../../src/flows/execute';
import { validateFlow } from '../../src/flows/validate';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const settings = FlowSettings.parse({});
const model = (id: string, extra: Partial<ModelParams> = {}): FlowNode => ({
  id,
  kind: 'model',
  label: id,
  position: { x: 0, y: 0 },
  params: ModelParams.parse({ model: 'offline/test', ...extra }),
});
const io: FlowNode[] = [
  { id: 'input', kind: 'input', position: { x: 0, y: 0 }, params: {} },
  { id: 'output', kind: 'output', position: { x: 0, y: 0 }, params: { template: '' } },
];

async function lastAnswer(threadId: string): Promise<Message> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  return path.messages.at(-1) as Message;
}
const flowOf = (m: Message) => (m.provenance as { flow?: FlowProvenance }).flow as FlowProvenance;

async function fromTemplate(
  tpl: string,
  scope: 'workspace' | 'notebook' | 'thread' = 'workspace',
  ref: string | null = null,
) {
  const r = await h.call<Flow>('POST', '/flows', {
    name: tpl,
    from: tpl,
    scope,
    scope_ref: ref,
    activate: true,
  });
  expect(r.status).toBe(201);
  return r.body;
}

/* ---- Validation ---------------------------------------------------------------- */

describe('validation', () => {
  const deps = {
    model: (id: string) =>
      id === 'offline/test'
        ? ({
            id,
            display_name: 'Offline test',
            context_window: 32_000,
            via: 'direct',
            price: { input_per_mtok: 0, output_per_mtok: 0 },
          } as never)
        : undefined,
    status: () => 'ready' as const,
    tool: () => true,
    flowExists: () => true,
  };

  it('accepts a plain flow and estimates its path', () => {
    const v = validateFlow(
      {
        nodes: [...io, model('a')],
        edges: [
          { id: 'e1', from: 'input', to: 'a' },
          { id: 'e2', from: 'a', to: 'output' },
        ],
      },
      deps,
    );
    expect(v.ok).toBe(true);
    expect(v.estimate.paths).toHaveLength(1);
    expect(v.estimate.paths[0]?.models).toEqual(['offline/test']);
  });

  it('warns when no model in the flow can answer, and only then', () => {
    const graph = {
      nodes: [...io, model('a')],
      edges: [
        { id: 'e1', from: 'input', to: 'a' },
        { id: 'e2', from: 'a', to: 'output' },
      ],
    };
    const keyless = validateFlow(graph, { ...deps, status: () => 'needs_key' as const });
    expect(keyless.issues.map((i) => i.code)).toContain('flow.no_model_ready');
    expect(validateFlow(graph, deps).issues.map((i) => i.code)).not.toContain('flow.no_model_ready');
  });

  it('refuses loops, unknown models, mislabelled routes and keys in prompts', () => {
    const v = validateFlow(
      {
        nodes: [
          ...io,
          model('a'),
          model('b', { model: 'nope/model', role: 'Use key sk-ant-REALLOOKINGKEY1234567890' }),
          {
            id: 'r',
            kind: 'router',
            position: { x: 0, y: 0 },
            params: {
              model: 'offline/test',
              instructions: '',
              routes: [{ label: 'x', when: '' }],
              min_confidence: 0.5,
              multi: false,
            },
          },
        ],
        edges: [
          { id: 'e1', from: 'input', to: 'a' },
          { id: 'e2', from: 'a', to: 'b' },
          { id: 'e3', from: 'b', to: 'a' },
          { id: 'e4', from: 'input', to: 'r' },
          { id: 'e5', from: 'r', to: 'output', label: 'y' },
        ],
      },
      deps,
    );
    const codes = v.issues.filter((i) => i.level === 'error').map((i) => i.code);
    expect(v.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        'flow.cycle',
        'flow.model_unknown',
        'flow.route_mismatch',
        'flow.secret_in_prompt',
      ]),
    );
  });

  it('lets a worker report back to its manager without calling it a loop', () => {
    const v = validateFlow(
      {
        nodes: [
          ...io,
          {
            id: 'm',
            kind: 'manager',
            position: { x: 0, y: 0 },
            params: { ...ModelParams.parse({ model: 'offline/test' }), instructions: '', max_rounds: 2 },
          },
          model('w'),
        ],
        edges: [
          { id: 'e1', from: 'input', to: 'm' },
          { id: 'e2', from: 'm', to: 'w' },
          { id: 'e3', from: 'w', to: 'm' },
          { id: 'e4', from: 'm', to: 'output' },
        ],
      },
      deps,
    );
    expect(v.issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});

/* ---- The executor, directly ------------------------------------------------------ */

function fakeRuntime(
  over: Partial<FlowRuntime> & { onCall?: (node: string) => ModelCallResult | Promise<ModelCallResult> },
): FlowRuntime {
  const events: RunEvent[] = [];
  const rt: FlowRuntime = {
    signal: new AbortController().signal,
    input: {
      text: 'Fix this bug in my Python function',
      threadId: null,
      notebookId: null,
      notebookTitle: null,
      workspaceId: 'w',
      messageId: 'msg_x',
      hasAttachment: false,
      branchDepth: 1,
    },
    model: (id) =>
      ({
        id,
        display_name: id,
        context_window: 32_000,
        price: { input_per_mtok: 0, output_per_mtok: 0 },
      }) as never,
    contextFor: () => ({ conversation: async () => [], sources: async () => '', memory: async () => '' }),
    call: async (_chain, req) => {
      const node = /Node:(\w+)/.exec(req.system ?? '')?.[1] ?? 'unknown';
      return (
        (await over.onCall?.(node)) ?? {
          text: `out:${node}`,
          reasoning: '',
          modelId: 'm',
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        }
      );
    },
    loadFlow: async () => undefined,
    emit: async (e) => {
      events.push(e as RunEvent);
    },
    speak: () => undefined,
    setAnswer: async () => undefined,
    save: async () => undefined,
    ...over,
  };
  return rt;
}

const chainGraph = (cap = 1): FlowGraph => ({
  settings: { ...settings, cost_cap_usd: cap },
  nodes: [...io, model('a', { role: 'Node:a' }), model('b', { role: 'Node:b' })],
  edges: [
    { id: 'e1', from: 'input', to: 'a' },
    { id: 'e2', from: 'a', to: 'b' },
    { id: 'e3', from: 'b', to: 'output' },
  ],
});

describe('the executor', () => {
  it('resumes after a crash without running finished nodes again', async () => {
    const state = initialFlowState({ id: 'f', name: 'F', version: 1, scope: 'workspace', ...chainGraph() });
    const calls: string[] = [];
    let crash = true;
    const rt = fakeRuntime({
      onCall: (node) => {
        calls.push(node);
        if (node === 'b' && crash) {
          crash = false;
          throw new Error('Core stopped');
        }
        return { text: `out:${node}`, reasoning: '', modelId: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    });
    await expect(executeFlow(state, rt)).rejects.toThrow('Core stopped');
    const saved = structuredClone(state);
    const out = await executeFlow(saved, rt);
    expect(out).toEqual({ kind: 'done', answer: 'out:b' });
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('stops at the cost cap and says so in the answer', async () => {
    const state = initialFlowState({
      id: 'f',
      name: 'Pricey',
      version: 1,
      scope: 'workspace',
      ...chainGraph(0.5),
    });
    const calls: string[] = [];
    const rt = fakeRuntime({
      onCall: (node) => {
        calls.push(node);
        return { text: `out:${node}`, reasoning: '', modelId: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0.6 };
      },
    });
    const out = await executeFlow(state, rt);
    expect(calls).toEqual(['a']);
    expect(state.stopped?.code).toBe('flow.budget');
    expect(out.kind === 'done' && out.answer).toMatch(/stopped early: It reached its cost cap of \$0\.50/);
  });

  it('runs a pinned node without calling its model', async () => {
    const g = chainGraph();
    (g.nodes[2] as Extract<FlowNode, { kind: 'model' }>).params.pinned_output = 'pinned A';
    const state = initialFlowState({ id: 'f', name: 'F', version: 1, scope: 'workspace', ...g });
    const calls: string[] = [];
    const rt = fakeRuntime({
      onCall: (node) => {
        calls.push(node);
        return { text: `out:${node}`, reasoning: '', modelId: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    });
    await executeFlow(state, rt);
    expect(calls).toEqual(['b']);
    expect(state.status.a).toBe('pinned');
  });

  it('skips a model with no key, and names the key when nothing else can answer', async () => {
    const g = chainGraph();
    for (const n of g.nodes.slice(2))
      (n as Extract<FlowNode, { kind: 'model' }>).params.fallbacks = ['spare/model'];
    const chains: string[][] = [];
    const rt = fakeRuntime({
      status: (m) => (m.id === 'offline/test' ? 'needs_key' : 'ready'),
      call: async (chain) => {
        chains.push(chain.map((m) => m.id));
        return { text: 'ok', reasoning: '', modelId: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    });
    await executeFlow(initialFlowState({ id: 'f', name: 'F', version: 1, scope: 'workspace', ...g }), rt);
    expect(chains[0]).toEqual(['spare/model']);

    const none = fakeRuntime({ status: () => 'needs_key' });
    const state = initialFlowState({ id: 'f', name: 'F', version: 1, scope: 'workspace', ...chainGraph() });
    await expect(executeFlow(state, none)).rejects.toMatchObject({ code: 'flow.model_unready' });
  });
});

/* ---- Through a chat turn ----------------------------------------------------------- */

describe('a chat turn through a flow', () => {
  it('routes a code request to the coder, live, and records why', async () => {
    h = await harness();
    await fromTemplate('tpl_router');
    const t = await h.newThread();
    const sent = await h.send(t, 'Write a Python function that reverses a list.');
    await h.settle(sent.run_id);
    const m = await lastAnswer(t);
    expect(m.status).toBe('complete');
    const f = flowOf(m);
    expect(f.decisions[0]).toMatchObject({ node_id: 'router', chose: ['code'] });
    expect(f.path).toContain('coder');
    expect(f.path).not.toContain('general');
    const evs = await h.eventsOf(sent.run_id);
    expect(evs.some((e) => e.type === 'flow.started')).toBe(true);
    expect(evs.some((e) => e.type === 'flow.decision' && e.chose.includes('code'))).toBe(true);
    expect(evs.some((e) => e.type === 'flow.node.started' && e.node_id === 'coder')).toBe(true);
    expect(evs.some((e) => e.type === 'flow.node.finished' && e.node_id === 'coder')).toBe(true);
    expect(h.text(evs).length).toBeGreaterThan(0);
    // The decision is kept for the heat-map.
    const d = await h.call<{ items: unknown[] }>('GET', `/flows/${f.flow_id}/decisions?node=router`);
    expect(d.body.items).toHaveLength(1);
  });

  it('lets a manager hand work to its planner and coder, then answer', async () => {
    h = await harness();
    await fromTemplate('tpl_manager');
    const t = await h.newThread();
    const sent = await h.send(t, 'Add a retry to the upload script.');
    await h.settle(sent.run_id);
    const f = flowOf(await lastAnswer(t));
    const ran = f.steps.map((s) => s.node_id);
    expect(ran).toEqual(expect.arrayContaining(['planner', 'coder', 'manager']));
    expect(ran.indexOf('planner')).toBeLessThan(ran.indexOf('coder'));
    const text = ((await lastAnswer(t)).parts.find((p) => p.type === 'text') as { text: string }).text;
    expect(text).toContain('Here is what the team produced');
  });

  it('runs two answers side by side and lets a judge pick one', async () => {
    h = await harness();
    await fromTemplate('tpl_parallel_judge');
    const t = await h.newThread();
    const sent = await h.send(t, 'Explain what a heat pump does.');
    await h.settle(sent.run_id);
    const f = flowOf(await lastAnswer(t));
    expect(f.path).toEqual(expect.arrayContaining(['a', 'b', 'judge']));
    expect(f.decisions.find((d) => d.node_id === 'judge')?.chose).toHaveLength(1);
  });

  it('gives a "plan only" worker none of the conversation', async () => {
    h = await harness();
    const graph: FlowGraph = {
      settings,
      nodes: [...io, model('a', { role: 'Planner role' }), model('b', { role: 'Worker role' })],
      edges: [
        { id: 'e1', from: 'input', to: 'a' },
        {
          id: 'e2',
          from: 'a',
          to: 'b',
          context: {
            conversation: { mode: 'none' },
            sources: { mode: 'none' },
            memory: 'none',
            upstream: 'plan',
          },
        },
        { id: 'e3', from: 'b', to: 'output' },
      ],
    };
    await h.call('POST', '/flows', { name: 'Plan only', scope: 'workspace', activate: true, ...graph });
    const t = await h.newThread();
    const first = await h.send(t, '/say An earlier turn.');
    await h.settle(first.run_id);
    const second = await h.send(t, 'Now the real question.', { parent_id: first.assistant_message_id });
    await h.settle(second.run_id);
    const toB = h.provider.calls.filter((c) => c.req.system?.startsWith('Worker role')).at(-1);
    expect(toB).toBeDefined();
    expect(toB?.req.messages).toHaveLength(1);
    expect(toB?.req.messages[0]?.content).not.toContain('An earlier turn');
    const toA = h.provider.calls.filter((c) => c.req.system?.startsWith('Planner role')).at(-1);
    expect(toA?.req.messages.length).toBeGreaterThan(1);
  });

  it('regenerates on the same route, or decides again', async () => {
    h = await harness();
    await fromTemplate('tpl_router');
    const t = await h.newThread();
    const sent = await h.send(t, 'Write a SQL query for monthly totals.');
    await h.settle(sent.run_id);
    const same = await h.call<{ run_id: string }>(
      'POST',
      `/messages/${sent.assistant_message_id}/regenerate`,
      { route: 'same' },
    );
    await h.settle(same.body.run_id);
    const fSame = flowOf(await lastAnswer(t));
    expect(fSame.decisions[0]?.reason).toMatch(/same route/i);
    expect(fSame.decisions[0]?.chose).toEqual(['code']);
    const again = await h.call<{ run_id: string }>(
      'POST',
      `/messages/${sent.assistant_message_id}/regenerate`,
      { route: 'again' },
    );
    await h.settle(again.body.run_id);
    const fAgain = flowOf(await lastAnswer(t));
    expect(fAgain.decisions[0]?.reason).not.toMatch(/same route/i);
  });

  it('follows message, thread, notebook and workspace in that order, and "off"', async () => {
    h = await harness();
    const ws = await fromTemplate('tpl_single');
    const nb = await fromTemplate('tpl_critique', 'notebook', 'nbk_pumps');
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const resolve = async () =>
      (await h.call<{ flow: Flow | null; from: string }>('GET', `/flows/resolve?thread_id=${t}`)).body;
    expect((await resolve()).flow?.id).toBe(nb.id);
    expect((await resolve()).flow?.nodes.length).toBeGreaterThan(0);
    await h.call('PATCH', `/threads/${t}`, { flow_id: ws.id });
    expect(await resolve()).toMatchObject({ from: 'thread' });
    expect((await resolve()).flow?.id).toBe(ws.id);
    await h.call('PATCH', `/threads/${t}`, { flow_id: 'off' });
    expect((await resolve()).flow).toBeNull();
    // @flow on the message beats everything.
    const sent = await h.send(t, 'Hello there', { flow_id: nb.id });
    await h.settle(sent.run_id);
    expect(flowOf(await lastAnswer(t)).flow_id).toBe(nb.id);
  });

  it('reruns from a step with another model, keeping the steps before it', async () => {
    h = await harness();
    const flow = await fromTemplate('tpl_critique');
    const t = await h.newThread();
    const sent = await h.send(t, 'Write two lines about autumn.');
    await h.settle(sent.run_id);
    const before = h.provider.calls.length;
    const r = await h.call<{ run_id: string; assistant_message_id: string }>(
      'POST',
      `/messages/${sent.assistant_message_id}/route-again`,
      { from_node: 'revise', model: 'offline/echo' },
    );
    expect(r.status).toBe(202);
    await h.settle(r.body.run_id);
    const f = flowOf(await lastAnswer(t));
    expect(f.flow_id).toBe(flow.id);
    expect(f.steps.find((s) => s.node_id === 'draft')?.status).toBe('cached');
    expect(f.steps.find((s) => s.node_id === 'revise')?.model_id).toBe('offline/echo');
    // Only the revise step called a model this time.
    expect(h.provider.calls.length - before).toBe(1);
  });
});

/* ---- Routes ------------------------------------------------------------------------- */

describe('flow routes', () => {
  it('saves versions, refuses a stale save, publishes and restores', async () => {
    h = await harness();
    const f = await fromTemplate('tpl_single');
    const save = (base: number, name: string) =>
      h.call<Flow>('PUT', `/flows/${f.id}`, {
        name,
        description: '',
        base_version: base,
        nodes: f.nodes,
        edges: f.edges,
        settings: f.settings,
      });
    expect((await save(1, 'Two')).body.version).toBe(2);
    expect((await save(1, 'Stale')).status).toBe(409);
    const versions = await h.call<{ items: { version: number }[] }>('GET', `/flows/${f.id}/versions`);
    expect(versions.body.items.map((v) => v.version)).toEqual([2, 1]);
    const v1 = await h.call<Flow>('GET', `/flows/${f.id}/versions/1`);
    expect(v1.body.name).toBe('tpl_single');
    await h.call('POST', `/flows/${f.id}/publish`, { version: 1 });
    expect((await h.call<Flow>('GET', `/flows/${f.id}`)).body.published_version).toBe(1);
    const restored = await h.call<Flow>('POST', `/flows/${f.id}/restore`, { version: 1 });
    expect(restored.body).toMatchObject({ version: 3, name: 'tpl_single' });
  });

  it('exports YAML and imports it back', async () => {
    h = await harness();
    const f = await fromTemplate('tpl_router');
    const res = await h.app.request(`/api/v1/flows/${f.id}/export`);
    const yaml = await res.text();
    expect(yaml).toContain('router');
    const imported = await h.call<Flow>('POST', '/flows/import', { yaml });
    expect(imported.status).toBe(201);
    expect(imported.body.nodes.map((n) => n.id).sort()).toEqual(f.nodes.map((n) => n.id).sort());
  });

  it('tries a message without writing to a thread, and runs one node alone', async () => {
    h = await harness();
    const f = await fromTemplate('tpl_router');
    const tried = await h.call<{ run_id: string; message_id: string }>('POST', '/flows/try', {
      text: 'Solve 2x + 3 = 11',
      flow_id: f.id,
      mock: true,
    });
    expect(tried.status).toBe(202);
    await h.settle(tried.body.run_id);
    const evs = await h.eventsOf(tried.body.run_id);
    const decision = evs.find((e) => e.type === 'flow.decision');
    expect(decision && 'chose' in decision && decision.chose).toEqual(['maths']);
    expect(evs.some((e) => e.type === 'done')).toBe(true);

    const run = await h.call<{ output: string; payload: unknown }>(
      'POST',
      `/flows/${f.id}/nodes/general/run`,
      {
        input: 'Say hello',
        mock: true,
      },
    );
    expect(run.status).toBe(200);
    expect(run.body.output.length).toBeGreaterThan(0);
    const last = await h.call<{ output: string }>('GET', `/flows/${f.id}/nodes/general/last`);
    expect(last.body.output).toBe(run.body.output);
  });

  it('estimates what crosses each edge', async () => {
    h = await harness();
    const r = await h.call<{ edges: { node_id: string; total: number; over: boolean }[] }>(
      'POST',
      '/flows/estimate-context',
      {
        graph: {
          settings,
          nodes: [...io, model('a'), model('b')],
          edges: [
            { id: 'e1', from: 'input', to: 'a' },
            {
              id: 'e2',
              from: 'a',
              to: 'b',
              context: {
                conversation: { mode: 'none' },
                sources: { mode: 'none' },
                memory: 'none',
                upstream: 'plan',
              },
            },
            { id: 'e3', from: 'b', to: 'output' },
          ],
        },
      },
    );
    expect(r.status).toBe(200);
    const a = r.body.edges.find((e) => e.node_id === 'a');
    const b = r.body.edges.find((e) => e.node_id === 'b');
    expect((a?.total ?? 0) > (b?.total ?? 0)).toBe(true);
  });

  it('will not activate a flow with problems', async () => {
    h = await harness();
    const bad = await h.call<Flow>('POST', '/flows', {
      name: 'Broken',
      scope: 'workspace',
      nodes: [...io, model('a', { model: 'nope/model' })],
      edges: [
        { id: 'e1', from: 'input', to: 'a' },
        { id: 'e2', from: 'a', to: 'output' },
      ],
    });
    expect(bad.status).toBe(201);
    const on = await h.call<{ error: { code: string } }>('POST', `/flows/${bad.body.id}/activate`, {
      on: true,
    });
    expect(on.status).toBe(422);
    expect(on.body.error.code).toBe('flow.invalid');
  });
});

/* ---- Tools on model nodes ------------------------------------------------------------ */

describe('a model node with tools', () => {
  const toolFlow = (tools: string[]) => ({
    name: 'With tools',
    scope: 'workspace',
    activate: true,
    settings,
    nodes: [...io, model('worker', { tools, role: 'You may use tools.' })],
    edges: [
      { id: 'e1', from: 'input', to: 'worker' },
      { id: 'e2', from: 'worker', to: 'output' },
    ],
  });

  it('calls a listed tool, feeds the result back and records the call', async () => {
    h = await harness();
    expect((await h.call('POST', '/flows', toolFlow(['fs_list']))).status).toBe(201);
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_list {"path":"/workspace"}');
    await h.settle(sent.run_id);
    const m = await lastAnswer(t);
    expect(m.status).toBe('complete');
    const step = flowOf(m).steps.find((s) => s.node_id === 'worker');
    expect(step?.tool_calls?.[0]).toMatchObject({ tool: 'fs_list', ok: true });
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
    expect(text).toContain('The tool finished');
    const evs = await h.eventsOf(sent.run_id);
    expect(evs.some((e) => e.type === 'tool.call' && e.node_id === 'worker')).toBe(true);
    expect(evs.some((e) => e.type === 'tool.result' && e.node_id === 'worker' && e.ok)).toBe(true);
    // The model was offered only its listed tool.
    const offered = h.provider.calls.find((c) => c.req.system?.startsWith('You may use tools.'))?.req.tools;
    expect(offered?.map((d) => d.name)).toEqual(['fs_list']);
  });

  it('pauses for a gated tool and carries on once you approve, without running it twice', async () => {
    h = await harness();
    await h.call('POST', '/flows', toolFlow(['fs_write']));
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"notes/flow.md","content":"from a flow"}');
    expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
    const ask = (await h.eventsOf(sent.run_id)).find((e) => e.type === 'approval.required');
    expect(ask && 'approval_id' in ask).toBe(true);
    // A restart while waiting changes nothing.
    await h.restart();
    const ok = await h.call('POST', `/approvals/${(ask as { approval_id: string }).approval_id}`, {
      decision: 'approve',
      scope: 'once',
    });
    expect(ok.status).toBe(200);
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const m = await lastAnswer(t);
    const step = flowOf(m).steps.find((s) => s.node_id === 'worker');
    expect(step?.tool_calls?.[0]).toMatchObject({ tool: 'fs_write', ok: true });
    expect(await readFile(join(h.workspace.dir, 'notes/flow.md'), 'utf8')).toBe('from a flow');
    const writes = (await h.eventsOf(sent.run_id)).filter(
      (e) => e.type === 'tool.result' && e.node_id === 'worker',
    );
    expect(writes).toHaveLength(1);
  });

  it('refuses a tool the node was not given, without asking or running it', async () => {
    h = await harness();
    await h.call('POST', '/flows', toolFlow(['fs_list']));
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"notes/nope.md","content":"x"}');
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const m = await lastAnswer(t);
    const step = flowOf(m).steps.find((s) => s.node_id === 'worker');
    expect(step?.tool_calls?.[0]).toMatchObject({ tool: 'fs_write', ok: false, refused: true });
    expect([...h.perms.approvals.values()]).toHaveLength(0);
    await expect(readFile(join(h.workspace.dir, 'notes/nope.md'), 'utf8')).rejects.toThrow();
  });
});
