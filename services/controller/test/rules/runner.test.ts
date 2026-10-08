/**
 * The rule runner (rules/runner.ts) against the in-memory store: every
 * rule kind in one tick, one action per node, a schedule that never fires
 * twice for the same slot (even after a restart), cap notices announced
 * once a month, and the env default cap blocking routing with no rules.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAll, newRunnerState } from '../../src/rules/runner';
import { MemoryStore, type NodeRecord } from '../../src/store';

const now = new Date('2026-10-07T10:00:30Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

const node = (over: Partial<NodeRecord> = {}): NodeRecord => ({
  id: 'n1',
  provider: 'fake',
  provider_ref: 'n1',
  name: 'A100 box',
  gpu_type: 'A100',
  region: 'EU',
  observed_state: 'running',
  desired_state: 'running',
  endpoint_url: null,
  served_models: ['m1'],
  hourly_rate: 2,
  storage_rate_month: 0,
  healthy: true,
  last_activity_at: ago(45).toISOString(),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  terminatedAt: null,
  runningSince: ago(120),
  ...over,
});

async function world(nodes: NodeRecord[]) {
  const store = new MemoryStore();
  for (const n of nodes) await store.putNode(n);
  return store;
}

describe('rule runner', () => {
  it('applies idle and schedule rules in one tick, one action per node, first rule wins', async () => {
    const store = await world([
      node(),
      node({ id: 'n2', name: 'Lab 4090', last_activity_at: ago(1).toISOString() }),
    ]);
    await store.putRule({
      id: 'idle',
      kind: 'idle_timeout',
      enabled: true,
      config: { node_ids: '*', idle_minutes: 30 },
    });
    await store.putRule({
      id: 'night',
      kind: 'schedule',
      enabled: true,
      config: { node_ids: '*', cron: '0 10 * * *', action: 'stop', tz: 'UTC' },
    });
    const out = await evaluateAll(store, newRunnerState(), now, 1_000);
    expect(out.actions.map((a) => a.nodeId).sort()).toEqual(['n1', 'n2']);
    expect(out.actions.find((a) => a.nodeId === 'n1')?.reason).toMatch(/^rule:idle/);
    expect(out.actions.find((a) => a.nodeId === 'n2')?.reason).toMatch(/^rule:night/);
  });

  it('fires a schedule slot once, even after a restart (state rebuilt from the store)', async () => {
    const store = await world([node({ last_activity_at: ago(1).toISOString() })]);
    await store.putRule({
      id: 'night',
      kind: 'schedule',
      enabled: true,
      config: { node_ids: '*', cron: '0 10 * * *', action: 'stop', tz: 'UTC' },
    });
    expect((await evaluateAll(store, newRunnerState(), now, 1_000)).actions).toHaveLength(1);
    // Same process, a moment later.
    const state = newRunnerState();
    expect((await evaluateAll(store, state, new Date(now.getTime() + 20_000), 1_000)).actions).toHaveLength(
      0,
    );
    // A fresh process (restart) reads the last firing from the store.
    expect(
      (await evaluateAll(store, newRunnerState(), new Date(now.getTime() + 40_000), 1_000)).actions,
    ).toHaveLength(0);
  });

  it('announces a cost cap once per month, and blocks routing when the cap says so', async () => {
    // Two A100s at $40/h for a week: well past a $100 cap.
    const store = await world([node({ hourly_rate: 40 })]);
    await store.openInterval('n1', new Date('2026-10-01T00:00:00Z'), 40);
    await store.putRule({
      id: 'cap',
      kind: 'cost_cap',
      enabled: true,
      config: { monthly_usd: 100, on_reach: 'block_routing' },
    });
    const state = newRunnerState();
    const first = await evaluateAll(store, state, now, 1_000);
    expect(first.blockRouting).toBe(true);
    expect(state.routingBlocked).toBe(true);
    expect(first.notices.length).toBeGreaterThan(0);
    const second = await evaluateAll(store, state, new Date(now.getTime() + 60_000), 1_000);
    expect(second.blockRouting).toBe(true);
    expect(second.notices).toHaveLength(0);
  });

  it('with no cost rule, the default cap still blocks routing once spent', async () => {
    const store = await world([node({ hourly_rate: 40, last_activity_at: ago(1).toISOString() })]);
    await store.openInterval('n1', new Date('2026-10-01T00:00:00Z'), 40);
    expect((await evaluateAll(store, newRunnerState(), now, 100)).blockRouting).toBe(true);
    expect((await evaluateAll(store, newRunnerState(), now, 1_000_000)).blockRouting).toBe(false);
  });

  it('a node with an operation in flight is left alone by the idle rule', async () => {
    const store = await world([node()]);
    await store.putRule({
      id: 'idle',
      kind: 'idle_timeout',
      enabled: true,
      config: { node_ids: '*', idle_minutes: 30 },
    });
    await store.putOperation({
      id: 'op1',
      node_id: 'n1',
      action: 'start',
      status: 'in_progress',
      reason: 'test',
      created_at: ago(1).toISOString(),
      updated_at: ago(1).toISOString(),
      steps: [],
    } as never);
    expect((await evaluateAll(store, newRunnerState(), now, 1_000)).actions).toHaveLength(0);
  });
});
