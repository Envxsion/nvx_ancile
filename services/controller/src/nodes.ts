/**
 * ------------------------------------------------------------------
 *  Title    |  Nodes: register, reconcile, seed
 *  Ref      |  DESIGN.md §3.3, §7.3
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Bring a node under management (a RunPod pod by id, a
 *           |  machine on the LAN), keep what we believe about it in
 *           |  step with what the provider reports, and give a fresh
 *           |  install sample nodes to try the whole flow without a
 *           |  GPU or a key.
 *  How      |  register() reads the node from its provider, stores it
 *           |  and gives every model it serves a route alias
 *           |  `node/<model>`. reconcile() re-reads every node that
 *           |  has no operation in flight, so changes made in the
 *           |  provider's console (or a LAN box switched on) show up.
 *  Note     |  Sample nodes say so everywhere: provider "fake", and
 *           |  the Cockpit badges them "Sample".
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import type { NodeState } from '@nvx/contracts/controller';
import { FAKE_SCHEME, type FakeProvider } from './providers/fake';
import type { ComputeProvider, ProviderNode } from './providers/types';
import type { NodeRecord, Store } from './store';

/** Route alias for a model served on a node. */
export const aliasFor = (model: string) => `node/${model}`;

const nodeIdFor = (provider: string, ref: string) =>
  `nod_${createHash('sha256').update(`${provider}:${ref}`).digest('hex').slice(0, 20)}`;

export interface RegisterInput {
  provider_ref: string;
  name?: string;
  served_models?: string[];
  storage_rate_month?: number;
}

export async function register(
  store: Store,
  provider: ComputeProvider,
  input: RegisterInput,
  now = new Date(),
): Promise<NodeRecord> {
  const seen = await provider.getNode(input.provider_ref);
  const id = nodeIdFor(provider.id, input.provider_ref);
  const existing = await store.getNode(id);
  const models = input.served_models?.length ? input.served_models : (seen.servedModels ?? []);
  const node: NodeRecord = {
    id,
    provider: provider.id,
    provider_ref: input.provider_ref,
    name: input.name ?? seen.name,
    gpu_type: seen.gpuType ?? 'GPU',
    region: seen.region ?? null,
    observed_state: seen.state,
    desired_state: seen.state === 'running' ? 'running' : 'stopped',
    endpoint_url: seen.endpointUrl,
    served_models: models,
    hourly_rate: seen.hourlyRate ?? existing?.hourly_rate ?? 0,
    storage_rate_month: input.storage_rate_month ?? existing?.storage_rate_month ?? 0,
    healthy: seen.state === 'running',
    last_activity_at: existing?.last_activity_at ?? null,
    createdAt: existing?.createdAt ?? now,
    terminatedAt: null,
    runningSince: seen.state === 'running' ? (existing?.runningSince ?? now) : null,
  };
  await store.putNode(node);
  if (node.observed_state === 'running') await store.openInterval(node.id, now, node.hourly_rate);
  for (const m of models)
    await store.putRoute({ alias: aliasFor(m), targets: [{ node_id: node.id }], policy: {} });
  return node;
}

/** Fold a fresh provider reading into the record; returns true when anything changed. */
export async function applyReading(store: Store, node: NodeRecord, seen: ProviderNode, at: Date) {
  const state: NodeState = seen.state;
  const models = seen.servedModels?.length ? seen.servedModels : node.served_models;
  const changed =
    state !== node.observed_state ||
    seen.endpointUrl !== node.endpoint_url ||
    models.join('|') !== node.served_models.join('|');
  if (!changed) return false;
  const next: NodeRecord = {
    ...node,
    observed_state: state,
    endpoint_url: seen.endpointUrl,
    served_models: models,
    hourly_rate: seen.hourlyRate ?? node.hourly_rate,
    healthy: state === 'running',
    runningSince: state === 'running' ? (node.runningSince ?? at) : null,
    terminatedAt: state === 'terminated' ? (node.terminatedAt ?? at) : node.terminatedAt,
  };
  await store.putNode(next);
  if (state === 'running') await store.openInterval(node.id, at, next.hourly_rate);
  if (state === 'stopped' || state === 'terminated' || state === 'error')
    await store.closeInterval(node.id, at);
  for (const m of models)
    if (!node.served_models.includes(m))
      await store.putRoute({ alias: aliasFor(m), targets: [{ node_id: node.id }], policy: {} });
  return true;
}

