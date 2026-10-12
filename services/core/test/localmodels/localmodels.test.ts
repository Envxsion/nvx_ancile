/**
 * One-click local models against a fake Ollama: a real HTTP server that
 * speaks /api/version, /api/tags, /api/show and a streamed /api/pull, so
 * progress, cancel, resume, stalls, refusals and verification run through
 * the same client (and packages/resilience) as with the real thing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LocalDownload, LocalModelEntry, LocalModelsView, ModelConfig } from '@nvx/contracts';
import { LocalModelEntry as Entry } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { fitOf, type HardwareProbe, parseNvidia } from '../../src/localmodels/hardware';
import { OllamaClient, ollamaBase, ollamaDownload, ollamaInstalled } from '../../src/localmodels/ollama';
import { localModelRoutes } from '../../src/localmodels/routes';
import { LocalModels } from '../../src/localmodels/service';
import { errorHandler } from '../../src/obs/errors';

const GiB = 1024 ** 3;

/* ---- the fake Ollama ------------------------------------------------------------- */

type PullMode = 'ok' | 'refuse' | 'stall' | 'cut' | 'slow';
const fake = {
  mode: 'ok' as PullMode,
  have: new Set<string>(['llama3.2:3b']),
  /** Layers already fetched, by model: a resumed pull starts from here. */
  partial: new Map<string, number>(),
  pulls: [] as string[],
  showMissing: false,
};

let server: Server;
let base: string;

