/**
 * The web routes against real provider replies, recorded with
 * POST /diagnostics/web-record (docs/testing.md). No network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { parseHitList, ROUTES } from '../../src/factcheck/web-models';
import { fakeModel } from '../gateway/fake-provider';

const fixture = (route: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'web', `${route}.json`), 'utf8')) as {
    response: unknown;
  };

const HAIKU: ModelConfig = {
  ...fakeModel('claude-haiku-5-5', 'script'),
  id: 'anthropic/claude-haiku-5-5',
  provider: 'anthropic',
  provider_model: 'claude-haiku-5-5',
  price: { input_per_mtok: 1, output_per_mtok: 5 },
};

const replay =
  (body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status: 200 });

describe('recorded Anthropic reply', () => {
  it('yields the quoted pages from the fenced JSON answer', async () => {
    const route = ROUTES.find((r) => r.id === 'anthropic');
    const r = await route?.run(HAIKU, 'k', 'Amazon longest river', {
      fetch: replay(fixture('anthropic').response),
      signal: new AbortController().signal,
      workspace: undefined,
    });
    expect(r?.hits.length).toBeGreaterThanOrEqual(3);
    expect(r?.hits.every((h) => h.snippet.length > 0 && /^https:/.test(h.url))).toBe(true);
    expect(r?.costUsd).toBeGreaterThan(0.01);
  });
});

describe('model replies in other shapes', () => {
  const item = '{"title":"T","url":"https://a.example/x","snippet":"Everest is 8,849 m."}';
  it.each([
    ['a code fence', `\`\`\`json\n[${item}]\n\`\`\``],
    ['a sentence before and after', `Here you go: [${item}] Hope that helps [1].`],
    ['an object holding the list', `{"results":[${item}]}`],
    ['one page object', item],
    ['brackets in the quote', '[{"title":"T","url":"https://a.example/x","snippet":"See [1] and ] here."}]'],
  ])('reads %s', (_n, text) => {
    expect(parseHitList(text)).toHaveLength(1);
  });

  it('keeps nothing without a quote, a link, or a list', () => {
    expect(parseHitList('[{"title":"T","url":"https://a.example/x"}]')).toEqual([]);
    expect(parseHitList('[{"title":"T","url":"javascript:1","snippet":"x"}]')).toEqual([]);
    expect(parseHitList('I could not find anything.')).toEqual([]);
  });
});
