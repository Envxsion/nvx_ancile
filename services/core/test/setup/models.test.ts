/**
 * Adding models (DESIGN §16.7): OpenRouter's catalogue filled in from a
 * recorded fixture, OpenAI-compatible endpoints with their key kept in
 * the encrypted store and never returned, and added models persisting.
 */
import { readFileSync } from 'node:fs';
import type { CatalogueModel, ModelInfo } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogueSource } from '../../src/gateway/catalogue';
import { endpointSecret } from '../../src/setup/models';
import { type Harness, harness } from '../support/harness';

const OPENROUTER = JSON.parse(
  readFileSync(new URL('../fixtures/openrouter-models.json', import.meta.url), 'utf8'),
) as unknown;

const seen: { url: string; key?: string }[] = [];
const fixtures: CatalogueSource = {
  openRouter: async () => OPENROUTER,
  endpoint: async (url, key) => {
    seen.push({ url, ...(key && { key }) });
    return { data: [{ id: 'Qwen/Qwen3-Coder-30B', max_model_len: 65536, owned_by: 'vllm' }] };
  },
};

let h: Harness;
afterEach(async () => h?.close());

describe('adding models', () => {
  it('browses OpenRouter and adds a model with its price, context and capabilities filled in', async () => {
    h = await harness({ catalogue: fixtures });
    const cat = await h.call<{ items: CatalogueModel[] }>('POST', '/models/catalogue', {
      source: 'openrouter',
      q: 'llama',
    });
    expect(cat.body.items.map((m) => m.provider_model)).toEqual(['meta-llama/llama-4-maverick']);
    const llama = cat.body.items[0] as CatalogueModel;
    expect(llama.price).toEqual({ input_per_mtok: 0.15, output_per_mtok: 0.6 });
    expect(llama.capabilities).toEqual(expect.arrayContaining(['tools', 'vision', 'json']));

    const added = await h.call<ModelInfo>('POST', '/models', {
      source: 'openrouter',
      provider_model: 'meta-llama/llama-4-maverick',
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      id: 'openrouter/meta-llama__llama-4-maverick',
      display_name: 'Meta: Llama 4 Maverick',
      context_window: 1048576,
      family: 'meta-llama',
      custom: true,
      status: 'needs_key', // no OpenRouter key yet
    });
    const again = await h.call('POST', '/models', {
      source: 'openrouter',
      provider_model: 'meta-llama/llama-4-maverick',
    });
    expect(again.status).toBe(409);
    // In the catalogue it now shows as added.
    const after = await h.call<{ items: CatalogueModel[] }>('POST', '/models/catalogue', {
      source: 'openrouter',
    });
    expect(after.body.items.find((m) => m.provider_model === 'meta-llama/llama-4-maverick')?.added).toBe(
      true,
    );
  });

  it('adds a model on an OpenAI-compatible server, keeps its key secret, and can be edited and removed', async () => {
    h = await harness({ catalogue: fixtures });
    const base = 'https://abc123-8000.proxy.runpod.net/v1';
    const listed = await h.call<{ items: CatalogueModel[] }>('POST', '/models/catalogue', {
      source: 'openai-compatible',
      base_url: base,
      api_key: 'sk-pod-secret',
    });
    expect(listed.body.items[0]).toMatchObject({
      provider_model: 'Qwen/Qwen3-Coder-30B',
      context_window: 65536,
    });
    expect(seen.at(-1)).toEqual({ url: base, key: 'sk-pod-secret' });

    const added = await h.call<ModelInfo>('POST', '/models', {
      source: 'openai-compatible',
      base_url: base,
      api_key: 'sk-pod-secret',
      provider_model: 'Qwen/Qwen3-Coder-30B',
      display_name: 'Coder on my pod',
      context_window: 65536,
    });
    expect(added.status).toBe(201);
    const id = added.body.id;
    expect(id).toBe('endpoint-abc123-8000-proxy-runpod-net/Qwen__Qwen3-Coder-30B');
    expect(added.body.status).toBe('ready');
    // The key is stored encrypted and never comes back.
    const secret = endpointSecret('endpoint-abc123-8000-proxy-runpod-net');
    expect(await h.secrets.get(secret)).toBe('sk-pod-secret');
    const list = await h.call<{ items: ModelInfo[] }>('GET', '/models');
    expect(JSON.stringify(list.body)).not.toContain('sk-pod-secret');

    // A second listing reuses the stored key.
    await h.call('POST', '/models/catalogue', { source: 'openai-compatible', base_url: base });
    expect(seen.at(-1)?.key).toBe('sk-pod-secret');

    const edited = await h.call<ModelInfo>('PATCH', `/models/${id}`, {
      display_name: 'Pod coder',
      enabled: false,
    });
    expect(edited.body).toMatchObject({ display_name: 'Pod coder', status: 'disabled' });

    expect((await h.call('DELETE', `/models/${id}`)).status).toBe(204);
    expect((await h.call<{ items: ModelInfo[] }>('GET', '/models')).body.items.some((m) => m.id === id)).toBe(
      false,
    );
    expect(await h.secrets.get(secret)).toBeUndefined();
  });

  it('persists added models across a registry reload, and leaves config models alone', async () => {
    h = await harness({ catalogue: fixtures });
    await h.call('POST', '/models', {
      source: 'anthropic',
      provider_model: 'claude-opus-5-5-20261001',
      display_name: 'Opus (pinned)',
    });
    await h.registry.refresh();
    const m = h.registry.get('anthropic/claude-opus-5-5-20261001');
    expect(m?.family).toBe('anthropic');
    const configModel = h.registry.all().find((x) => !h.registry.isCustom(x.id) && x.provider !== 'fake');
    if (configModel) {
      const r = await h.call('PATCH', `/models/${configModel.id}`, { display_name: 'Renamed' });
      expect(r.status).toBe(409);
      expect((await h.call('DELETE', `/models/${configModel.id}`)).status).toBe(409);
    }
  });

  it('refuses an OpenAI-compatible model without its address', async () => {
    h = await harness({ catalogue: fixtures });
    const r = await h.call('POST', '/models', { source: 'openai-compatible', provider_model: 'x' });
    expect(r.status).toBe(400);
  });
});
