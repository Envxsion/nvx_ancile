/**
 * The data plane (ROADMAP Phase 5): a request for a node that is asleep is
 * recorded, wakes the node once, and either answers 503 node_waking with
 * Retry-After, or (x-controller-wait) is held until the node is up and then
 * answered. The cost cap answers 402 so Core falls back to the cloud.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { register, seedSampleNodes } from '../../src/nodes';
import { FAKE_SCHEME, FakeProvider } from '../../src/providers/fake';
import { MemoryStore } from '../../src/store';

const TOKEN = 'dataplane-token-0123456789';

async function world(opts: { blocked?: boolean; transitionMs?: number } = {}) {
  const store = new MemoryStore();
  const provider = new FakeProvider(opts.transitionMs ?? 30).add({
    ref: 'p1',
    name: 'Studio A100',
    state: 'stopped',
    gpuType: 'A100',
    hourlyRate: 1.19,
    endpointUrl: `${FAKE_SCHEME}p1`,
  });
  const node = await register(store, provider, { provider_ref: 'p1', served_models: ['llama-70b'] });
  const app = createApp({
    store,
    provider,
    token: TOKEN,
    costCapUsd: 100,
    queueDeadlineS: 60,
    pollMs: 10,
    routingBlocked: () => Boolean(opts.blocked),
  });
  const chat = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: 'node/llama-70b',
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      }),
    });
  return { store, provider, node, app, chat };
}

describe('data plane', () => {
  it('answers 503 node_waking with Retry-After and starts the node once', async () => {
    const w = await world({ transitionMs: 10_000 });
    const first = await w.chat();
    expect(first.status).toBe(503);
    expect(Number(first.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await first.json()).toMatchObject({ error: { code: 'node_waking', node_id: w.node.id } });
    await new Promise((r) => setTimeout(r, 30));
    const second = await w.chat();
    expect(second.status).toBe(503);
    const ops = await w.store.listOperations(w.node.id);
    // One wake, not one per request.
    expect(ops.filter((o) => o.action === 'start')).toHaveLength(1);
    expect(await w.store.queued(w.node.id)).toHaveLength(2);
  });

  it('holds a request until the node is up, then answers from it', async () => {
    const w = await world({ transitionMs: 30 });
    const res = await w.chat({ 'x-controller-wait': '10' });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('x-controller-queued-ms'))).toBeGreaterThan(0);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toMatch(/Studio A100/);
    expect(await w.store.queued(w.node.id)).toHaveLength(0);
  });

  it('streams from a running node and notes activity for the idle rule', async () => {
    const w = await world({ transitionMs: 0 });
    await w.provider.action('p1', 'start');
    await w.store.putNode({ ...w.node, observed_state: 'running', endpoint_url: `${FAKE_SCHEME}p1` });
    const res = await w.chat({}, { stream: true });
    expect(res.headers.get('content-type')).toMatch(/event-stream/);
    expect(await res.text()).toMatch(/\[DONE\]/);
    await new Promise((r) => setTimeout(r, 20));
    expect((await w.store.getNode(w.node.id))?.last_activity_at).not.toBeNull();
  });

  it('answers 402 cost_cap when routing is blocked', async () => {
    const w = await world({ blocked: true });
    const res = await w.chat();
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'cost_cap' } });
  });

  it('answers 404 route_unknown for an alias it does not serve', async () => {
    const w = await world();
    const res = await w.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'node/nope', messages: [] }),
    });
    expect(res.status).toBe(404);
  });
});

describe('sample nodes', () => {
  it('seed two nodes with a month of history and three rules, once', async () => {
    const store = new MemoryStore();
    const provider = new FakeProvider(0);
    const now = new Date(Date.UTC(2026, 9, 20, 12));
    expect(await seedSampleNodes(store, provider, now)).toBe(true);
    expect(await seedSampleNodes(store, provider, now)).toBe(false);
    const nodes = await store.listNodes();
    expect(nodes.map((n) => n.name).sort()).toEqual(['Lab 4090', 'Studio A100']);
    expect((await store.intervals()).length).toBeGreaterThan(10);
    expect((await store.listRules()).map((r) => r.kind).sort()).toEqual([
      'cost_cap',
      'idle_timeout',
      'schedule',
    ]);
    expect((await store.listRoutes()).map((r) => r.alias)).toContain('node/llama-3.3-70b-instruct');
  });
});

describe('node heartbeats', () => {
  it('take the node token, not the Controller token, and note progress on the live start', async () => {
    const store = new MemoryStore();
    const provider = new FakeProvider(60_000).add({
      ref: 'pod-1',
      name: 'Studio A100',
      state: 'stopped',
      gpuType: 'A100',
      hourlyRate: 1.19,
      endpointUrl: 'http://n/v1',
    });
    const node = await register(store, provider, { provider_ref: 'pod-1' });
    const app = createApp({
      store,
      provider,
      token: TOKEN,
      nodeToken: 'node-token-0123456789',
      costCapUsd: 100,
      queueDeadlineS: 60,
      pollMs: 5,
    });
    await app.request(`/control/v1/nodes/${node.id}/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start', idempotency_key: 'start-key-123' }),
    });
    const beat = (token: string) =>
      app.request('/control/v1/nodes/heartbeat', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider_ref: 'pod-1',
          state: 'starting',
          detail: 'fetching weights',
          model: 'llama-70b',
        }),
      });
    expect((await beat(TOKEN)).status).toBe(401);
    expect((await beat('node-token-0123456789')).status).toBe(204);
    const live = await store.liveOperationFor(node.id);
    expect(live?.timeline.at(-1)?.detail).toBe('Node: fetching weights');
    expect((await store.getNode(node.id))?.served_models).toContain('llama-70b');
    expect((await store.listRoutes()).map((r) => r.alias)).toContain('node/llama-70b');
  });
});
