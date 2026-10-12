/**
 * Images in threads (docs/images.md): what the store accepts, the three
 * provider protocols against fakes, image_generate under scopes and the
 * permission check's resource, the remote-image proxy's consent and limits,
 * vision input in the gateway, and the refusal for a model without vision.
 * No real provider is called.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AncileError, type ImagesFile, type ModelConfig, sniffImage } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engines, noVision } from '../../src/engines';
import type { Engine } from '../../src/engines/types';
import { toSdkMessages } from '../../src/gateway/convert';
import { imagesFor } from '../../src/gateway/providers';
import { endpointOf, type FetchLike, generateWith } from '../../src/images/providers';
import { fetchRemoteImage, isPrivateAddress } from '../../src/images/remote';
import { imageRoutes } from '../../src/images/routes';
import { ImageService } from '../../src/images/service';
import { ImageStore, MemoryImageRows } from '../../src/images/store';
import { imageTool } from '../../src/images/tool';
import { errorHandler } from '../../src/obs/errors';
import { checkToolCall, resolveScope } from '../../src/scopes';
import { MemoryThreadRepo } from '../../src/threads/repo';
import { png } from './fixtures';

const WS = 'wsp_test';
const CONFIG: ImagesFile = {
  version: 1,
  providers: [
    {
      id: 'openai',
      display_name: 'OpenAI images',
      api: 'openai',
      kind: 'cloud',
      model: 'gpt-image-1',
      price_usd: 0.04,
      enabled: true,
    },
    {
      id: 'local',
      display_name: 'Forge here',
      api: 'a1111',
      kind: 'local',
      model: 'default',
      base_url: 'http://127.0.0.1:7860',
      enabled: true,
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const scopeFor = (priv: boolean, leaves = true) =>
  resolveScope({
    notebookId: 'nb_1',
    threadId: 'thr_1',
    private: priv,
    notebook: leaves ? null : { data_leaves_machine: false },
    thread: null,
  });

/** A response's JSON, loosely typed for assertions. */
const j = async (r: Response) => (await r.json()) as { error: { code: string }; [k: string]: unknown };

const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as AncileError).code;
  }
  return 'no error';
};

describe('image store', () => {
  let dir: string;
  let store: ImageStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-img-'));
    store = new ImageStore(dir, new MemoryImageRows());
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('takes PNG, JPEG, WebP and GIF by their bytes, and refuses SVG, text and anything over 20 MB', async () => {
    expect(sniffImage(Buffer.from('ffd8ffe0', 'hex'))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    expect(await errCode(store.put({ threadId: null, bytes: svg, source: 'attached' }))).toBe(
      'image.type_not_allowed',
    );
    const big = Buffer.concat([png(), Buffer.alloc(20 * 1024 * 1024)]);
    expect(await errCode(store.put({ threadId: null, bytes: big, source: 'attached' }))).toBe(
      'image.too_large',
    );
    expect(await store.get('../etc/passwd')).toBeNull();
  });
});

describe('image providers', () => {
  const signal = new AbortController().signal;
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fake =
    (answer: unknown, status = 200): FetchLike =>
    async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('authorization'),
      });
      return json(answer, status);
    };
  beforeEach(() => {
    calls.length = 0;
  });
  const b64 = png(2, 2).toString('base64');

  it('speaks OpenAI images, OpenRouter image models and Automatic1111 / Forge', async () => {
    const openai = CONFIG.providers[0];
    const local = CONFIG.providers[1];
    if (!openai || !local) throw new Error('config');
    const a = await generateWith(
      openai,
      { prompt: 'a pump', n: 2 },
      { apiKey: 'k', signal, fetch: fake({ data: [{ b64_json: b64 }, { b64_json: b64 }] }) },
    );
    expect(a.images).toHaveLength(2);
    expect(a.costUsd).toBeCloseTo(0.08);
    expect(calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/images/generations', auth: 'Bearer k' });
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-image-1', prompt: 'a pump', n: 2 });

    const or = {
      id: 'or',
      display_name: 'OR',
      api: 'openrouter' as const,
      kind: 'cloud' as const,
      model: 'google/gemini-2.5-flash-image',
      enabled: true,
    };
    const b = await generateWith(
      or,
      { prompt: 'a pump', n: 1 },
      {
        apiKey: 'k',
        signal,
        fetch: fake({
          choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }],
          usage: { cost: 0.002 },
        }),
      },
    );
    expect(b).toMatchObject({ costUsd: 0.002 });
    expect(calls[1]?.body).toMatchObject({ modalities: ['image', 'text'] });

    const c = await generateWith(
      local,
      { prompt: 'a pump', size: '512x512', n: 1 },
      { apiKey: undefined, signal, fetch: fake({ images: [b64] }) },
    );
    expect(c.costUsd).toBe(0);
    expect(calls[2]).toMatchObject({ url: 'http://127.0.0.1:7860/sdapi/v1/txt2img', auth: null });
    expect(calls[2]?.body).toMatchObject({ width: 512, height: 512, batch_size: 1 });
  });

  it('says plainly when a provider fails or answers without an image', async () => {
    const openai = CONFIG.providers[0];
    if (!openai) throw new Error('config');
    expect(
      await errCode(
        generateWith(
          openai,
          { prompt: 'x', n: 1 },
          { apiKey: 'k', signal, fetch: fake({ error: 'bad key' }, 401) },
        ),
      ),
    ).toBe('image.provider_failed');
    expect(
      await errCode(
        generateWith(openai, { prompt: 'x', n: 1 }, { apiKey: 'k', signal, fetch: fake({ data: [] }) }),
      ),
    ).toBe('image.provider_failed');
  });
});

