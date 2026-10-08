import { describe, expect, it } from 'vitest';
import {
  buildMemoryPack,
  type InjectFile,
  memoryBudget,
  PACK_HEADER,
  rankEntries,
  resolveMemoryPaths,
} from '../../src/memory/inject';

/** One token per word keeps the arithmetic readable. */
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const file = (path: string, priority: number, share: number, n: number, words5 = true): InjectFile => ({
  path,
  commit: 'abc123',
  title: path.split('/').pop() as string,
  priority,
  budgetShare: share,
  entries: Array.from({ length: n }, (_, i) => ({
    key: `${path}#${i}`,
    text: words5 ? `${path} entry ${i} four five` : `${path} ${i}`,
    confidence: 1 - i / 100,
  })),
});

describe('buildMemoryPack', () => {
  it('never exceeds the budget and drops whole entries only', () => {
    const files = [file('AGENTS.md', 100, 0.5, 20), file('USER.md', 90, 0.5, 20)];
    const pack = buildMemoryPack(files, 120, words);
    expect(pack.tokens).toBeLessThanOrEqual(120);
    for (const line of pack.text.split('\n').filter((l) => l.startsWith('- '))) {
      expect(line).toMatch(/entry \d+ four five$/);
    }
    expect(pack.truncated).toBeGreaterThan(0);
    expect(pack.text).toMatch(/\(\+\d+ more entries not shown\)/);
  });

  it('keeps rank order inside a file', () => {
    const pack = buildMemoryPack([file('USER.md', 90, 1, 10)], 60, words);
    const keys = pack.files[0]?.entries ?? [];
    expect(keys).toEqual(keys.slice().sort((a, b) => Number(a.split('#')[1]) - Number(b.split('#')[1])));
    expect(keys[0]).toBe('USER.md#0');
  });

  it('puts higher-priority files first and gives leftovers back in priority order', () => {
    const small = file('AGENTS.md', 100, 0.5, 1); // uses little of its share
    const big = file('USER.md', 90, 0.2, 30);
    const pack = buildMemoryPack([big, small], 200, words);
    expect(pack.text.indexOf('AGENTS.md')).toBeLessThan(pack.text.indexOf('USER.md'));
    const userTokens = pack.files.find((f) => f.path === 'USER.md')?.tokens ?? 0;
    expect(userTokens).toBeGreaterThan(Math.floor((200 - 30) * 0.2)); // more than its own share
  });

  it('is empty when nothing applies, and labels memory as context', () => {
    expect(buildMemoryPack([], 1000, words).text).toBe('');
    const pack = buildMemoryPack([file('USER.md', 90, 1, 1)], 1000, words);
    expect(pack.text.startsWith(PACK_HEADER)).toBe(true);
  });

  it('ranks by relevance, then confidence, then recency', () => {
    const ranked = rankEntries([
      { key: 'a', text: '', confidence: 0.9, at: '2026-01-01' },
      { key: 'b', text: '', confidence: 0.9, at: '2026-05-01' },
      { key: 'c', text: '', confidence: 0.5, relevance: 0.9 },
    ]);
    expect(ranked.map((e) => e.key)).toEqual(['c', 'b', 'a']);
  });
});

describe('resolveMemoryPaths and budget', () => {
  const types = [
    { name: 'agents', path: 'AGENTS.md', scope: 'global' as const, priority: 100, budgetShare: 0.25 },
    {
      name: 'projects',
      path: 'PROJECTS/<notebook>.md',
      scope: 'notebook' as const,
      priority: 80,
      budgetShare: 0.25,
    },
    { name: 'models', path: 'MODELS/<model>.md', scope: 'model' as const, priority: 50, budgetShare: 0.1 },
  ];

  it('skips notebook memory outside a notebook and resolves the answering model', () => {
    expect(
      resolveMemoryPaths(types, { notebookSlug: null, modelSlug: 'gpt-5-5' }).map((r) => r.path),
    ).toEqual(['AGENTS.md', 'MODELS/gpt-5-5.md']);
    expect(resolveMemoryPaths(types, { notebookSlug: 'grant', modelSlug: 'x' }).map((r) => r.path)).toContain(
      'PROJECTS/grant.md',
    );
  });

  it('caps the budget', () => {
    expect(memoryBudget(200_000, { share_of_context: 0.08, max_tokens: 4000 })).toBe(4000);
    expect(memoryBudget(8_000, { share_of_context: 0.08, max_tokens: 4000 })).toBe(640);
  });
});
