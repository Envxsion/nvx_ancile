/**
 * ------------------------------------------------------------------
 *  Title    |  Controller contract conformance
 *  Ref      |  packages/contracts/src/controller.ts, DESIGN.md §4.3
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Anything that passes this suite can stand in for the
 *           |  Controller. By default it runs against an in-process app
 *           |  (memory store + fake provider); point it at a deployed
 *           |  one with CONTRACT_BASE_URL and CONTRACT_TOKEN, plus
 *           |  CONTRACT_NODE_ID for a node it may start and stop.
 *  Note     |  Data-plane cases (node_waking with Retry-After, the hold,
 *           |  cost_cap 402, streaming) live in test/dataplane.
 * ------------------------------------------------------------------
 */

import { ApiError } from '@nvx/contracts';
import { ComputeNode, CostSummary, Operation } from '@nvx/contracts/controller';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { FakeProvider } from '../../src/providers/fake';
import { MemoryStore } from '../../src/store';

const TOKEN = process.env.CONTRACT_TOKEN ?? 'contract-token-0123456789';
let call: (path: string, init?: RequestInit) => Promise<Response>;
let nodeId = process.env.CONTRACT_NODE_ID ?? 'nod_contract';

beforeAll(async () => {
  const base = process.env.CONTRACT_BASE_URL;
  if (base) {
    call = (path, init) => fetch(`${base.replace(/\/$/, '')}${path}`, init);
    return;
  }
  const store = new MemoryStore();
  const provider = new FakeProvider(0).add({
    ref: 'p1',
    name: 'Contract node',
    state: 'stopped',
    gpuType: 'A100',
    hourlyRate: 1,
    endpointUrl: 'http://n/v1',
  });
  await store.putNode({
    id: nodeId,
    provider: 'local',
    provider_ref: 'p1',
    name: 'Contract node',
    gpu_type: 'A100',
    region: null,
    observed_state: 'stopped',
    desired_state: 'stopped',
    endpoint_url: null,
    served_models: [],
    hourly_rate: 1,
    storage_rate_month: 5,
    healthy: false,
    last_activity_at: null,
    createdAt: new Date(),
    terminatedAt: null,
    runningSince: null,
  });
  const app = createApp({
    store,
    provider,
    token: TOKEN,
    costCapUsd: 100,
    queueDeadlineS: 60,
    pollMs: 5,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  call = async (path, init) => app.request(path, init);
  nodeId = 'nod_contract';
});

const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra });

describe('Controller contract v1', () => {
  it('serves liveness without auth', async () => {
    const r = await call('/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ok', contract: expect.stringMatching(/^1\./) });
  });

  it('rejects control-plane calls without the token, in the standard error shape', async () => {
    const r = await call('/control/v1/nodes');
    expect(r.status).toBe(401);
    expect(ApiError.safeParse(await r.json()).success).toBe(true);
  });

  it('lists nodes in the contract shape', async () => {
    const r = await call('/control/v1/nodes', { headers: auth() });
    const body = (await r.json()) as { items: unknown[] };
    expect(r.status).toBe(200);
    for (const n of body.items) expect(ComputeNode.safeParse(n).success).toBe(true);
  });

  it('accepts an action with 202, replays by idempotency key, and confirms through the chain', async () => {
    const key = `contract-${Date.now()}`;
    const req = {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ action: 'start', idempotency_key: key }),
    };
    const first = await call(`/control/v1/nodes/${nodeId}/actions`, req);
    expect(first.status).toBe(202);
    const { operation_id } = (await first.json()) as { operation_id: string };
    const again = (await (await call(`/control/v1/nodes/${nodeId}/actions`, req)).json()) as {
      operation_id: string;
    };
    expect(again.operation_id).toBe(operation_id);

    let op: Operation | undefined;
    for (let i = 0; i < 100; i++) {
      op = Operation.parse(
        await (await call(`/control/v1/operations/${operation_id}`, { headers: auth() })).json(),
      );
      if (['confirmed', 'failed', 'timed_out'].includes(op.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(op?.status).toBe('confirmed');
    expect(op?.timeline.map((s) => s.status)).toEqual(
      expect.arrayContaining(['requested', 'acknowledged', 'in_progress', 'confirmed']),
    );
  });

  it('rejects a reused key for a different action with 409', async () => {
    const key = `contract-conflict-${Date.now()}`;
    const send = (action: string) =>
      call(`/control/v1/nodes/${nodeId}/actions`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ action, idempotency_key: key }),
      });
    expect((await send('start')).status).toBe(202);
    expect((await send('stop')).status).toBe(409);
  });

  it('reports costs in the contract shape', async () => {
    const r = await call('/control/v1/costs', { headers: auth() });
    expect(CostSummary.safeParse(await r.json()).success).toBe(true);
  });

  it('validates rules and explains bad schedules', async () => {
    const bad = await call('/control/v1/rules', {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        kind: 'schedule',
        enabled: true,
        config: { node_ids: '*', cron: '99 * * * *', action: 'stop', tz: 'UTC' },
      }),
    });
    expect(bad.status).toBe(422);
    expect(ApiError.parse(await bad.json()).error.hint).toMatch(/minute/);
  });

  it('exposes route aliases as OpenAI models', async () => {
    const r = await call('/v1/models', { headers: auth() });
    expect(await r.json()).toMatchObject({ object: 'list' });
  });
});