/** Re-read every node without an operation in flight. Errors are skipped, not thrown. */
export async function reconcile(store: Store, provider: ComputeProvider, at = new Date()): Promise<number> {
  let changed = 0;
  for (const node of await store.listNodes()) {
    if (node.provider !== provider.id || node.observed_state === 'terminated') continue;
    if (await store.liveOperationFor(node.id)) continue;
    try {
      const seen = await provider.getNode(node.provider_ref);
      if (await applyReading(store, node, seen, at)) changed++;
    } catch {
      // Unreachable provider: leave the record; /selftest and Health report it.
    }
  }
  return changed;
}

const HOUR = 3_600_000;

/**
 * Two sample nodes with a month of believable history, an idle rule and a
 * cost cap, so Admin → Compute shows what it will look like with real GPUs.
 * Only on an empty store.
 */
/**
 * Sample nodes, their invented history and the rules seeded with them, left
 * by an earlier version that showed samples in real installs: removed when
 * the Controller is not running in sample mode.
 */
export async function purgeSamples(store: Store): Promise<number> {
  let gone = 0;
  for (const n of await store.listNodes())
    if (n.provider === 'fake' && (await store.deleteNode(n.id))) gone++;
  for (const r of await store.listRules()) if (r.id.startsWith('rul_sample_')) await store.deleteRule(r.id);
  return gone;
}

export async function seedSampleNodes(store: Store, provider: FakeProvider, now = new Date()) {
  if ((await store.listNodes()).length > 0) return false;
  const samples = [
    {
      ref: 'sample-a100',
      name: 'Studio A100',
      gpu: 'NVIDIA A100 80GB',
      rate: 1.19,
      storage: 10,
      region: 'EU-RO-1',
      state: 'stopped' as const,
      models: ['llama-3.3-70b-instruct'],
      // Evenings this month: about 2.5 h on most days.
      history: (day: number) => (day % 3 === 2 ? 0 : 2.5),
    },
    {
      ref: 'sample-4090',
      name: 'Lab 4090',
      gpu: 'NVIDIA RTX 4090',
      rate: 0.44,
      storage: 4,
      region: 'US-KS-2',
      state: 'running' as const,
      models: ['qwen2.5-coder-32b-instruct'],
      history: (day: number) => (day % 2 === 0 ? 4 : 1),
    },
  ];
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = Math.floor((now.getTime() - monthStart.getTime()) / (24 * HOUR));
  for (const s of samples) {
    provider.add({
      ref: s.ref,
      name: s.name,
      state: s.state,
      gpuType: s.gpu,
      hourlyRate: s.rate,
      endpointUrl: `${FAKE_SCHEME}${s.ref}`,
      region: s.region,
    });
    const node = await register(
      store,
      provider,
      { provider_ref: s.ref, served_models: s.models, storage_rate_month: s.storage },
      monthStart,
    );
    for (let d = 0; d < days; d++) {
      const hours = s.history(d);
      if (!hours) continue;
      const start = new Date(monthStart.getTime() + d * 24 * HOUR + 18 * HOUR);
      await store.addInterval({
        nodeId: node.id,
        startedAt: start,
        endedAt: new Date(start.getTime() + hours * HOUR),
        hourlyRate: s.rate,
      });
    }
    if (s.state === 'running') {
      await store.closeInterval(node.id, monthStart);
      await store.openInterval(node.id, new Date(now.getTime() - 40 * 60_000), s.rate);
      await store.putNode({
        ...node,
        runningSince: new Date(now.getTime() - 40 * 60_000),
        last_activity_at: new Date(now.getTime() - 6 * 60_000).toISOString(),
      });
    }
  }
  await store.putRule({
    id: 'rul_sample_idle',
    kind: 'idle_timeout',
    enabled: true,
    config: { node_ids: '*', idle_minutes: 30 },
  });
  await store.putRule({
    id: 'rul_sample_cap',
    kind: 'cost_cap',
    enabled: true,
    config: { monthly_usd: 150, on_reach: 'block_routing' },
  });
  await store.putRule({
    id: 'rul_sample_night',
    kind: 'schedule',
    enabled: false,
    config: {
      node_ids: '*',
      cron: '0 23 * * *',
      action: 'stop',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
  return true;
}
