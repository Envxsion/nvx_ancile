/**
 * LM1: which Ollama models are loaded, Unload and Keep loaded on the ones
 * NVX Ancile lists, warm-on-pick, and the cases that must not stall: a silent
 * Ollama, an old Ollama without /api/ps, another computer, rapid switching.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelConfig } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { LoadedModels } from '../../src/localmodels/loaded';
import { OllamaClient } from '../../src/localmodels/ollama';
import { localModelRoutes } from '../../src/localmodels/routes';
import { errorHandler } from '../../src/obs/errors';

const GiB = 1024 ** 3;

const fake = {
  ps: 'ok' as 'ok' | 'old' | 'down',
  loaded: new Map<string, { size: number; expires: string }>(),
  calls: [] as { model: string; keep_alive?: number | string; aborted?: boolean }[],
  loadMs: 0,
  psCalls: 0,
};
const FOREVER = '2318-10-19T00:00:00Z';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      if (req.url === '/api/ps') {
        fake.psCalls++;
        if (fake.ps === 'old') {
          res.writeHead(404);
          return res.end('404 page not found');
        }
        if (fake.ps === 'down') return req.socket.destroy();
        return res.end(
          JSON.stringify({
            models: [...fake.loaded].map(([name, v]) => ({
              name,
              model: name,
              size: v.size,
              size_vram: v.size,
              expires_at: v.expires,
            })),
          }),
        );
      }
      if (req.url === '/api/generate') {
        const b = JSON.parse(raw) as { model: string; keep_alive?: number | string };
        const rec = { model: b.model, ...(b.keep_alive !== undefined && { keep_alive: b.keep_alive }) };
        fake.calls.push(rec);
        res.on('close', () => {
          if (!res.writableEnded) (rec as { aborted?: boolean }).aborted = true;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        res.on('close', () => clearTimeout(timer));
        const done = () => {
          if (b.keep_alive === 0) fake.loaded.delete(b.model);
          else
            fake.loaded.set(b.model, {
              size: 5 * GiB,
              expires: b.keep_alive === -1 ? FOREVER : new Date(Date.now() + 300_000).toISOString(),
            });
          res.end(JSON.stringify({ done: true }));
        };
        if (fake.loadMs && b.keep_alive === undefined) {
          timer = setTimeout(done, fake.loadMs);
          return;
        }
        return done();
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  fake.ps = 'ok';
  fake.loaded.clear();
  fake.calls = [];
  fake.loadMs = 0;
  fake.psCalls = 0;
});

const ollamaModel = (id: string, tag: string, extra: Partial<ModelConfig> = {}): ModelConfig =>
  ({
    id,
    provider: 'ollama',
    provider_model: tag,
    display_name: tag,
    via: 'direct',
    family: 'qwen',
    context_window: 32_000,
    max_output: 4_096,
    capabilities: ['tools'],
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    enabled: true,
    ...extra,
  }) as ModelConfig;

const MODELS: ModelConfig[] = [
  ollamaModel('ollama/qwen3-8b', 'qwen3:8b', { display_name: 'Qwen3 8B' }),
  ollamaModel('ollama/llama3.2', 'llama3.2'),
  {
    ...ollamaModel('anthropic/c', 'c'),
    provider: 'anthropic',
  } as ModelConfig,
];

function make(opts: { now?: () => number; memGiB?: number; url?: string } = {}) {
  return new LoadedModels({
    ollama: new OllamaClient({ baseUrl: opts.url ?? base }),
    registry: { all: () => MODELS },
    probe: { totalmem: () => (opts.memGiB ?? 16) * GiB },
    ...(opts.now && { now: opts.now }),
  });
}

describe('Loaded now', () => {
  it('lists what is loaded: the model, its memory and when it unloads', async () => {
    fake.loaded.set('qwen3:8b', { size: 6 * GiB, expires: new Date(Date.now() + 240_000).toISOString() });
    const v = await make().view();
    expect(v.state).toBe('ok');
    expect(v.local).toBe(true);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({
      name: 'qwen3:8b',
      model_id: 'ollama/qwen3-8b',
      display_name: 'Qwen3 8B',
      size_bytes: 6 * GiB,
      keep_loaded: false,
      managed: true,
    });
    expect(Date.parse(v.items[0]?.expires_at ?? '')).toBeGreaterThan(Date.now());
  });

  it('shows a model something else loaded, but does not manage it', async () => {
    fake.loaded.set('mistral:7b', { size: 4 * GiB, expires: new Date(Date.now() + 60_000).toISOString() });
    const l = make();
    const v = await l.view();
    expect(v.items[0]).toMatchObject({ model_id: null, managed: false, display_name: 'mistral:7b' });
    await expect(l.unload('mistral:7b')).rejects.toMatchObject({ code: 'local_model.not_managed' });
    await expect(l.keep('mistral:7b', true)).rejects.toMatchObject({ code: 'local_model.not_managed' });
    expect(fake.calls).toEqual([]);
  });

  it('Unload frees the model at once (keep_alive 0)', async () => {
    fake.loaded.set('qwen3:8b', { size: 6 * GiB, expires: new Date(Date.now() + 240_000).toISOString() });
    const l = make();
    await l.view();
    const after = await l.unload('qwen3:8b');
    expect(fake.calls).toEqual([{ model: 'qwen3:8b', keep_alive: 0 }]);
    expect(after.items).toEqual([]);
  });

  it('Keep loaded asks for keep_alive -1, shows it, and can be undone', async () => {
    const l = make();
    const kept = await l.keep('qwen3:8b', true);
    expect(fake.calls[0]).toMatchObject({ model: 'qwen3:8b', keep_alive: -1 });
    expect(kept.items[0]).toMatchObject({ keep_loaded: true, expires_at: null });
    const back = await l.keep('qwen3:8b', false);
    expect(back.items[0]).toMatchObject({ keep_loaded: false });
    expect(back.items[0]?.expires_at).not.toBeNull();
  });

  it('an Ollama without /api/ps is said to be too old, with no error', async () => {
    fake.ps = 'old';
    expect(await make().view()).toMatchObject({ state: 'too_old', items: [] });
  });

  it('a silent Ollama is a state, answered fast and not asked again for a few seconds', async () => {
    fake.ps = 'down';
    let now = 1_000_000;
    const l = make({ now: () => now });
    const first = await l.view();
    expect(first.state).toBe('unreachable');
    const asked = fake.psCalls;
    now += 3_000;
    expect((await l.view()).state).toBe('unreachable');
    expect(fake.psCalls).toBe(asked);
  });

  it('calls made together share one question to Ollama', async () => {
    fake.loaded.set('qwen3:8b', { size: GiB, expires: new Date(Date.now() + 1000).toISOString() });
    const l = make();
    await Promise.all([l.view(), l.view(), l.view()]);
    expect(fake.psCalls).toBe(1);
  });

  it('says when the loaded models leave no room for another', async () => {
    fake.loaded.set('qwen3:8b', { size: 9 * GiB, expires: new Date(Date.now() + 1000).toISOString() });
    expect((await make({ memGiB: 10 }).view()).crowded).toBe(true);
    expect((await make({ memGiB: 64 }).view()).crowded).toBe(false);
  });

  it('on another computer the memory is not read', async () => {
    const remote = new LoadedModels({
      ollama: new OllamaClient({
        baseUrl: 'http://gpu-box.lan:11434',
        fetch: (async () =>
          new Response(
            JSON.stringify({
              models: [{ name: 'qwen3:8b', size: GiB, size_vram: GiB, expires_at: FOREVER }],
            }),
          )) as typeof fetch,
      }),
      registry: { all: () => MODELS },
      probe: { totalmem: () => 16 * GiB },
    });
    const v = await remote.view();
    expect(v).toMatchObject({ state: 'ok', local: false, memory_bytes: null, crowded: false });
    expect(v.items[0]).toMatchObject({ managed: true, keep_loaded: true });
  });
});

describe('warm on pick', () => {
  it('starts loading an Ollama model and answers at once', async () => {
    fake.loadMs = 150;
    const l = make();
    const t0 = Date.now();
    const r = await l.warm('ollama/qwen3-8b');
    expect(r.state).toBe('loading');
    expect(Date.now() - t0).toBeLessThan(120);
    expect(l.pending()).toEqual(['qwen3:8b']);
    await new Promise((res) => setTimeout(res, 300));
    expect(l.pending()).toEqual([]);
    expect(fake.loaded.has('qwen3:8b')).toBe(true);
  });

  it('leaves a loaded model, a cloud model and an unknown id alone', async () => {
    fake.loaded.set('qwen3:8b', { size: GiB, expires: new Date(Date.now() + 1000).toISOString() });
    const l = make();
    expect((await l.warm('ollama/qwen3-8b')).state).toBe('loaded');
    expect((await l.warm('anthropic/c')).state).toBe('skipped');
    expect((await l.warm('nope/none')).state).toBe('skipped');
    expect(fake.calls).toEqual([]);
  });

  it('does nothing when Ollama is not answering', async () => {
    fake.ps = 'down';
    expect((await make().warm('ollama/qwen3-8b')).state).toBe('skipped');
    expect(fake.calls).toEqual([]);
  });

  it('rapid switching cancels the older load that has not finished', async () => {
    fake.loadMs = 400;
    const l = make();
    await l.warm('ollama/qwen3-8b');
    await new Promise((res) => setTimeout(res, 40));
    await l.warm('ollama/llama3.2');
    expect(l.pending()).toEqual(['llama3.2:latest']);
    await new Promise((res) => setTimeout(res, 600));
    expect(fake.loaded.has('llama3.2')).toBe(true);
    expect(fake.loaded.has('qwen3:8b')).toBe(false);
  });

  it('warns when a second big model will not fit beside the one loaded', async () => {
    fake.loaded.set('llama3.2', { size: 9 * GiB, expires: new Date(Date.now() + 60_000).toISOString() });
    const r = await make({ memGiB: 10 }).warm('ollama/qwen3-8b');
    expect(r.state).toBe('loading');
    expect(r.note).toMatch(/may not fit beside llama3\.2/);
  });
});

describe('routes', () => {
  const app = () => {
    const a = new Hono<AppEnv>();
    a.route('/', localModelRoutes({ models: {} as never, loaded: make() }));
    a.onError(errorHandler);
    return a;
  };
  const post = (path: string, body: unknown) =>
    app().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  interface Loaded {
    state: string;
    items: { name: string; keep_loaded: boolean }[];
    error?: { code: string };
  }
  const json = async (r: Response) => (await r.json()) as Loaded;

  it('GET /local-models/loaded, then warm, unload and keep through their routes', async () => {
    await new Promise((r) => setTimeout(r, 60)); // a load from the test before may still be landing
    fake.loaded.clear();
    expect((await json(await app().request('/local-models/loaded'))).state).toBe('ok');
    expect(await (await post('/local-models/warm', { model: 'ollama/qwen3-8b' })).json()).toMatchObject({
      state: 'loading',
    });
    const kept = await post('/local-models/loaded/keep', { name: 'llama3.2', keep: true });
    expect((await json(kept)).items.find((i) => i.name === 'llama3.2')).toMatchObject({ keep_loaded: true });
    const gone = await post('/local-models/loaded/unload', { name: 'llama3.2' });
    expect((await json(gone)).items.some((i) => i.name === 'llama3.2')).toBe(false);
  });

  it('refuses a model it does not manage with a plain error', async () => {
    const res = await post('/local-models/loaded/unload', { name: 'mistral:7b' });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({ code: 'local_model.not_managed' });
  });
});
