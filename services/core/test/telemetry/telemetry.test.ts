/**
 * Anonymous usage statistics (docs/telemetry.md): nothing without
 * consent, everything bucketed and checked against the contract, a daily
 * roll-up, batches under the server's limits with a valid stamp, two
 * tries then drop, and saying no erases it all.
 */
import { telemetry as T } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemorySettings } from '../../src/settings';
import * as B from '../../src/telemetry/buckets';
import { flowShape, observeApi, observeRunEvents, providerKind, usageOf } from '../../src/telemetry/collect';
import { Telemetry } from '../../src/telemetry/service';
import { stampValid } from '../../src/telemetry/stamp';
import { MemoryTelemetryStore } from '../../src/telemetry/store';

const DAY = 86_400_000;

function setup(opts: { endpoint?: string; status?: number | (() => number) } = {}) {
  let now = Date.parse('2026-10-08T10:00:00Z');
  const sent: { body: T.TelemetryBatch; stamp: string }[] = [];
  const store = new MemoryTelemetryStore();
  const settings = new MemorySettings();
  const t = new Telemetry({
    store,
    settings,
    version: '1.2.3',
    channel: 'dev',
    endpoint: opts.endpoint,
    now: () => now,
    timers: false,
    tier: () => 'free',
    env: () => ({ os: 'windows', arch: 'x64', ram: '16-31', cores: '9-16' }),
    usage: async () => ({ notebooks: '2-3', threads: '10-49' }),
    fetch: (async (_url: string, init?: RequestInit) => {
      sent.push({
        body: JSON.parse(String(init?.body)) as T.TelemetryBatch,
        stamp: String((init?.headers as Record<string, string> | undefined)?.['x-nvx-stamp']),
      });
      const s = typeof opts.status === 'function' ? opts.status() : (opts.status ?? 202);
      return new Response(null, { status: s });
    }) as typeof fetch,
  });
  return {
    t,
    store,
    settings,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const events = async (store: MemoryTelemetryStore) => (await store.peek(500)).map((q) => q.envelope);

describe('buckets', () => {
  it('never keeps an exact number', () => {
    expect([0, 1, 2, 3, 5, 9, 40].map(B.count)).toEqual(['0', '1', '2-3', '2-3', '4-6', '7-12', '13+']);
    expect([0, 5, 12, 77, 300, 900].map(B.wide)).toEqual(['0', '1-9', '10-49', '50-99', '100-499', '500+']);
    expect([10, 300, 999, 1500, 40_000].map(B.ms)).toEqual(['<250', '250-499', '500-999', '1-2s', '32s+']);
    expect(B.quantile([0, 9, 1, 0, 0, 0, 0, 0, 0], 0.5)).toBe('250-499');
    expect(B.quantile([0, 9, 1, 0, 0, 0, 0, 0, 0], 0.95)).toBe('500-999');
  });
});

describe('telemetry', () => {
  it('records and sends nothing without consent', async () => {
    const { t, store, settings, sent } = setup({ endpoint: 'https://stats.test' });
    await t.start();
    t.count('messages', 3);
    t.feature('branch');
    await t.tick();
    expect(await store.queued()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await settings.get('telemetry.install_id')).toBeUndefined();
    expect((await t.status()).consent).toBe('unset');
  });

  it('on consent: a random id, install and active, every envelope valid against the contract', async () => {
    const { t, store, settings } = setup();
    await t.start();
    await t.ui({
      env: { browser: 'opera', browser_major: 120, lang: 'en', tz: 11, theme: 'dark', narrow: false },
    });
    await t.setConsent(true);
    await t.ui({
      env: { browser: 'opera', browser_major: 120, lang: 'en', tz: 11, theme: 'dark', narrow: false },
    });
    const id = await settings.get<string>('telemetry.install_id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const evs = await events(store);
    expect(evs.map((e) => e.event)).toEqual(['install', 'active']);
    for (const e of evs) {
      expect(T.TelemetryEnvelope.safeParse(e).success).toBe(true);
      expect(T.validEnvelope(e)).toBe(true);
    }
    expect(evs[1]?.data).toMatchObject({ os: 'windows', notebooks: '2-3', tier: 'free', since_install: '0' });
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('rolls a finished day into daily_counts, perf, errors and exceptions', async () => {
    const { t, store, advance } = setup();
    await t.start();
    await t.setConsent(true);
    t.count('messages', 14);
    t.count('fallbacks');
    t.count('not_a_counter');
    t.feature('branch', 'shortcut');
    t.feature('branch', 'click');
    for (const ms of [300, 320, 340, 2_500]) t.timing('first_token', ms);
    t.error('flow.model_unready', 'stream');
    t.error('flow.model_unready', 'stream');
    t.error('NOT A CODE', '4xx');
    t.exception('core', 'TypeError');
    advance(DAY);
    await t.tick();
    const evs = await events(store);
    const by = (name: string) => evs.filter((e) => e.event === name);
    expect(by('first_use').map((e) => e.data)).toEqual([{ feature: 'branch', via: 'shortcut' }]);
    expect(by('daily_counts')[0]?.data).toEqual({
      lag: '1',
      messages: '10-49',
      fallbacks: '1',
      f_branch: '2-3',
    });
    expect(by('perf')[0]?.data).toEqual({
      lag: '1',
      first_token_p50: '250-499',
      first_token_p95: '2-4s',
      first_token_n: '4-6',
    });
    expect(by('error').map((e) => e.data)).toEqual([{ category: 'flow.model_unready', status: 'stream' }]);
    expect(by('exception').map((e) => e.data)).toEqual([{ where: 'core', kind: 'TypeError' }]);
    expect(by('active')).toHaveLength(2);
    for (const e of evs) expect(T.validEnvelope(e)).toBe(true);
  });

  it('sends batches under the limits with a valid stamp, and empties the queue on success', async () => {
    const { t, store, sent } = setup({ endpoint: 'https://stats.test' });
    await t.start();
    await t.setConsent(true);
    for (const step of T.FUNNEL_STEPS) t.funnel(step);
    for (const f of T.FEATURES) t.feature(f);
    await new Promise((r) => setTimeout(r, 10));
    await t.flush();
    expect(sent.length).toBeGreaterThan(1);
    for (const s of sent) {
      expect(s.body.batch.length).toBeLessThanOrEqual(50);
      expect(Buffer.byteLength(JSON.stringify(s.body))).toBeLessThan(7_600);
      expect(T.TelemetryBatch.safeParse(s.body).success).toBe(true);
      expect(s.stamp).toMatch(/^v1\.ancile\.20261008\.[0-9a-f-]{36}\.[0-9a-z]+$/);
      expect(stampValid(s.stamp)).toBe(true);
    }
    expect(await store.queued()).toBe(0);
    expect((await t.status()).last_sent_at).not.toBeNull();
  });

  it('tries twice then drops; a permanent refusal drops at once; no endpoint sends nothing', async () => {
    const failing = setup({ endpoint: 'https://stats.test', status: 503 });
    await failing.t.start();
    await failing.t.setConsent(true);
    // Saying yes sends at once: that was the first try.
    expect(failing.sent).toHaveLength(1);
    expect(await failing.store.queued()).toBeGreaterThan(0);
    await failing.t.flush();
    expect(failing.sent).toHaveLength(2);
    expect(await failing.store.queued()).toBe(0);

    const refused = setup({ endpoint: 'https://stats.test', status: 422 });
    await refused.t.start();
    await refused.t.setConsent(true);
    expect(await refused.store.queued()).toBe(0);

    const none = setup();
    await none.t.start();
    await none.t.setConsent(true);
    expect(none.sent).toHaveLength(0);
    expect(await none.store.queued()).toBeGreaterThan(0);
  });

  it('saying no erases the id, the queue and every counter', async () => {
    const { t, store, settings } = setup();
    await t.start();
    await t.setConsent(true);
    t.count('messages', 2);
    await t.preview();
    await t.setConsent(false);
    expect(await store.queued()).toBe(0);
    expect(await store.daysBefore('2100-01-01')).toEqual([]);
    expect(await settings.get('telemetry.install_id')).toBeNull();
    expect((await t.status()).consent).toBe('declined');
    t.count('messages');
    await t.tick();
    expect(await store.queued()).toBe(0);
  });

  it('reports an update by major.minor only', async () => {
    const { t, store, settings } = setup();
    await settings.set('telemetry.consent', 'granted');
    await settings.set('telemetry.install_id', '7f0c2d4e-5f1a-4c3e-9a8b-0d1e2f3a4b5c');
    await settings.set('telemetry.version', '1.1.9');
    await t.start();
    const evs = await events(store);
    expect(evs.map((e) => e.event).slice(0, 2)).toEqual(['update', 'startup']);
    expect(evs[0]?.data).toEqual({ from: '1.1' });
  });
});

describe('collectors', () => {
  it('maps API routes to features, never reading text', async () => {
    const { t, store } = setup();
    await t.start();
    await t.setConsent(true);
    const observe = observeApi(t);
    observe({ method: 'POST', path: '/messages/msg_1/branch', status: 201, ms: 40 });
    observe({
      method: 'POST',
      path: '/messages/msg_1/regenerate',
      status: 202,
      ms: 40,
      body: async () => ({ route: 'again' }),
    });
    observe({
      method: 'POST',
      path: '/threads/thr_1/messages',
      status: 202,
      ms: 40,
      body: async () => ({
        parts: [{ type: 'text', text: 'secret words' }],
        mentions: [{ kind: 'source', id: 'src_1' }],
      }),
    });
    observe({ method: 'POST', path: '/merge', status: 404, ms: 5 });
    await new Promise((r) => setTimeout(r, 10));
    const features = (await events(store)).filter((e) => e.event === 'first_use').map((e) => e.data.feature);
    expect(features).toEqual(
      expect.arrayContaining(['branch', 'regenerate_again', 'send', 'mention_source']),
    );
    expect(features).not.toContain('merge');
    expect(JSON.stringify(await events(store))).not.toContain('secret words');
  });

  it('times the first token and the whole answer from run events', async () => {
    const { t, store, advance } = setup();
    let clock = 0;
    await t.start();
    await t.setConsent(true);
    const log = observeRunEvents(new MemoryRunEventLog(), t, () => clock);
    await log.append('run_1', { type: 'run.status', status: 'running' });
    clock = 600;
    await log.append('run_1', { type: 'text.delta', message_id: 'm', delta: 'Hi' });
    clock = 3_000;
    await log.append('run_1', { type: 'done', message_id: 'm' });
    advance(DAY);
    await t.tick();
    const perf = (await events(store)).find((e) => e.event === 'perf');
    expect(perf?.data).toMatchObject({ first_token_p50: '500-999', answer_p50: '2-4s' });
    const daily = (await events(store)).find((e) => e.event === 'daily_counts');
    expect(daily?.data).toMatchObject({ answers: '1-9' });
  });

  it('describes a flow by its shape only', () => {
    const shape = flowShape(
      {
        nodes: [
          { id: 'in', kind: 'input', position: { x: 0, y: 0 }, params: {} },
          { id: 'r', kind: 'router', label: 'Jev', position: { x: 0, y: 0 }, params: { model: 'a/b' } },
          { id: 'w', kind: 'model', label: 'Writer', position: { x: 0, y: 0 }, params: { model: 'c/d' } },
          { id: 'out', kind: 'output', position: { x: 0, y: 0 }, params: {} },
        ],
        edges: [
          { id: 'e1', from: 'in', to: 'r' },
          { id: 'e2', from: 'r', to: 'w', label: 'writing', context: { conversation: { mode: 'none' } } },
          { id: 'e3', from: 'w', to: 'out' },
        ],
      } as never,
      'notebook',
      'publish',
    );
    expect(shape).toEqual({
      nodes: '4-6',
      depth: '2-3',
      models: '2-3',
      scope: 'notebook',
      on: 'publish',
      narrowed_edges: '1',
      k_input: true,
      k_router: true,
      k_model: true,
      k_output: true,
    });
    expect(T.EVENT_DATA.flow_shape.safeParse(shape).success).toBe(true);
    expect(JSON.stringify(shape)).not.toMatch(/Jev|Writer|writing/);
  });

  it('counts the workspace in buckets', async () => {
    const data = await usageOf({
      notebooks: async () => 4,
      threads: async () => 120,
      sourceKinds: async () => ['file', 'file', 'url', 'text'],
      memoryFiles: async () => 8,
      flows: async () => [{ active: true }, { active: false }],
      gpuNodes: async () => {
        throw new Error('Controller down');
      },
      mcpServers: async () => 1,
      automations: async () => 3,
      readyModels: async () => [
        { provider: 'anthropic', via: 'direct' },
        { provider: 'openrouter', via: 'direct' },
        { provider: 'vllm', via: 'direct', base_url: 'https://x/v1' },
        { provider: 'vllm', via: 'controller' },
      ],
      activeDays: async () => ({ d7: 5, d28: 12 }),
      preset: async () => 'balanced',
      memoryMode: async () => 'propose_all',
    });
    expect(data).toMatchObject({
      notebooks: '4-6',
      threads: '100-499',
      sources: '1-9',
      flows_active: '1',
      gpu_nodes: '0',
      models_anthropic: '1',
      models_endpoint: '1',
      models_node: '1',
      days_7: '5',
      days_28: '8-14',
      permission_preset: 'balanced',
      memory_mode: 'ask',
    });
    expect(T.EVENT_DATA.active.safeParse({ ...data, tier: 'free' }).success).toBe(true);
    expect(providerKind({ provider: 'fake', via: 'direct' })).toBe('offline');
  });
});
