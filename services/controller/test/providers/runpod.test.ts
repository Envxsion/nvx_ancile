import { describe, expect, it } from 'vitest';
import { mapError, mapPod, mapState, RunPodProvider } from '../../src/providers/runpod';
import { ProviderError } from '../../src/providers/types';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Response[], calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    return r;
  }) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RunPod v2 adapter', () => {
  it('posts actions to /v2/pods/{id}/action with bearer auth and an idempotency key', async () => {
    const calls: Call[] = [];
    const p = new RunPodProvider({
      apiKey: 'rp_key',
      baseUrl: 'https://api.runpod.io/',
      fetch: fakeFetch([json(200, { id: 'abc', desiredStatus: 'RUNNING' })], calls),
    });
    const ack = await p.action('abc', 'start', 'idem-12345');
    expect(calls[0]?.url).toBe('https://api.runpod.io/v2/pods/abc/action');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'start' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer rp_key');
    expect(headers['idempotency-key']).toBe('idem-12345');
    expect(ack.state).toBe('running');
  });

  it('accepts 204 for terminate', async () => {
    const p = new RunPodProvider({
      apiKey: 'k',
      baseUrl: 'https://x',
      fetch: fakeFetch([new Response(null, { status: 204 })]),
    });
    expect((await p.action('abc', 'terminate', 'idem-12345')).state).toBe('terminating');
  });

  it('turns 409 into an invalid_state error with a suggestion', async () => {
    const p = new RunPodProvider({
      apiKey: 'k',
      baseUrl: 'https://x',
      fetch: fakeFetch([json(409, { error: 'pod is not stopped' })]),
    });
    const err = await p.action('abc', 'start', 'idem-12345').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.error).toMatchObject({ code: 'invalid_state', provider_message: 'pod is not stopped' });
    expect(err.retryable).toBe(false);
  });

  it('turns network failure into a retryable unreachable error', async () => {
    const p = new RunPodProvider({
      apiKey: 'k',
      baseUrl: 'https://x',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const err = await p.getNode('abc').catch((e) => e);
    expect(err.error.code).toBe('unreachable');
    expect(err.retryable).toBe(true);
  });
});

describe('error mapping', () => {
  it('recognises capacity and billing messages regardless of status', () => {
    expect(
      mapError(500, 'There are no longer any instances available with the requested specifications', 'start')
        .error.code,
    ).toBe('capacity_unavailable');
    expect(mapError(400, 'Insufficient balance to start pod', 'start').error.suggestion).toMatch(
      /Add credit/,
    );
  });
  it('maps auth, not found, rate limit and server errors', () => {
    expect(mapError(401, '', 'stop').error.code).toBe('auth');
    expect(mapError(404, '', 'stop').error.code).toBe('not_found');
    expect(mapError(429, '', 'stop').retryable).toBe(true);
    expect(mapError(502, '', 'stop').error.code).toBe('provider_unavailable');
  });
  it('always carries a provider message and a suggestion', () => {
    const e = mapError(418, '', 'stop').error;
    expect(e.provider_message).toBe('HTTP 418');
    expect(e.suggestion.length).toBeGreaterThan(10);
  });
});

describe('pod mapping', () => {
  it('reads state and rate defensively', () => {
    expect(mapState('EXITED')).toBe('stopped');
    expect(mapState('weird')).toBe('unknown');
    const pod = mapPod({
      id: 'abc',
      name: 'n',
      desiredStatus: 'RUNNING',
      costPerHr: 1.89,
      gpuTypeId: 'NVIDIA A100',
    });
    expect(pod).toMatchObject({ state: 'running', hourlyRate: 1.89, gpuType: 'NVIDIA A100' });
    expect(pod.endpointUrl).toMatch(/^https:\/\/abc-\d+\.proxy\.runpod\.net\/v1$/);
    expect(mapPod({ id: 'abc', status: 'EXITED' }).endpointUrl).toBeNull();
  });
});

/** Recorded from the v2 reference: GET /v2/pods/{id} (docs example, Oct 2026). */
const DOCS_POD = {
  id: '7h9k2m4n6p',
  name: 'pytorch-training',
  status: 'RUNNING',
  actions: ['stop', 'restart', 'terminate'],
  gpu: { id: 'NVIDIA GeForce RTX 4090', count: 1, vcpuCount: 16, memory: 64 },
  cloud: 'SECURE',
  dataCenterId: 'US-KS-2',
  cost: 0.44,
  createdAt: '2026-06-01T12:00:00Z',
  startedAt: '2026-06-01T12:02:00Z',
};

describe('v2 pod schema', () => {
  it('reads status, cost, gpu and data centre from the documented pod', () => {
    expect(mapPod(DOCS_POD)).toMatchObject({
      ref: '7h9k2m4n6p',
      state: 'running',
      hourlyRate: 0.44,
      gpuType: 'NVIDIA GeForce RTX 4090',
      region: 'US-KS-2',
    });
    expect(mapPod({ ...DOCS_POD, gpu: { id: 'NVIDIA A100', count: 2 } }).gpuType).toBe('2× NVIDIA A100');
  });

  it('never takes the 0.0 cost of a stopped pod as its rate', () => {
    expect(mapPod({ ...DOCS_POD, status: 'EXITED', cost: 0 }).hourlyRate).toBeNull();
    expect(mapState('ERROR')).toBe('error');
    expect(mapState('PROVISIONING')).toBe('creating');
  });

  it('reads the problem-details error body', async () => {
    const p = new RunPodProvider({
      apiKey: 'k',
      baseUrl: 'https://x',
      fetch: fakeFetch([
        json(409, {
          title: 'Conflict',
          status: 409,
          detail: 'Action not valid for current pod status',
          errors: ['pod is EXITED'],
        }),
      ]),
    });
    const err = await p.action('abc', 'restart', 'idem-12345').catch((e) => e);
    expect(err.error).toMatchObject({
      code: 'invalid_state',
      provider_message: 'Action not valid for current pod status (pod is EXITED)',
    });
  });
});

describe('RunPod create refused', () => {
  it('says the balance is empty when RunPod answers a bare 403 to a create', async () => {
    const p = new RunPodProvider({
      apiKey: 'k',
      baseUrl: 'https://x',
      fetch: fakeFetch([
        json(403, {
          title: 'Forbidden',
          status: 403,
          detail: 'Access to the requested resource was denied.',
        }),
        json(200, { data: { myself: { clientBalance: 0 } } }),
      ]),
    });
    const err = await p
      .create(
        {
          name: 'n',
          gpu_type_id: 'NVIDIA RTX A4000',
          gpu_count: 1,
          cloud: 'community',
          container_disk_gb: 30,
          volume_gb: 0,
          ports: ['8000/http'],
          env: {},
          image: 'i',
        },
        'idem-key-0001',
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.error).toMatchObject({ code: 'billing', suggestion: expect.stringContaining('Add credit') });
  });
});
