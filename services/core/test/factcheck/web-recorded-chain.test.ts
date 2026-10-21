/**
 * The web chain with a recorded Anthropic reply: a route that returns pages
 * without text hands over to the next, and a timeout is named in the rest.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { webSearchChain } from '../../src/factcheck/web-models';
import { MemorySettings } from '../../src/settings';
import { fakeModel } from '../gateway/fake-provider';

const recorded = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'web', 'anthropic.json'), 'utf8'),
).response;

const model = (provider: string, id: string, secret: string): ModelConfig => ({
  ...fakeModel(id, 'script'),
  id: `${provider}/${id}`,
  provider,
  provider_model: id,
  price: { input_per_mtok: 0.1, output_per_mtok: 0.5 },
  secret,
});
const ROUTER = model('openrouter', 'r', 'OPENROUTER_API_KEY');
const HAIKU = model('anthropic', 'claude-haiku-5-5', 'ANTHROPIC_API_KEY');

const chain = (fetcher: typeof fetch) =>
  webSearchChain({
    models: () => [ROUTER, HAIKU],
    secret: async () => 'k',
    settings: new MemorySettings(),
    capUsd: () => 1,
    fetch: fetcher,
    now: () => new Date(2026, 9, 21, 12),
  });

const bare = { choices: [{ message: { content: '[{"title":"T","url":"https://a.example/x"}]' } }] };
const sig = () => new AbortController().signal;

describe('the chain with a recorded reply', () => {
  it('tries the next route when a route returns pages without text', async () => {
    const seen: string[] = [];
    const f: typeof fetch = async (input) => {
      const host = new URL(String(input)).hostname;
      seen.push(host);
      return new Response(JSON.stringify(host.startsWith('openrouter') ? bare : recorded), { status: 200 });
    };
    const hits = await chain(f).search('Amazon longest river', sig());
    expect(seen).toEqual(['openrouter.ai', 'api.anthropic.com']);
    expect(hits.length).toBeGreaterThan(2);
    expect(hits[0]?.via?.route).toBe('anthropic');
  });

  it("puts a timeout in the route's rest reason", async () => {
    const f: typeof fetch = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const c = chain(f);
    await expect(c.search('q', sig())).rejects.toBeDefined();
    const d = await c.describe();
    expect(d.routes.find((r) => r.id === 'openrouter')?.reason).toBe('it did not answer within 25 s');
  });
});
