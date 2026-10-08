/**
 * The public half of Pro's answer features (DESIGN.md §9): what Core lends
 * (services/core/src/pro/answers.ts) and the two places Pro may take part
 * in answering. No Pro code runs here: these are Core's own guarantees.
 */
import type { Flow, FlowProvenance, Message, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { proAnswers } from '../../src/pro/answers';
import { type Harness, harness, WORKSPACE_ID } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const answers = () =>
  proAnswers({
    workspaceId: WORKSPACE_ID,
    repo: h.repo,
    runs: h.runs,
    worker: h.worker,
    registry: h.registry,
    gateway: h.flows.deps.gateway,
    flows: h.flows,
    flowStore: h.flowStore,
    notebooks: { list: async () => [] },
    pollMs: 10,
  });

async function routerFlow(): Promise<Flow> {
  const r = await h.call<Flow>('POST', '/flows', {
    name: 'router',
    from: 'tpl_router',
    scope: 'workspace',
    scope_ref: null,
    activate: true,
  });
  expect(r.status).toBe(201);
  return r.body;
}

describe('what Core lends Pro', () => {
  it('runs answers side by side on one question, each keeping what its caller recorded', async () => {
    h = await harness();
    const a = answers();
    const t = await h.newThread();
    const first = await h.send(t, 'Name a colour.');
    await h.settle(first.run_id);
    const one = await a.turns.start({
      threadId: t,
      user: { existingId: first.user_message_id },
      model: 'offline/test',
      detached: true,
      instructions: 'Answer in one word.',
      provenanceExtra: { beam: { beam_id: 'bm_1', role: 'candidate', label: 'A' } },
    });
    // A second answer starts while the first is still queued: detached runs do not hold the thread.
    const two = await a.turns.start({
      threadId: t,
      user: { existingId: first.user_message_id },
      model: 'offline/echo',
      detached: true,
      provenanceExtra: { beam: { beam_id: 'bm_1', role: 'candidate', label: 'B' } },
    });
    expect((await a.turns.wait(one.run_id)).status).toBe('succeeded');
    expect((await a.turns.wait(two.run_id)).status).toBe('succeeded');
    const m1 = await a.threads.message(one.assistant_message_id);
    const m2 = await a.threads.message(two.assistant_message_id);
    expect(m1?.parent_id).toBe(first.user_message_id);
    expect(m2?.parent_id).toBe(first.user_message_id);
    expect(m1?.provenance.beam).toMatchObject({ beam_id: 'bm_1', label: 'A' });
    expect(m2?.provenance.beam).toMatchObject({ label: 'B' });
    expect(m1?.text.length).toBeGreaterThan(0);
    // The path runs from the root to the message asked for.
    expect((await a.threads.path(one.assistant_message_id)).map((m) => m.id)).toEqual([
      first.user_message_id,
      one.assistant_message_id,
    ]);
  });

  it('answers once without saving anything, with its cost and time', async () => {
    h = await harness();
    const a = answers();
    const out = await a.models.complete('offline/test', { prompt: 'Say hello.' });
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.model_id).toBe('offline/test');
    expect(out.ms).toBeGreaterThanOrEqual(0);
    expect(a.models.list().some((m) => m.id === 'offline/test' && m.ready)).toBe(true);
  });

  it('runs a flow once off the record: no message, no decision', async () => {
    h = await harness();
    const a = answers();
    const f = await routerFlow();
    const t = await h.newThread({ settings: { flow_id: 'off' } });
    const before = (await h.repo.messages(t)).length;
    const out = await a.flows.runOnce({
      flowId: f.id,
      text: 'Write a Python function that reverses a list.',
      threadId: t,
      signal: AbortSignal.timeout(10_000),
    });
    expect(out.error).toBeUndefined();
    expect(out.answer.length).toBeGreaterThan(0);
    expect(out.path).toContain('router');
    expect((await h.repo.messages(t)).length).toBe(before);
    expect(await a.flows.decisions(f.id)).toEqual([]);
  });
});

describe('where Pro may take part in answering', () => {
  it('a confident route hint decides without asking the router model, and says so', async () => {
    h = await harness();
    await routerFlow();
    const asked: string[] = [];
    h.flows.deps.routeHint = async (q) => {
      asked.push(q.text);
      return { label: 'general', confidence: 0.93, reason: 'Like requests you sent to general before.' };
    };
    const t = await h.newThread();
    const sent = await h.send(t, 'Write a Python function that reverses a list.');
    await h.settle(sent.run_id);
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    const m = path.messages.at(-1) as Message;
    const flow = (m.provenance as { flow: FlowProvenance }).flow;
    expect(asked).toEqual(['Write a Python function that reverses a list.']);
    expect(flow.decisions[0]).toMatchObject({
      node_id: 'router',
      chose: ['general'],
      reason: 'Like requests you sent to general before.',
    });
    expect(flow.path).toContain('general');
  });

  it('a hint for a route the router does not have is ignored', async () => {
    h = await harness();
    await routerFlow();
    h.flows.deps.routeHint = async () => ({ label: 'poetry', confidence: 1, reason: 'no' });
    const t = await h.newThread();
    const sent = await h.send(t, 'Write a Python function that reverses a list.');
    await h.settle(sent.run_id);
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    const flow = ((path.messages.at(-1) as Message).provenance as { flow: FlowProvenance }).flow;
    expect(flow.decisions[0]?.chose).toEqual(['code']);
  });
});
