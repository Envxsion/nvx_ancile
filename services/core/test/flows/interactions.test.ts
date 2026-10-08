/**
 * How a model choice and a flow interact (DESIGN.md §16.3, "Interactions"):
 * a model chosen for one message answers instead of any flow; a thread's
 * model answers only when no flow does; "off" pauses the flow and says
 * which; regenerate repeats how the reply was made; and every answer
 * records its route in provenance.route.
 */

import type { AnswerRoute, Flow, FlowProvenance, Message, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { validateFlow } from '../../src/flows/validate';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

async function lastAnswer(threadId: string): Promise<Message> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  return path.messages.at(-1) as Message;
}
const flowOf = (m: Message) => (m.provenance as { flow?: FlowProvenance }).flow;
const routeOf = (m: Message) => (m.provenance as { route?: AnswerRoute }).route;

async function notebookFlow(tpl = 'tpl_single') {
  const r = await h.call<Flow>('POST', '/flows', {
    name: 'Pumps flow',
    from: tpl,
    scope: 'notebook',
    scope_ref: 'nbk_pumps',
    activate: true,
  });
  expect(r.status).toBe(201);
  return r.body;
}

async function answer(threadId: string, text: string, extra: Record<string, unknown> = {}) {
  const sent = await h.send(threadId, text, extra);
  await h.settle(sent.run_id);
  return { sent, m: await lastAnswer(threadId) };
}

describe('a model choice and a flow', () => {
  it('a notebook flow answers, and the answer says the notebook chose it', async () => {
    h = await harness();
    const f = await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const { m } = await answer(t, 'Hello');
    expect(flowOf(m)?.flow_id).toBe(f.id);
    expect(routeOf(m)).toMatchObject({ kind: 'flow', from: 'notebook', flow_id: f.id });
  });

  it('a thread model does not override the notebook flow', async () => {
    h = await harness();
    const f = await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps', model: 'offline/echo' });
    const { m } = await answer(t, 'Hello');
    expect(flowOf(m)?.flow_id).toBe(f.id);
  });

  it('a model picked for one message answers instead of the flow, and names the flow it set aside', async () => {
    h = await harness();
    const f = await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const { m } = await answer(t, 'Just this once', { model: 'offline/echo' });
    expect(flowOf(m)).toBeUndefined();
    expect(m.model_id).toBe('offline/echo');
    expect(routeOf(m)).toMatchObject({
      kind: 'model',
      from: 'message',
      model_id: 'offline/echo',
      skipped_flow: { flow_id: f.id, from: 'notebook', because: 'message_model' },
    });
    // The next message goes back to the flow.
    const next = await answer(t, 'And now');
    expect(flowOf(next.m)?.flow_id).toBe(f.id);
  });

  it('@flow on the message beats a model picked for it', async () => {
    h = await harness();
    const f = await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const { m } = await answer(t, 'Both', { model: 'offline/echo', flow_id: f.id });
    expect(flowOf(m)?.flow_id).toBe(f.id);
    expect(routeOf(m)).toMatchObject({ kind: 'flow', from: 'message' });
  });

  it('"this thread instead of the flow" pauses it, says which, and can be undone', async () => {
    h = await harness();
    const f = await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    await h.call('PATCH', `/threads/${t}`, { model: 'offline/echo', flow_id: 'off' });
    const resolved = (
      await h.call<{ flow: Flow | null; from: string; paused?: { id: string; from: string } | null }>(
        'GET',
        `/flows/resolve?thread_id=${t}`,
      )
    ).body;
    expect(resolved.flow).toBeNull();
    expect(resolved.paused).toMatchObject({ id: f.id, from: 'notebook' });
    const { m } = await answer(t, 'Plain please');
    expect(m.model_id).toBe('offline/echo');
    expect(routeOf(m)).toMatchObject({
      kind: 'model',
      from: 'thread',
      skipped_flow: { flow_id: f.id, because: 'thread_paused' },
    });
    // Back to the flow.
    await h.call('PATCH', `/threads/${t}`, { flow_id: null });
    const back = await answer(t, 'Flow again');
    expect(flowOf(back.m)?.flow_id).toBe(f.id);
  });

  it('with no flow anywhere, the answer records the default or the thread model', async () => {
    h = await harness();
    const t = await h.newThread();
    const { m } = await answer(t, 'Hi');
    expect(routeOf(m)).toMatchObject({ kind: 'model', from: 'default' });
    expect(routeOf(m)?.skipped_flow).toBeUndefined();
    await h.call('PATCH', `/threads/${t}`, { model: 'offline/echo' });
    const second = await answer(t, 'Again');
    expect(routeOf(second.m)).toMatchObject({ kind: 'model', from: 'thread', model_id: 'offline/echo' });
  });
});

