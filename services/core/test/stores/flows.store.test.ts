/**
 * Flows (DESIGN.md §16): versions, publishing, one active flow per scope,
 * orphaning, route decisions and node runs, from both backends.
 */
import { type FlowGraph, type FlowNode, ModelParams } from '@nvx/contracts';
import { beforeEach, expect, it } from 'vitest';
import { type FlowStore, MemoryFlowStore, PgFlowStore } from '../../src/flows/store';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { eachBackend, uid } from '../support/stores';

const model = (id: string): FlowNode => ({
  id,
  kind: 'model',
  position: { x: 200, y: 0 },
  params: ModelParams.parse({ model: 'offline/test' }),
});

const graph = (extra: FlowNode[] = []): FlowGraph =>
  ({
    nodes: [
      { id: 'input', kind: 'input', position: { x: 0, y: 0 }, params: {} },
      model('a'),
      ...extra,
      { id: 'output', kind: 'output', position: { x: 400, y: 0 }, params: { template: '' } },
    ],
    edges: [
      { id: 'e1', from: 'input', to: 'a' },
      { id: 'e2', from: 'a', to: 'output' },
    ],
    settings: { max_steps: 12, cost_cap_usd: 1, timeout_s: 120, show_teamwork: 'collapsed' },
  }) as FlowGraph;

eachBackend('flow store', (backend) => {
  let flows: FlowStore;
  let threads: ThreadRepo;
  let ws: string;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    flows = b.sql ? new PgFlowStore(b.sql, ws) : new MemoryFlowStore();
    threads = b.sql ? new PgThreadRepo(b.sql) : new MemoryThreadRepo();
  });

  const newFlow = (
    scope: 'workspace' | 'notebook' | 'thread' = 'thread',
    ref: string | null = uid('thr'),
    active = false,
  ) =>
    flows.create({
      name: `Flow ${uid('f')}`,
      description: 'For the contract test',
      scope,
      scope_ref: ref,
      graph: graph(),
      active,
    });

  it('creates a draft, saves new versions only from the latest, and keeps its history', async () => {
    const f = await newFlow();
    expect(f).toMatchObject({ version: 1, active: false });
    expect((await flows.get(f.id))?.name).toBe(f.name);

    const v2 = await flows.save(
      f.id,
      { name: f.name, description: 'Now with a second model', graph: graph([model('b')]), message: 'Add b' },
      1,
    );
    expect(v2.version).toBe(2);
    await expect(
      flows.save(f.id, { name: f.name, description: 'stale', graph: graph(), message: null }, 1),
    ).rejects.toBeTruthy();

    expect((await flows.versions(f.id)).map((v) => v.version).sort()).toEqual([1, 2]);
    expect((await flows.getVersion(f.id, 1))?.nodes.map((n) => n.id)).not.toContain('b');
    expect((await flows.getVersion(f.id, 2))?.nodes.map((n) => n.id)).toContain('b');
  });

  it('answers with the published version, and the latest until something is published', async () => {
    const f = await newFlow();
    await flows.save(f.id, { name: f.name, description: 'v2', graph: graph([model('b')]), message: null }, 1);
    expect((await flows.getLive(f.id))?.version).toBe(2);
    const published = await flows.publish(f.id, 1);
    expect(published.published_version).toBe(1);
    expect((await flows.getLive(f.id))?.nodes.map((n) => n.id)).not.toContain('b');
    await flows.publish(f.id, null);
    expect((await flows.getLive(f.id))?.version).toBe(2);
  });

  it('keeps one active flow per scope, finds it, and lists by scope', async () => {
    const ref = uid('thr');
    const a = await newFlow('thread', ref, true);
    const b = await newFlow('thread', ref);
    expect((await flows.activeFor('thread', ref))?.id).toBe(a.id);
    await flows.activate(b.id, true);
    expect((await flows.activeFor('thread', ref))?.id).toBe(b.id);
    expect((await flows.get(a.id))?.active).toBe(false);
    await flows.activate(b.id, false);
    expect(await flows.activeFor('thread', ref)).toBeUndefined();

    const listed = await flows.list({ scope: 'thread', ref });
    expect(listed.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('keeps a flow whose home was deleted as an inactive workspace draft, and removes on request', async () => {
    const ref = uid('nbk');
    const f = await newFlow('notebook', ref, true);
    const moved = await flows.orphan('notebook', ref);
    expect(moved.map((x) => x.id)).toEqual([f.id]);
    expect(await flows.get(f.id)).toMatchObject({ scope: 'workspace', scope_ref: null, active: false });

    expect(await flows.remove(f.id)).toBe(true);
    expect(await flows.get(f.id)).toBeUndefined();
    expect(await flows.remove(f.id)).toBe(false);
  });

  it('records route decisions with labels, and the last run of a node', async () => {
    const f = await newFlow();
    const thread = uid('thr');
    await threads.createThread({ id: thread, workspace_id: ws });
    const msg = await threads.insertMessage({
      id: uid('msg'),
      thread_id: thread,
      parent_id: null,
      role: 'assistant',
      parts: [],
      status: 'complete',
      trace_id: '5'.repeat(32),
    });
    const decision = {
      message_id: msg.id,
      thread_id: thread,
      flow_id: f.id,
      version: 1,
      node_id: 'router',
      chose: ['code'],
      confidence: 0.62,
    };
    await flows.recordDecision(decision);
    await flows.recordDecision({ ...decision, chose: ['maths'], scores: { code: 0.4, maths: 0.6 } });
    const ds = await flows.decisions({ flowId: f.id });
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ chose: ['maths'], label: null });
    expect(await flows.labelDecision(msg.id, 'router', 'code')).toBe(true);
    expect((await flows.decisions({ flowId: f.id, nodeId: 'router' }))[0]?.label).toBe('code');
    expect(await flows.labelDecision(msg.id, 'nobody', 'x')).toBe(false);

    await flows.recordNodeRun({
      flow_id: f.id,
      node_id: 'a',
      payload: { text: 'hi' },
      output: 'first',
      meta: {},
    });
    await flows.recordNodeRun({
      flow_id: f.id,
      node_id: 'a',
      payload: { text: 'hi' },
      output: 'second',
      meta: { ms: 4 },
    });
    expect((await flows.lastNodeRun(f.id, 'a'))?.output).toBe('second');
    expect(await flows.lastNodeRun(f.id, 'b')).toBeUndefined();
  });
});