describe('image_generate', () => {
  let dir: string;
  let threads: MemoryThreadRepo;
  let rows: MemoryImageRows;
  let scope = scopeFor(false);
  let secrets: Record<string, string>;
  let counted: string[];
  const make = (config: ImagesFile | null = CONFIG) =>
    new ImageService({
      store: new ImageStore(dir, rows),
      config: () => config,
      secrets: { get: async (n) => secrets[n] },
      scopes: { effective: async () => scope },
      threads,
      fetch: async (url) =>
        url.includes('openai')
          ? json({ data: [{ b64_json: png(5, 5).toString('base64') }] })
          : json({ images: [png(6, 6).toString('base64')] }),
      onImage: (s, k) => counted.push(`${s}:${k ?? '-'}`),
    });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-gen-'));
    threads = new MemoryThreadRepo();
    rows = new MemoryImageRows();
    scope = scopeFor(false);
    secrets = { OPENAI_API_KEY: 'sk-test' };
    counted = [];
    await threads.createThread({ id: 'thr_1', workspace_id: WS, notebook_id: 'nb_1' });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('makes an image, keeps it as a thread attachment with its prompt, model and cost, and counts only closed sets', async () => {
    const svc = make();
    const r = await svc.generate({
      threadId: 'thr_1',
      args: { prompt: 'a red pump' },
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({
      provider: 'openai',
      provider_kind: 'cloud',
      model: 'gpt-image-1',
      cost_usd: 0.04,
    });
    expect(r.images[0]).toMatchObject({ width: 5, height: 5 });
    const [row] = await rows.forThread('thr_1');
    expect(row).toMatchObject({
      source: 'generated',
      prompt: 'a red pump',
      provider: 'openai',
      alt: 'a red pump',
    });
    expect(counted).toEqual(['generated:cloud']);
  });

  it('checks the provider URL as its resource, so a local-only scope refuses a cloud provider and allows a local one', async () => {
    const svc = make();
    await svc.providers();
    const tool = imageTool(svc);
    expect(tool).toMatchObject({ action: 'image.generate', tier: 'gated' });
    const cloud = tool.resource({ prompt: 'x' });
    const local = tool.resource({ prompt: 'x', provider: 'local' });
    expect(cloud).toBe(`http:${endpointOf(CONFIG.providers[0] as never)}`);
    const priv = scopeFor(true);
    expect(checkToolCall(priv, { action: 'image.generate', resource: cloud })).toMatchObject({
      ok: false,
      code: 'scope.private_notebook',
    });
    expect(
      checkToolCall(scopeFor(false, false), { action: 'image.generate', resource: cloud }),
    ).toMatchObject({ ok: false, code: 'scope.data_stays_local' });
    expect(checkToolCall(priv, { action: 'image.generate', resource: local }).ok).toBe(true);

    // And the service holds the same floor itself.
    scope = priv;
    expect(
      await errCode(
        svc.generate({ threadId: 'thr_1', args: { prompt: 'x' }, signal: new AbortController().signal }),
      ),
    ).toBe('scope.private_notebook');
    const ok = await svc.generate({
      threadId: 'thr_1',
      args: { prompt: 'x', provider: 'local' },
      signal: new AbortController().signal,
    });
    expect(ok).toMatchObject({ provider_kind: 'local', cost_usd: 0 });
  });

  it('says what to set up when no provider is ready, and refuses bad arguments', async () => {
    secrets = {};
    const svc = make({ version: 1, providers: [CONFIG.providers[0] as never] });
    const list = await svc.providers();
    expect(list.default_id).toBeNull();
    expect(list.empty_hint).toMatch(/No image provider is set up/);
    expect(list.items[0]?.reason).toBe('Add OPENAI_API_KEY in Settings → API keys');
    expect(
      await errCode(
        svc.generate({ threadId: 'thr_1', args: { prompt: 'x' }, signal: new AbortController().signal }),
      ),
    ).toBe('image.no_provider');
    expect(
      await errCode(
        make(null).generate({
          threadId: 'thr_1',
          args: { prompt: 'x' },
          signal: new AbortController().signal,
        }),
      ),
    ).toBe('image.no_provider');
    expect(
      await errCode(
        svc.generate({
          threadId: 'thr_1',
          args: { prompt: 'x', provider: 'nope' },
          signal: new AbortController().signal,
        }),
      ),
    ).toBe('image.provider_unknown');
    const tool = imageTool(svc);
    expect(
      await errCode(
        tool.execute({ prompt: '' }, { idempotencyKey: 'k', signal: new AbortController().signal }),
      ),
    ).toBe('image.bad_args');
  });

  it('attaches images to a turn only from their own thread, at most eight', async () => {
    const svc = make();
    const a = await svc.attach('thr_1', png(2, 3), 'chart');
    expect(counted).toEqual(['attached:-']);
    expect(await svc.partsFor('thr_1', [a.id])).toEqual([
      { type: 'image', url: a.url, mime: 'image/png', image_id: a.id, alt: 'chart', width: 2, height: 3 },
    ]);
    expect(await errCode(svc.partsFor('thr_other', [a.id]))).toBe('image.not_found');
    expect(
      await errCode(
        svc.partsFor(
          'thr_1',
          Array.from({ length: 9 }, (_, i) => `img_${i}`),
        ),
      ),
    ).toBe('image.too_many');
    expect(await svc.bytes(a.id)).toEqual({ mime: 'image/png', data: png(2, 3).toString('base64') });
  });
});

describe('remote images', () => {
  const resolve = async (h: string) => (h === 'inside.test' ? ['10.0.0.5'] : ['93.184.216.34']);

  it('knows the addresses an image may never come from', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:2800:220:1::1')).toBe(false);
  });

  it('fetches a public image, and refuses inside addresses, other schemes, non-images and oversize answers', async () => {
    const ok = await fetchRemoteImage('https://example.org/a.png', {
      resolve,
      fetch: async () => new Response(png(1, 1)),
    });
    expect(ok.mime).toBe('image/png');
    expect(
      await errCode(
        fetchRemoteImage('http://inside.test/a.png', { resolve, fetch: async () => new Response(png()) }),
      ),
    ).toBe('image.remote_blocked');
    expect(await errCode(fetchRemoteImage('http://127.0.0.1/a.png', { resolve }))).toBe(
      'image.remote_blocked',
    );
    expect(await errCode(fetchRemoteImage('file:///etc/passwd', { resolve }))).toBe('image.remote_blocked');
    expect(await errCode(fetchRemoteImage('https://example.org:8443/a.png', { resolve }))).toBe(
      'image.remote_blocked',
    );
    // A redirect into the network is checked again.
    const redirect: FetchLike = async (url) =>
      url.includes('example.org')
        ? new Response(null, { status: 302, headers: { location: 'http://inside.test/x.png' } })
        : new Response(png());
    expect(await errCode(fetchRemoteImage('https://example.org/a.png', { resolve, fetch: redirect }))).toBe(
      'image.remote_blocked',
    );
    expect(
      await errCode(
        fetchRemoteImage('https://example.org/a.svg', { resolve, fetch: async () => new Response('<svg/>') }),
      ),
    ).toBe('image.type_not_allowed');
    expect(
      await errCode(
        fetchRemoteImage('https://example.org/big.png', {
          resolve,
          maxBytes: 64,
          fetch: async () => new Response(Buffer.concat([png(), Buffer.alloc(100)])),
        }),
      ),
    ).toBe('image.too_large');
  });

  it('loads a remote image only from a host allowed for the notebook, and never where nothing may leave', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ancile-remote-'));
    const threads = new MemoryThreadRepo();
    await threads.createThread({ id: 'thr_1', workspace_id: WS, notebook_id: 'nb_1' });
    await threads.createThread({ id: 'thr_2', workspace_id: WS, notebook_id: 'nb_1' });
    let scope = scopeFor(false);
    const svc = new ImageService({
      store: new ImageStore(dir, new MemoryImageRows()),
      config: () => null,
      secrets: { get: async () => undefined },
      scopes: { effective: async () => scope },
      threads,
      resolve,
      fetch: async () => new Response(png(1, 1)),
    });
    const app = new Hono();
    app.onError(errorHandler);
    app.route('/', imageRoutes({ images: svc, threads, workspaceId: WS }));
    const url = encodeURIComponent('https://example.org/a.png');
    try {
      const before = await app.request(`/threads/thr_1/images/remote?url=${url}`);
      expect(before.status).toBe(403);
      expect((await j(before)).error.code).toBe('image.remote_not_allowed');
      const allow = await app.request('/threads/thr_1/image-hosts', {
        method: 'POST',
        body: JSON.stringify({ host: 'Example.org' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(await allow.json()).toEqual({
        remembered_in: 'notebook',
        hosts: ['example.org'],
        allowed: true,
      });
      // Remembered for the notebook: another thread in it loads it too.
      const after = await app.request(`/threads/thr_2/images/remote?url=${url}`);
      expect(after.status).toBe(200);
      expect(after.headers.get('content-type')).toBe('image/png');
      expect(after.headers.get('x-content-type-options')).toBe('nosniff');
      scope = scopeFor(true);
      const priv = await app.request(`/threads/thr_2/images/remote?url=${url}`);
      expect((await j(priv)).error.code).toBe('scope.private_notebook');
      expect((await j(await app.request('/threads/thr_2/image-hosts'))).allowed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('attaches by upload and serves the bytes only for this workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ancile-up-'));
    const threads = new MemoryThreadRepo();
    await threads.createThread({ id: 'thr_1', workspace_id: WS });
    await threads.createThread({ id: 'thr_x', workspace_id: 'wsp_other' });
    const svc = new ImageService({
      store: new ImageStore(dir, new MemoryImageRows()),
      config: () => null,
      secrets: { get: async () => undefined },
      threads,
    });
    const app = new Hono();
    app.onError(errorHandler);
    app.route('/', imageRoutes({ images: svc, threads, workspaceId: WS }));
    try {
      const form = new FormData();
      form.set('file', new File([png(7, 7)], 'shot.png', { type: 'image/png' }));
      const up = await app.request('/threads/thr_1/images', { method: 'POST', body: form });
      expect(up.status).toBe(201);
      const rec = await j(up);
      expect(rec).toMatchObject({ source: 'attached', alt: 'shot.png', width: 7 });
      const got = await app.request(`/images/${rec.id}`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-security-policy')).toContain('sandbox');
      const bad = new FormData();
      bad.set('file', new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
      expect(
        (await j(await app.request('/threads/thr_1/images', { method: 'POST', body: bad }))).error.code,
      ).toBe('image.type_not_allowed');
      expect((await app.request('/threads/thr_x/images', { method: 'POST', body: form })).status).toBe(404);
      expect((await j(await app.request('/images/providers'))).empty_hint).toMatch(/No image provider/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('vision input', () => {
  const parts = [
    { type: 'text' as const, text: 'What is this?' },
    { type: 'image' as const, url: '/api/v1/images/img_A', mime: 'image/png', image_id: 'img_A' },
  ];

  it('gives a vision model the picture, and any other model a marked note', async () => {
    const images = await imagesFor([{ role: 'user', content: '', parts }], async () => ({
      bytes: png(),
      mime: 'image/png',
    }));
    const seen = toSdkMessages([{ role: 'user', content: '', parts }], { tools: true, vision: true, images });
    expect(seen[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', mediaType: 'image/png' },
      ],
    });
    const blind = toSdkMessages([{ role: 'user', content: '', parts }], { tools: true });
    expect(blind[0]).toEqual({ role: 'user', content: 'What is this?\n[Image not shown]\n' });
  });

  it('refuses images for a model without vision, before anything is written', async () => {
    let started = false;
    const engine = (images: boolean): Engine => ({
      id: 'gateway',
      kind: 'gateway',
      displayName: 'g',
      modelPrefix: null,
      capabilities: () => ({
        streaming: true,
        tools: true,
        images,
        own_context: false,
        context_window: null,
      }),
      status: async () => ({ available: true, reason: null }),
      start: async () => {
        started = true;
        return { run_id: 'r', user_message_id: 'u', assistant_message_id: 'a', model_id: null };
      },
    });
    const model = {
      id: 'cheap/text',
      capabilities: ['tools'],
      provider: 'openrouter',
    } as unknown as ModelConfig;
    const make = (vision: boolean) =>
      new Engines({
        registry: { get: () => model, chain: () => [model] } as never,
        gateway: engine(vision),
        claudeCode: engine(true),
        scopeOf: async () => scopeFor(false),
        images: {
          partsFor: async () => [
            { type: 'image', url: '/api/v1/images/img_A', mime: 'image/png', image_id: 'img_A' },
          ],
        },
      });
    const thread = {
      id: 'thr_1',
      workspace_id: WS,
      notebook_id: null,
      settings: {},
      active_head_id: null,
    } as never;
    const req = {
      text: 'look',
      parentId: undefined,
      model: 'cheap/text',
      idempotencyKey: 'k'.repeat(8),
      imageIds: ['img_A'],
    };
    expect(await errCode(make(false).send(thread, req))).toBe('image.model_no_vision');
    expect(started).toBe(false);
    await make(true).send(thread, req);
    expect(started).toBe(true);
    expect(noVision('cheap/text').title).toBe("cheap/text can't see images.");
  });
});