describe('@-mentioned sources inside a flow', () => {
  it('a Retrieve node with no sources of its own searches only the mentioned ones', async () => {
    const seen: (string[] | undefined)[] = [];
    h = await harness({
      retriever: {
        search: async ({ sourceIds }) => {
          seen.push(sourceIds);
          return { hits: [], mode: 'hybrid', embedder: 'test', ms: 1 } as never;
        },
      },
    });
    const f = await h.call<Flow>('POST', '/flows', {
      name: 'Search first',
      scope: 'notebook',
      scope_ref: 'nbk_pumps',
      activate: true,
      nodes: [
        { id: 'input', kind: 'input', position: { x: 0, y: 0 }, params: {} },
        { id: 'find', kind: 'retrieve', position: { x: 200, y: 0 }, params: {} },
        {
          id: 'answer',
          kind: 'model',
          position: { x: 400, y: 0 },
          params: { model: 'offline/test', speaks: true },
        },
        { id: 'output', kind: 'output', position: { x: 600, y: 0 }, params: { template: '' } },
      ],
      edges: [
        { id: 'e1', from: 'input', to: 'find' },
        { id: 'e2', from: 'find', to: 'answer' },
        { id: 'e3', from: 'answer', to: 'output' },
      ],
    });
    expect(f.status).toBe(201);
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const { m } = await answer(t, 'Pump speed?', { mentions: [{ kind: 'source', id: 'src_pumps' }] });
    expect(flowOf(m)?.flow_id).toBe(f.body.id);
    // The turn's own retrieval and the Retrieve node both stay inside the mention.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const ids of seen) expect(ids).toEqual(['src_pumps']);
  });
});

describe('a thread model that can no longer answer', () => {
  it('is passed over, not a reason to refuse the message, and the answer says so', async () => {
    h = await harness();
    const t = await h.newThread();
    await h.repo.patchThread(t, { settings: { model: 'gone/model' } });
    const { m } = await answer(t, 'Still there?');
    expect(m.status).toBe('complete');
    expect(routeOf(m)).toMatchObject({ kind: 'model', from: 'default', thread_model_unready: 'gone/model' });
  });

  it('a model picked for one message must still be able to answer', async () => {
    h = await harness();
    const t = await h.newThread();
    const r = await h.call('POST', `/threads/${t}/messages`, {
      parent_id: null,
      parts: [{ type: 'text', text: 'hi' }],
      model: 'gone/model',
    });
    expect(r.status).toBe(404);
  });
});

describe('a thread’s step overrides', () => {
  it('apply to the flow they were made for, and not to another flow with the same step', async () => {
    h = await harness();
    const nbFlow = await notebookFlow();
    await h.call<Flow>('POST', '/flows', {
      name: 'Workspace flow',
      from: 'tpl_single',
      scope: 'workspace',
      scope_ref: null,
      activate: true,
    });
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    await h.call('PATCH', `/threads/${t}`, {
      flow_overrides: { answer: { model: 'offline/echo' } },
      flow_overrides_flow: nbFlow.id,
    });
    const here = await answer(t, 'In the notebook');
    expect(here.m.model_id).toBe('offline/echo');
    // Out of the notebook: the workspace flow answers, with its own choice.
    await h.call('PATCH', `/threads/${t}`, { notebook_id: null });
    const there = await answer(t, 'Out of it');
    expect(flowOf(there.m)?.flow_id).not.toBe(nbFlow.id);
    expect(there.m.model_id).toBe('offline/test');
  });
});

