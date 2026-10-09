/**
 * Creating a node (a RunPod pod) from the app: the provider creates it,
 * the Controller manages it, and the same four-link chain confirms it once
 * it runs. Providers that cannot create say so; a repeated key replays.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { FakeProvider } from '../../src/providers/fake';
import { RunPodProvider } from '../../src/providers/runpod';
import type { ComputeProvider } from '../../src/providers/types';
import { MemoryStore } from '../../src/store';

const TOKEN = 't'.repeat(32);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function app(provider: ComputeProvider, nodeToken?: string) {
  const store = new MemoryStore();
  const a = createApp({
    store,
    provider,
    token: TOKEN,
    ...(nodeToken && { nodeToken }),
    costCapUsd: 100,
    queueDeadlineS: 60,
    pollMs: 5,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return { store, call: (path: string, init?: RequestInit) => a.request(path, init) };
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Coder A6000',
    spec: { gpu_type_id: 'NVIDIA RTX A6000', image: 'vllm/vllm-openai:latest', region: 'EU-RO-1' },
    idempotency_key: 'create-key-0001',
    served_models: ['qwen2.5-coder-32b'],
    ...over,
  });

describe('creating a node', () => {
  it('creates, registers and confirms it through the chain', async () => {
    const { call, store } = app(new FakeProvider(20));
    const r = await call('/control/v1/nodes/create', { method: 'POST', headers: auth, body: body() });
    expect(r.status).toBe(202);
    const { operation_id, node_id } = (await r.json()) as { operation_id: string; node_id: string };
    let op = await store.getOperation(operation_id);
    for (let i = 0; i < 100 && op?.status !== 'confirmed'; i++) {
      await new Promise((res) => setTimeout(res, 10));
      op = await store.getOperation(operation_id);
    }
    expect(op?.action).toBe('create');
    expect(op?.timeline.map((s) => s.status)).toEqual(
      expect.arrayContaining(['requested', 'acknowledged', 'in_progress', 'confirmed']),
    );
    const node = await store.getNode(node_id);
    expect(node).toMatchObject({ name: 'Coder A6000', observed_state: 'running', region: 'EU-RO-1' });
    expect(node?.served_models).toEqual(['qwen2.5-coder-32b']);

    // The same key replays rather than creating a second pod.
    const again = await call('/control/v1/nodes/create', { method: 'POST', headers: auth, body: body() });
    expect(((await again.json()) as { replayed?: boolean }).replayed).toBe(true);
    expect((await store.listNodes()).length).toBe(1);
  });

  it('needs an image or a template', async () => {
    const { call } = app(new FakeProvider(20));
    const r = await call('/control/v1/nodes/create', {
      method: 'POST',
      headers: auth,
      body: body({ spec: { gpu_type_id: 'NVIDIA RTX A6000' } }),
    });
    expect(r.status).toBe(422);
  });

  it('says when the provider cannot create', async () => {
    const cannot: ComputeProvider = {
      id: 'local',
      getNode: async () => {
        throw new Error('unused');
      },
      action: async () => ({ accepted: true, state: null, detail: '' }),
      ping: async () => ({ ok: true, detail: '' }),
    };
    const r = await app(cannot).call('/control/v1/nodes/create', {
      method: 'POST',
      headers: auth,
      body: body(),
    });
    expect(r.status).toBe(501);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('provider.cannot_create');
  });

  it('gives a bootstrapped node the key the Controller sends, and refuses without one', async () => {
    const seen: Record<string, string>[] = [];
    const p = new FakeProvider(20);
    const create = p.create.bind(p);
    p.create = (spec: Parameters<typeof create>[0]) => {
      seen.push(spec.env);
      return create(spec);
    };
    const boot = body({
      spec: {
        gpu_type_id: 'NVIDIA RTX A6000',
        image: 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04',
        env: { ANCILE_MODEL: 'Qwen/Qwen2.5-0.5B-Instruct', ANCILE_NODE_API_KEY: 'chosen-by-caller' },
      },
    });
    const without = await app(p).call('/control/v1/nodes/create', {
      method: 'POST',
      headers: auth,
      body: boot,
    });
    expect(((await without.json()) as { error: { code: string } }).error.code).toBe('node.needs_token');
    const r = await app(p, 'n'.repeat(32)).call('/control/v1/nodes/create', {
      method: 'POST',
      headers: auth,
      body: boot,
    });
    expect(r.status).toBe(202);
    expect(seen[0]?.ANCILE_NODE_API_KEY).toBe('n'.repeat(32));
  });

  it('sends RunPod the v2 create body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const p = new RunPodProvider({
      apiKey: 'rp_key',
      baseUrl: 'https://api.runpod.io',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            id: 'pod9',
            name: 'Coder',
            status: 'PROVISIONING',
            cost: 0.79,
            gpu: { id: 'NVIDIA RTX A6000', count: 1 },
            dataCenterId: 'EU-RO-1',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const node = await p.create(
      {
        name: 'Coder',
        gpu_type_id: 'NVIDIA RTX A6000',
        gpu_count: 1,
        image: 'vllm/vllm-openai:latest',
        region: 'EU-RO-1',
        cloud: 'secure',
        container_disk_gb: 40,
        volume_gb: 50,
        ports: ['8000/http'],
        env: { HF_HOME: '/workspace/hf' },
        command: ['--model', 'Qwen/Qwen2.5-Coder-32B-Instruct', '--port', '8000'],
      },
      'create-key-0001',
    );
    expect(calls[0]?.url).toBe('https://api.runpod.io/v2/pods');
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.['idempotency-key']).toBe(
      'create-key-0001',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      name: 'Coder',
      gpu: { id: 'NVIDIA RTX A6000', count: 1 },
      cloud: 'SECURE',
      disk: 40,
      mounts: { persistent: { size: 50, path: '/workspace' } },
      ports: ['8000/http'],
      env: { HF_HOME: '/workspace/hf' },
      image: 'vllm/vllm-openai:latest',
      dataCenterIds: ['EU-RO-1'],
      cmd: ['--model', 'Qwen/Qwen2.5-Coder-32B-Instruct', '--port', '8000'],
    });
    expect(node).toMatchObject({ ref: 'pod9', hourlyRate: 0.79, region: 'EU-RO-1' });
  });
});
