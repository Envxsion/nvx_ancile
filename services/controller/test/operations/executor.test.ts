import { describe, expect, it } from 'vitest';
import { runOperation } from '../../src/operations/executor';
import { createOperation } from '../../src/operations/machine';
import { FakeProvider } from '../../src/providers/fake';
import { MemoryStore, type NodeRecord } from '../../src/store';

function setup(state: NodeRecord['observed_state'] = 'stopped') {
  let clock = new Date('2026-10-07T10:00:00Z').getTime();
  const now = () => new Date(clock);
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const provider = new FakeProvider(5_000, () => clock).add({
    ref: 'pod1',
    name: 'A100',
    state,
    gpuType: 'A100',
    hourlyRate: 1.5,
    endpointUrl: 'http://node:8000/v1',
  });
  const store = new MemoryStore();
  const node: NodeRecord = {
    id: 'nod_1',
    provider: 'local',
    provider_ref: 'pod1',
    name: 'A100',
    gpu_type: 'A100',
    region: null,
    observed_state: state,
    desired_state: state,
    endpoint_url: null,
    served_models: [],
    hourly_rate: 1.5,
    storage_rate_month: 10,
    healthy: false,
    last_activity_at: null,
    createdAt: now(),
    terminatedAt: null,
    runningSince: null,
  };
  void store.putNode(node);
  return { store, provider, now, sleep };
}

describe('executor', () => {
  it('drives start to confirmed and opens a usage interval', async () => {
    const { store, provider, now, sleep } = setup();
    const op = createOperation({
      id: 'opn_1',
      nodeId: 'nod_1',
      action: 'start',
      requestedBy: 't',
      traceId: 'a'.repeat(32),
      now: now(),
    });
    await store.putOperation(op, 'key-123456');
    const done = await runOperation('opn_1', 'key-123456', { store, provider, now, sleep, pollMs: 1_000 });
    expect(done.status).toBe('confirmed');
    expect(done.timeline.map((s) => s.status)).toContain('acknowledged');
    const node = await store.getNode('nod_1');
    expect(node?.observed_state).toBe('running');
    expect(node?.desired_state).toBe('running');
    expect(node?.endpoint_url).toBe('http://node:8000/v1');
    expect((await store.intervals()).filter((i) => i.endedAt === null)).toHaveLength(1);
  });

  it('fails with the provider error and suggestion when the action is rejected', async () => {
    const { store, provider, now, sleep } = setup();
    provider.failNext.set('pod1', { status: 400, message: 'Insufficient balance to start pod' });
    await store.putOperation(
      createOperation({
        id: 'opn_2',
        nodeId: 'nod_1',
        action: 'start',
        requestedBy: 't',
        traceId: 'a'.repeat(32),
        now: now(),
      }),
    );
    const done = await runOperation('opn_2', 'key-abcdefg', { store, provider, now, sleep });
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('billing');
  });

  it('retries transient provider errors before giving up', async () => {
    const { store, provider, now, sleep } = setup();
    provider.failNext.set('pod1', { status: 503, message: 'busy' });
    await store.putOperation(
      createOperation({
        id: 'opn_3',
        nodeId: 'nod_1',
        action: 'start',
        requestedBy: 't',
        traceId: 'a'.repeat(32),
        now: now(),
      }),
    );
    const done = await runOperation('opn_3', 'key-abcdefg', { store, provider, now, sleep, pollMs: 1_000 });
    expect(done.status).toBe('confirmed');
    expect(done.timeline.some((s) => /Retrying/.test(s.detail))).toBe(true);
  });

  it('times out when the node never reaches the target', async () => {
    const { store, now, sleep } = setup();
    const stuck = new FakeProvider(10 ** 12).add({
      ref: 'pod1',
      name: 'A100',
      state: 'stopped',
      gpuType: 'A100',
      hourlyRate: 1,
      endpointUrl: null,
    });
    await store.putOperation(
      createOperation({
        id: 'opn_4',
        nodeId: 'nod_1',
        action: 'start',
        requestedBy: 't',
        traceId: 'a'.repeat(32),
        now: now(),
      }),
    );
    const done = await runOperation('opn_4', 'key-abcdefg', {
      store,
      provider: stuck,
      now,
      sleep,
      pollMs: 10_000,
      budgets: { requested: 1_000, acknowledged: 1_000, in_progress: 60_000 },
    });
    expect(done.status).toBe('timed_out');
  });
});

describe('recovery after a restart', () => {
  it('resumes an operation that was in progress, so it confirms and frees the node', async () => {
    const { store, provider, now, sleep } = setup('stopped');
    const { advance } = await import('../../src/operations/machine');
    const { recoverOperations } = await import('../../src/operations/executor');
    // A start the provider acknowledged, then the Controller stopped watching.
    await provider.action('pod1', 'start');
    let op = createOperation({
      id: 'opn_r',
      nodeId: 'nod_1',
      action: 'start',
      requestedBy: 't',
      traceId: 'a'.repeat(32),
      now: now(),
    });
    op = advance(advance(op, 'acknowledged', 'ok', now()), 'in_progress', 'waiting', now());
    await store.putOperation(op, 'k-before-restart');
    expect(await store.liveOperationFor('nod_1')).toBeTruthy();

    expect(await recoverOperations({ store, provider, now, sleep, pollMs: 1_000 })).toBe(1);
    await expect.poll(async () => (await store.getOperation('opn_r'))?.status).toBe('confirmed');
    expect(await store.liveOperationFor('nod_1')).toBeFalsy();
    // Asked once only: the resumed watch does not repeat the action.
    expect(
      (await store.getOperation('opn_r'))?.timeline.filter((t) => t.status === 'acknowledged'),
    ).toHaveLength(1);
  });
});