function pull(req: IncomingMessage, res: ServerResponse, model: string) {
  fake.pulls.push(model);
  if (fake.mode === 'refuse') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(`${JSON.stringify({ error: 'pull model manifest: file does not exist' })}\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const send = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
  send({ status: 'pulling manifest' });
  const total = 1000;
  const start = fake.partial.get(model) ?? 0;
  let done = start;
  if (fake.mode === 'stall') return; // says nothing more, holds the line open
  const step = () => {
    if (res.destroyed) return;
    done = Math.min(total, done + 250);
    fake.partial.set(model, done);
    send({ status: `pulling ${'a'.repeat(12)}`, digest: 'sha256:aaa', total, completed: done });
    send({ status: `pulling ${'b'.repeat(12)}`, digest: 'sha256:bbb', total: 10, completed: 10 });
    if (fake.mode === 'cut' && done >= 500) {
      res.destroy();
      return;
    }
    if (done < total) {
      setTimeout(step, fake.mode === 'slow' ? 60 : 5);
      return;
    }
    send({ status: 'verifying sha256 digest' });
    send({ status: 'writing manifest' });
    send({ status: 'success' });
    fake.have.add(model);
    fake.partial.delete(model);
    res.end();
  };
  setTimeout(step, 5);
  req.on('close', () => undefined);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.12.3' }));
      if (req.url === '/api/tags')
        return res.end(
          JSON.stringify({
            models: [...fake.have].map((name) => ({ name: `${name}`, size: 1, digest: 'x' })),
          }),
        );
      if (req.url === '/api/show') {
        if (!fake.showMissing && body.model && fake.have.has(body.model))
          return res.end(JSON.stringify({ details: {} }));
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'model not found' }));
      }
      if (req.url === '/api/pull') return pull(req, res, body.model ?? '');
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
afterEach(() => {
  fake.mode = 'ok';
  fake.showMissing = false;
});

/* ---- the world around it ------------------------------------------------------------ */

const CATALOGUE: LocalModelEntry[] = [
  {
    id: 'qwen3-8b',
    name: 'Qwen3 8B',
    source: 'qwen3:8b',
    size_gb: 5.2,
    ram_gb: 10,
    vram_gb: 7,
    licence: 'Apache 2.0',
    good_for: 'x',
    family: 'qwen',
    capabilities: ['tools'],
    recommended: true,
  },
  {
    id: 'qwen3-14b',
    name: 'Qwen3 14B',
    source: 'qwen3:14b',
    size_gb: 9.3,
    ram_gb: 14,
    vram_gb: 12,
    licence: 'Apache 2.0',
    good_for: 'x',
    family: 'qwen',
  },
  {
    id: 'gpt-oss-20b',
    name: 'gpt-oss 20B',
    source: 'gpt-oss:20b',
    size_gb: 14,
    ram_gb: 24,
    vram_gb: 16,
    licence: 'Apache 2.0',
    good_for: 'x',
    family: 'gpt-oss',
  },
  {
    id: 'llama3-2-3b',
    name: 'Llama 3.2 3B',
    source: 'llama3.2:3b',
    size_gb: 2,
    ram_gb: 5,
    vram_gb: 3,
    licence: 'Llama',
    good_for: 'x',
    family: 'llama',
  },
  {
    id: 'huge',
    name: 'Huge',
    source: 'huge:1t',
    size_gb: 900,
    ram_gb: 8,
    vram_gb: 4,
    licence: 'MIT',
    good_for: 'x',
    family: 'h',
  },
  {
    id: 'bge',
    name: 'BGE small',
    kind: 'embedder',
    via: 'fastembed',
    source: 'BAAI/bge-small-en-v1.5',
    size_gb: 0.07,
    ram_gb: 1,
    licence: 'MIT',
    good_for: 'x',
    family: 'bge',
  },
].map((e) => Entry.parse(e));

function registry(initial: Partial<ModelConfig>[] = []) {
  let models = initial.map((m) => ({ enabled: true, ...m }) as ModelConfig);
  const custom = new Set<string>();
  return {
    all: () => models,
    custom: () => models.filter((m) => custom.has(m.id)),
    async saveCustom(next: ModelConfig[]) {
      models = [...models.filter((m) => !custom.has(m.id)), ...next];
      for (const m of next) custom.add(m.id);
    },
    async setEnabled(u: Record<string, boolean>) {
      models = models.map((m) => (m.id in u ? { ...m, enabled: u[m.id] as boolean } : m));
    },
  };
}

const probe = (o: Partial<HardwareProbe> & { freeGb?: number } = {}): HardwareProbe => ({
  platform: 'linux',
  arch: 'x64',
  totalmem: () => 16 * GiB,
  nvidia: async () => 'NVIDIA GeForce RTX 4060, 8188\n',
  disk: async () => ({ free: (o.freeGb ?? 100) * GiB, drive: '/home/me/.ollama/models' }),
  ...o,
});

function make(
  o: {
    url?: string;
    reg?: ReturnType<typeof registry>;
    probe?: HardwareProbe;
    kn?: unknown;
    installed?: boolean;
  } = {},
) {
  const reg = o.reg ?? registry();
  const url = o.url ?? base;
  const models = new LocalModels({
    catalogue: CATALOGUE,
    ollamaUrl: url,
    registry: reg,
    ollama: new OllamaClient({ baseUrl: url, stallMs: 200 }),
    probe: o.probe ?? probe(),
    modelsDir: '/home/me/.ollama/models',
    platform: 'linux',
    installed: async () => o.installed ?? false,
    ...(o.kn ? { kn: o.kn as never } : {}),
  });
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/v1', localModelRoutes({ models }));
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { models, reg, call };
}

async function until(
  models: LocalModels,
  id: string,
  done: (d: LocalDownload) => boolean,
): Promise<LocalDownload> {
  for (let i = 0; i < 400; i++) {
    const d = models.job(id);
    if (done(d)) return d;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`download ${id} never got there: ${JSON.stringify(models.job(id))}`);
}

/* ---- tests ------------------------------------------------------------------------- */

describe('what fits this computer', () => {
  it('reads the graphics card, memory and disk, and says plainly what fits', async () => {
    const { call } = make();
    const r = await call<LocalModelsView>('GET', '/local-models');
    expect(r.status).toBe(200);
    expect(r.body.ollama).toMatchObject({ status: 'running', version: '0.12.3', local: true });
    expect(r.body.hardware).toMatchObject({
      os: 'linux',
      ram_gb: 16,
      gpu: { name: 'NVIDIA GeForce RTX 4060', vram_gb: 8, shared: false },
      disk_free_gb: 100,
    });
    const by = new Map(r.body.items.map((i) => [i.id, i]));
    expect(r.body.items[0]?.recommended).toBe(true);
    expect(by.get('qwen3-8b')?.fit).toMatchObject({ verdict: 'good', blocker: null });
    expect(by.get('qwen3-8b')?.fit.reasons[0]).toMatch(
      /Fits on your graphics card \(NVIDIA GeForce RTX 4060, 8 GB/,
    );
    expect(by.get('qwen3-14b')?.fit.verdict).toBe('slow');
    expect(by.get('qwen3-14b')?.fit.reasons.join(' ')).toMatch(/answers will be slow/);
    expect(by.get('gpt-oss-20b')?.fit).toMatchObject({ verdict: 'no', blocker: 'memory' });
    expect(by.get('huge')?.fit).toMatchObject({ verdict: 'no', blocker: 'disk' });
    expect(by.get('huge')?.fit.reasons[0]).toMatch(
      /Needs about 990\.3 GB of disk; 100 GB free on \/home\/me/,
    );
    expect(by.get('llama3-2-3b')).toMatchObject({ installed: true, model_id: null });
    expect(by.get('bge')).toMatchObject({ installed: false, fit: { verdict: 'good' } });
  });

  it('pure checks: nvidia-smi output, Apple silicon, remote Ollama, no card', () => {
    expect(parseNvidia('A, 4096\nB, 24576\nnonsense\n')).toEqual({ name: 'B', vram_gb: 24 });
    expect(parseNvidia(null)).toBeNull();
    const e = CATALOGUE[0] as LocalModelEntry;
    const mac = {
      os: 'macos' as const,
      ram_gb: 16,
      gpu: { name: 'Apple silicon', vram_gb: null, shared: true },
      disk_free_gb: 50,
      disk_where: '/',
    };
    expect(fitOf(e, mac, { installed: false, remote: false }).reasons[0]).toMatch(
      /Apple silicon's shared memory/,
    );
    expect(fitOf(e, mac, { installed: false, remote: true }).verdict).toBe('unknown');
    const noCard = { os: 'windows' as const, ram_gb: 32, gpu: null, disk_free_gb: 2, disk_where: 'C:' };
    expect(fitOf(e, noCard, { installed: false, remote: false, platform: 'win32' }).reasons[0]).toMatch(
      /free on drive C:/,
    );
    expect(fitOf(e, noCard, { installed: true, remote: false }).reasons[0]).toMatch(
      /No graphics card was found/,
    );
    expect(ollamaBase('http://x:11434/v1/')).toBe('http://x:11434');
    expect(ollamaDownload('win32').url).toBe('https://ollama.com/download/windows');
    expect(ollamaDownload('linux').command).toBe('curl -fsSL https://ollama.com/install.sh | sh');
  });

  it('Ollama not answering: installed or missing, said with the official link; never installed for you', async () => {
    const dead = 'http://127.0.0.1:9';
    const missing = make({ url: dead });
    const v = await missing.call<LocalModelsView>('GET', '/local-models');
    expect(v.body.ollama).toMatchObject({
      status: 'missing',
      download_url: 'https://ollama.com/download/linux',
    });
    const r = await missing.call<{ error: { code: string; title: string; hint: string } }>(
      'POST',
      '/local-models/qwen3-8b/download',
      {},
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'local_model.ollama_missing',
      title: 'Ollama is not installed',
    });
    expect(r.body.error.hint).toContain('never installs it for you');
    const installed = make({ url: dead, installed: true });
    expect((await installed.call<LocalModelsView>('GET', '/local-models')).body.ollama.status).toBe(
      'installed',
    );
    const remote = make({ url: 'http://192.0.2.1:9' });
    const rv = await remote.call<LocalModelsView>('GET', '/local-models');
    expect(rv.body.ollama.status).toBe('remote_unreachable');
    expect(rv.body.hardware.disk_free_gb).toBeNull();
    expect(await ollamaInstalled({ PATH: '' }, 'linux')).toBe(false);
  }, 30_000);
});

describe('downloading', () => {
  it('pulls with progress, verifies, and the new model is in every picker, ready', async () => {
    const { models, reg, call } = make();
    const r = await call<LocalDownload>('POST', '/local-models/qwen3-8b/download', {});
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ model: 'qwen3-8b', resumed: false });
    // A second press answers the same download.
    expect((await call<LocalDownload>('POST', '/local-models/qwen3-8b/download', {})).body.id).toBe(
      r.body.id,
    );
    const mid = await until(models, r.body.id, (d) => (d.completed ?? 0) > 0);
    expect(mid.total).toBe(1010);
    const done = await until(models, r.body.id, (d) => d.status === 'done');
    expect(done).toMatchObject({ completed: 1010, total: 1010, model_id: 'ollama/qwen3:8b', error: null });
    const added = reg.all().find((m) => m.id === 'ollama/qwen3:8b');
    expect(added).toMatchObject({
      provider: 'ollama',
      provider_model: 'qwen3:8b',
      enabled: true,
      display_name: 'Qwen3 8B (Ollama)',
      context_window: 8192,
      capabilities: ['tools'],
    });
    const view = await call<LocalModelsView>('GET', '/local-models');
    expect(view.body.items.find((i) => i.id === 'qwen3-8b')).toMatchObject({
      installed: true,
      model_id: 'ollama/qwen3:8b',
    });
    expect((await call<LocalDownload>('GET', `/local-models/downloads/${r.body.id}`)).body.status).toBe(
      'done',
    );
  });

  it('switches on the configured model that names the same tag, instead of adding another', async () => {
    const reg = registry([
      { id: 'ollama/qwen3-14b', provider: 'openai-compatible', provider_model: 'qwen3:14b', enabled: false },
    ]);
    const { models, call } = make({ reg });
    const r = await call<LocalDownload>('POST', '/local-models/qwen3-14b/download', {});
    const done = await until(models, r.body.id, (d) => d.status === 'done');
    expect(done.model_id).toBe('ollama/qwen3-14b');
    expect(reg.all().find((m) => m.id === 'ollama/qwen3-14b')?.enabled).toBe(true);
    expect(reg.custom()).toEqual([]);
  });

  it('cancel stops it; starting again resumes from what Ollama kept', async () => {
    fake.mode = 'slow';
    const { models, call } = make();
    const r = await call<LocalDownload>('POST', '/local-models/llama3-2-3b/download', {});
    await until(models, r.body.id, (d) => (d.completed ?? 0) >= 250);
    const c = await call<LocalDownload>('POST', `/local-models/downloads/${r.body.id}/cancel`);
    expect(c.status).toBe(200);
    const stopped = await until(models, r.body.id, (d) => d.status === 'cancelled');
    expect(stopped.finished_at).not.toBeNull();
    fake.mode = 'ok';
    fake.have.delete('llama3.2:3b');
    const again = await call<LocalDownload>('POST', '/local-models/llama3-2-3b/download', {});
    expect(again.body.resumed).toBe(true);
    const done = await until(models, again.body.id, (d) => d.status === 'done');
    expect(done.model_id).toBe('ollama/llama3.2:3b');
  });

  it('a stall, a cut line and a refusal each fail plainly, and a resume finishes the job', async () => {
    const { models, call } = make();
    fake.mode = 'stall';
    const s = await call<LocalDownload>('POST', '/local-models/qwen3-8b/download', {});
    const stalled = await until(models, s.body.id, (d) => d.status === 'failed');
    expect(stalled.error).toMatchObject({ code: 'local_model.pull_failed' });
    expect(stalled.error?.title).toMatch(/stalled/);
    expect(stalled.error?.hint).toMatch(/Resume/);

    fake.mode = 'cut';
    fake.have.delete('qwen3:8b');
    const cut = await call<LocalDownload>('POST', '/local-models/qwen3-8b/download', {});
    expect(cut.body.resumed).toBe(true);
    const broken = await until(models, cut.body.id, (d) => d.status === 'failed');
    expect(broken.error?.code).toBe('local_model.pull_failed');

    fake.mode = 'refuse';
    const ref = await call<LocalDownload>('POST', '/local-models/qwen3-8b/download', {});
    const refused = await until(models, ref.body.id, (d) => d.status === 'failed');
    expect(refused.error).toMatchObject({ code: 'local_model.pull_refused' });
    expect(refused.error?.hint).toContain('file does not exist');

    fake.mode = 'ok';
    const fin = await call<LocalDownload>('POST', '/local-models/qwen3-8b/download', {});
    expect((await until(models, fin.body.id, (d) => d.status === 'done')).completed).toBe(1010);
  });

  it('a pull Ollama then cannot show is not called done', async () => {
    fake.showMissing = true;
    fake.have.delete('qwen3:8b');
    const { models, call } = make();
    const r = await call<LocalDownload>('POST', '/local-models/qwen3-8b/download', {});
    const d = await until(models, r.body.id, (x) => x.status === 'failed');
    expect(d.error?.code).toBe('local_model.not_verified');
  });

  it('refuses what will not fit: never past a full disk, past memory only when asked', async () => {
    const { models, call } = make();
    const disk = await call<{ error: { code: string; hint: string } }>(
      'POST',
      '/local-models/huge/download',
      { anyway: true },
    );
    expect(disk.status).toBe(507);
    expect(disk.body.error.code).toBe('local_model.no_disk');
    const big = await call<{ error: { code: string; hint: string } }>(
      'POST',
      '/local-models/gpt-oss-20b/download',
      {},
    );
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('local_model.too_big');
    expect(big.body.error.hint).toMatch(/Needs about 24 GB of memory/);
    const anyway = await call<LocalDownload>('POST', '/local-models/gpt-oss-20b/download', { anyway: true });
    expect(anyway.status).toBe(202);
    await models.settled();
    expect((await call('POST', '/local-models/nope/download', {})).status).toBe(404);
    expect((await call('GET', '/local-models/downloads/lmd_nope')).status).toBe(404);
    expect((await call('POST', '/local-models/downloads/lmd_nope/cancel')).status).toBe(404);
  });

  it('the embedder comes through the knowledge service (fastembed’s own download)', async () => {
    const asked: string[] = [];
    const kn = {
      get: async (path: string) => {
        asked.push(path);
        return { installed: false };
      },
      stream: async (_m: string, path: string, init: { body?: string }) => {
        asked.push(`${path} ${init.body}`);
        return new Response(JSON.stringify({ model_key: 'local/BAAI/bge-small-en-v1.5', dim: 384 }));
      },
    };
    const reg = registry([
      {
        id: 'local/bge-small-en-v1.5',
        provider: 'local',
        provider_model: 'BAAI/bge-small-en-v1.5',
        enabled: false,
      },
    ]);
    const { models, call } = make({ kn, reg });
    const r = await call<LocalDownload>('POST', '/local-models/bge/download', {});
    const done = await until(models, r.body.id, (d) => d.status === 'done');
    expect(done.model_id).toBe('local/bge-small-en-v1.5');
    expect(asked).toContain('/embeddings/prepare {"model":"BAAI/bge-small-en-v1.5"}');
    expect(reg.all()[0]?.enabled).toBe(true);
    const without = make();
    const e = await without.call<{ error: { code: string } }>('POST', '/local-models/bge/download', {});
    expect(e.body.error.code).toBe('local_model.embedder_unavailable');
  });
});