describe('deleting a flow’s home', () => {
  it('keeps a deleted thread’s own flow as an inactive workspace draft', async () => {
    h = await harness();
    const t = await h.newThread();
    const f = (
      await h.call<Flow>('POST', '/flows', {
        name: 'Thread flow',
        from: 'tpl_single',
        scope: 'thread',
        scope_ref: t,
        activate: true,
      })
    ).body;
    expect((await h.call('DELETE', `/threads/${t}`)).status).toBe(204);
    const kept = (await h.call<Flow>('GET', `/flows/${f.id}`)).body;
    expect(kept).toMatchObject({ scope: 'workspace', scope_ref: null, active: false });
    // Never the workspace default by accident.
    expect((await h.flowStore.activeFor('workspace', null))?.id).not.toBe(f.id);
  });

  it('keeps a deleted notebook’s flows the same way', async () => {
    h = await harness();
    const f = await notebookFlow();
    const moved = await h.flowStore.orphan('notebook', 'nbk_pumps');
    expect(moved.map((m) => m.id)).toEqual([f.id]);
    expect(await h.flowStore.activeFor('notebook', 'nbk_pumps')).toBeUndefined();
    expect((await h.flowStore.get(f.id))?.scope).toBe('workspace');
  });
});

describe('regenerate', () => {
  it('a flow reply regenerates through its flow, even with a thread model set', async () => {
    h = await harness();
    const f = await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps', model: 'offline/echo' });
    const { sent } = await answer(t, 'Hello');
    const r = await h.call<{ run_id: string }>(
      'POST',
      `/messages/${sent.assistant_message_id}/regenerate`,
      {},
    );
    await h.settle(r.body.run_id);
    expect(flowOf(await lastAnswer(t))?.flow_id).toBe(f.id);
  });

  it('with a model chosen, a flow reply regenerates as that model alone', async () => {
    h = await harness();
    await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const { sent } = await answer(t, 'Hello');
    const r = await h.call<{ run_id: string }>('POST', `/messages/${sent.assistant_message_id}/regenerate`, {
      model: 'offline/echo',
    });
    await h.settle(r.body.run_id);
    const m = await lastAnswer(t);
    expect(flowOf(m)).toBeUndefined();
    expect(m.model_id).toBe('offline/echo');
  });

  it('a reply whose flow was deleted regenerates the way the thread answers now', async () => {
    h = await harness();
    const f = await notebookFlow();
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const { sent } = await answer(t, 'Hello');
    expect((await h.call('DELETE', `/flows/${f.id}`)).status).toBeLessThan(300);
    for (const route of ['again', 'same'] as const) {
      const r = await h.call<{ run_id: string }>(
        'POST',
        `/messages/${sent.assistant_message_id}/regenerate`,
        { route },
      );
      await h.settle(r.body.run_id);
      const m = await lastAnswer(t);
      expect(m.status).toBe('complete');
      expect(flowOf(m)).toBeUndefined();
    }
  });

  it('a plain reply regenerates with the model it asked for, not the notebook flow added since', async () => {
    h = await harness();
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const { sent } = await answer(t, 'Hello', { model: 'offline/echo' });
    await notebookFlow();
    const r = await h.call<{ run_id: string }>(
      'POST',
      `/messages/${sent.assistant_message_id}/regenerate`,
      {},
    );
    await h.settle(r.body.run_id);
    const m = await lastAnswer(t);
    expect(flowOf(m)).toBeUndefined();
    expect(m.model_id).toBe('offline/echo');
  });
});

describe('a GPU step with nothing to fall back to', () => {
  const deps = {
    model: (id: string) =>
      ({
        id,
        display_name: id,
        via: id.startsWith('node/') ? 'controller' : 'direct',
        price: { input_per_mtok: 0, output_per_mtok: 0 },
      }) as never,
    status: () => 'ready' as const,
    tool: () => true,
    flowExists: () => true,
  };
  const graph = (fallbacks: string[]) => ({
    nodes: [
      { id: 'input', kind: 'input', position: { x: 0, y: 0 }, params: {} },
      {
        id: 'coder',
        kind: 'model',
        label: 'Coder',
        position: { x: 0, y: 0 },
        params: { model: 'node/qwen', fallbacks, tools: [] },
      },
      { id: 'output', kind: 'output', position: { x: 0, y: 0 }, params: { template: '' } },
    ],
    edges: [
      { id: 'e1', from: 'input', to: 'coder' },
      { id: 'e2', from: 'coder', to: 'output' },
    ],
  });
  it('is flagged, because "Use a cloud model instead" cannot be offered for it', () => {
    const codes = (f: string[]) => validateFlow(graph(f) as never, deps as never).issues.map((i) => i.code);
    expect(codes([])).toContain('flow.gpu_no_fallback');
    expect(codes(['node/llama'])).toContain('flow.gpu_no_fallback');
    expect(codes(['anthropic/claude-sonnet-5-5'])).not.toContain('flow.gpu_no_fallback');
  });
});
