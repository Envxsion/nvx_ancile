/**
 * ------------------------------------------------------------------
 *  Title    |  Work survives a change of model: summary sizes (HO1)
 *  Ref      |  ROADMAP.md HO1 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A summary made for a small window must not shrink what
 *           |  a large one reads. A cut is kept at three sizes, each
 *           |  model reads the finest its window holds, and going
 *           |  back to a bigger window reads the full turns again.
 *           |  The budget counts the system text, the tools block and
 *           |  the memory pack, and says before a switch whether the
 *           |  thread would fit the model.
 * ------------------------------------------------------------------
 */

import type { ModelConfig, PathBudget } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryBranchStore, type SummaryRecord } from '../../src/threads/branches';
import {
  chooseCompaction,
  compactPath,
  DEFAULT_WATCH,
  LEVEL_TOKENS,
  pathBudget,
  roomFor,
  SUMMARY_HEADER,
  shrinkSummary,
  substitute,
  windowClass,
} from '../../src/threads/compact';
import { asTree, type MessageRecord } from '../../src/threads/repo';

const msg = (id: string, parent: string | null, role: 'user' | 'assistant', text: string): MessageRecord => ({
  id,
  thread_id: 't',
  parent_id: parent,
  role,
  parts: [{ type: 'text', text }],
  model_id: null,
  requested_model_id: null,
  status: 'complete',
  edit_of_id: null,
  provenance: {},
  usage: null,
  run_id: null,
  trace_id: 'x',
  created_at: '2026-10-07T00:00:00Z',
});

/** u1 a1 … u10 a10 u11: eleven questions of about 500 tokens each way, so a path is about 10k tokens. */
const chain: MessageRecord[] = [];
for (let i = 1; i <= 21; i++) {
  const role = i % 2 ? 'user' : 'assistant';
  chain.push(msg(`m${i}`, i === 1 ? null : `m${i - 1}`, role, `${role} line ${i}. `.repeat(180)));
}
const path = asTree(chain);

const page = [
  '## Goal',
  'The user is sizing a pump for a 40 litre tank. They want metric units throughout.',
  'They stated the supply is 230 V and must stay under 5 A.',
  '## Decisions',
  'The assistant proposed the 9 l/min pump. The user accepted it.',
  'A gasket in nitrile was chosen over silicone because of the oil.',
  'The valve is a 15 mm brass ball valve, part number BV-15.',
  '## Open',
  'The mounting bracket is still to be drawn.',
  'The user wants a parts list at the end.',
  ...Array.from({ length: 60 }, (_, i) => `- detail ${i} about the pump curve at ${i} metres of head.`),
].join('\n');

const row = (level: 'page' | 'paragraph' | 'line', upto: string, forWindow: number): SummaryRecord => {
  const content = level === 'page' ? page : shrinkSummary(page, LEVEL_TOKENS[level]);
  return {
    id: `sum_${level}_${upto}`,
    thread_id: 't',
    upto_message_id: upto,
    kind: 'compaction',
    content,
    tokens: Math.ceil(content.length / 4),
    model_id: 'x',
    level,
    for_window: forWindow,
    created_at: '2026-10-07T00:00:00Z',
  };
};

const model = (window: number, extra: Partial<ModelConfig> = {}): ModelConfig =>
  ({
    id: `m/${window}`,
    provider: 'fake',
    provider_model: 'x',
    display_name: `M${window}`,
    via: 'direct',
    family: 'fake',
    context_window: window,
    max_output: 1_000,
    capabilities: ['tools'],
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    enabled: true,
    ...extra,
  }) as ModelConfig;

describe('window classes', () => {
  it('measure a window by the largest class it reaches', () => {
    expect(windowClass(131_072)).toBe(128_000);
    expect(windowClass(128_000)).toBe(128_000);
    expect(windowClass(1_048_576)).toBe(1_000_000);
    expect(windowClass(200_000)).toBe(200_000);
    expect(windowClass(1_400)).toBe(1_400);
    expect(windowClass(0)).toBe(0);
  });
});

describe('the sizes of a summary', () => {
  it('are cut from the page by a fixed rule, section by section', () => {
    const para = shrinkSummary(page, LEVEL_TOKENS.paragraph);
    const line = shrinkSummary(page, LEVEL_TOKENS.line);
    expect(Math.ceil(para.length / 4)).toBeLessThanOrEqual(LEVEL_TOKENS.paragraph);
    expect(Math.ceil(line.length / 4)).toBeLessThanOrEqual(LEVEL_TOKENS.line);
    expect(line.length).toBeLessThan(para.length);
    expect(para.length).toBeLessThan(page.length);
    // The first line of every section survives in the paragraph.
    expect(para).toContain('## Goal');
    expect(para).toContain('## Decisions');
    expect(para).toContain('## Open');
    // Same text in, same text out: the request stays the same from turn to turn.
    expect(shrinkSummary(page, LEVEL_TOKENS.paragraph)).toBe(para);
    expect(shrinkSummary('short', 80)).toBe('short');
  });

  it('are all saved for one cut, tagged with the window class, finest first', async () => {
    const branches = new MemoryBranchStore();
    const res = await compactPath(
      {
        branches,
        gateway: undefined as never,
        registry: { chain: () => [] } as never,
        promptsDir: '/none',
      },
      { threadId: 't', messages: chain, headId: 'm21', window: 131_072 },
    );
    expect(res.levels).toEqual(['page', 'paragraph', 'line']);
    const rows = await branches.summaries('t', 'compaction');
    expect(rows.map((r) => r.level)).toEqual(['page', 'paragraph', 'line']);
    expect(new Set(rows.map((r) => r.for_window))).toEqual(new Set([128_000]));
    expect(new Set(rows.map((r) => r.upto_message_id)).size).toBe(1);
    // Asked again, the same cut is reused and nothing new is written.
    const again = await compactPath(
      { branches, gateway: undefined as never, registry: { chain: () => [] } as never, promptsDir: '/none' },
      { threadId: 't', messages: chain, headId: 'm21', window: 32_000 },
    );
    expect(again.reused).toBe(true);
    expect((await branches.summaries('t', 'compaction')).length).toBe(3);
  });

  it('are added to a summary made before sizes existed', async () => {
    const branches = new MemoryBranchStore();
    await branches.addSummary({
      id: 'sum_old',
      thread_id: 't',
      upto_message_id: 'm16',
      kind: 'compaction',
      content: page,
      tokens: Math.ceil(page.length / 4),
      model_id: 'x',
    });
    const res = await compactPath(
      { branches, gateway: undefined as never, registry: { chain: () => [] } as never, promptsDir: '/none' },
      { threadId: 't', messages: chain, headId: 'm21' },
    );
    expect(res.reused).toBe(true);
    expect((await branches.summaries('t', 'compaction')).map((s) => s.level)).toEqual([
      'page',
      'paragraph',
      'line',
    ]);
  });
});

describe('the size a window reads', () => {
  const cut = 'm16'; // an assistant reply: m17 onwards stays verbatim (5 messages)
  const sums = [row('page', cut, 32_000), row('paragraph', cut, 32_000), row('line', cut, 32_000)];
  const fixed = { system: 500, tools: 800, memory: 300 };
  const read = (m: ModelConfig) => {
    const room = roomFor(m, DEFAULT_WATCH, fixed);
    return chooseCompaction(path, sums, room);
  };

  it('is every turn for a window that holds them, even when a smaller model summarised', () => {
    const big = read(model(1_000_000));
    expect(big.level).toBe('full');
    expect(big.summary).toBeNull();
    expect(big.replaced).toBe(0);
    expect(big.messages).toHaveLength(path.length);
  });

  it('is the finest summary the window holds, and a coarser one when less room is left', () => {
    // How much room the verbatim tail, the summary of each size and the header take, measured.
    const header = Math.ceil(SUMMARY_HEADER.length / 4);
    const tail =
      chooseCompaction(path, [sums[0] as SummaryRecord], null).tokens -
      (sums[0] as SummaryRecord).tokens -
      header;
    const w = 8_000;
    const reserve = 1_000; // the room kept for the answer
    // The fixed part that leaves just enough room, under the compaction line, for this size and no finer.
    const fixedFor = (level: 'page' | 'paragraph' | 'line') => {
      const size = (sums.find((x) => x.level === level) as SummaryRecord).tokens;
      return Math.floor(w * DEFAULT_WATCH.compactAt) - reserve - (tail + size + header) - 10;
    };
    const at = (level: 'page' | 'paragraph' | 'line') =>
      chooseCompaction(path, sums, roomFor(model(w), DEFAULT_WATCH, { system: fixedFor(level) }));
    expect(at('page').level).toBe('page');
    expect(at('paragraph').level).toBe('paragraph');
    expect(at('line').level).toBe('line');
    expect(at('paragraph').tokens).toBeLessThan(at('page').tokens);
    expect(at('line').tokens).toBeLessThan(at('paragraph').tokens);
    // Nothing fits at all: the smallest there is, so the request is as small as it can be.
    const none = chooseCompaction(
      path,
      sums,
      roomFor(model(w), DEFAULT_WATCH, { system: fixedFor('line') + 5_000 }),
    );
    expect(none.level).toBe('line');
  });

  it('is the same for two models of one class, so the request does not change between them', () => {
    expect(read(model(131_072)).level).toBe(read(model(128_000)).level);
    expect(read(model(131_072)).summary?.id).toBe(read(model(128_000)).summary?.id);
  });

  it('is what the turn substitutes, and going back to a big window reads every turn again', () => {
    const small = substitute(path, sums, roomFor(model(16_000), DEFAULT_WATCH, fixed));
    expect(small.skipThrough).toBe(cut);
    expect(small.note).toContain('Summary of the earlier part');
    const bigger = substitute(path, sums, roomFor(model(1_000_000), DEFAULT_WATCH, fixed));
    expect(bigger.skipThrough).toBeNull();
    expect(bigger.note).toBe('');
    // And a model whose window is as small as the one it was made for reads it again.
    const back = substitute(path, sums, roomFor(model(32_000), DEFAULT_WATCH, fixed));
    expect(back.skipThrough).toBe(cut);
  });

  it('keeps the newest summary when the watch is off (nothing is chosen for you)', () => {
    const off = chooseCompaction(
      path,
      sums,
      roomFor(model(1_000_000), { ...DEFAULT_WATCH, on: false }, fixed),
    );
    expect(off.level).toBe('page');
    expect(off.summary?.upto_message_id).toBe(cut);
  });
});

describe('the budget counts what the request carries', () => {
  const small = model(16_000);
  const base = { headId: 'm21', path, summaries: [] as SummaryRecord[], model: small };

  it('counts the tools block and the memory pack, not a flat 600', () => {
    const plain = pathBudget({ ...base, system: 500 });
    const full = pathBudget({ ...base, system: 500, tools: 4_000, memory: 1_200 });
    expect(full.used.tools).toBe(4_000);
    expect(full.used.memory).toBe(1_200);
    expect(full.total - plain.total).toBe(5_200);
  });

  it('says nothing is needed when the thread fits', () => {
    const b = pathBudget({ ...base, model: model(1_000_000), system: 500, tools: 4_000 });
    expect(b.fit).toMatchObject({ needs_summary: false, level: 'full' });
  });

  it('says it needs summarising, from how much to how much, before a switch', () => {
    const b = pathBudget({ ...base, model: model(12_000), system: 500, tools: 800 });
    expect(b.fit?.needs_summary).toBe(true);
    expect(b.fit?.summary_ready).toBe(false);
    expect(b.fit?.tokens_after).not.toBeNull();
    expect((b.fit?.tokens_after ?? 0) < (b.fit?.tokens_now ?? 0)).toBe(true);
    expect((b.fit?.tokens_after ?? 0) <= 12_000 * 0.95).toBe(true);
  });

  it('knows when a summary that makes it fit already exists', () => {
    const sums = [row('page', 'm16', 12_000), row('paragraph', 'm16', 12_000), row('line', 'm16', 12_000)];
    const b = pathBudget({ ...base, model: model(12_000), system: 500, tools: 800, summaries: sums });
    expect(b.fit).toMatchObject({ needs_summary: true, summary_ready: true });
    expect(b.compaction?.level).toBeDefined();
  });

  it('says no summary can make it fit when the fixed part alone fills the window', () => {
    const b = pathBudget({ ...base, model: model(6_000), system: 3_000, tools: 3_000 });
    expect(b.fit).toMatchObject({ needs_summary: true, tokens_after: null });
  });

  it('gives no fit for a model without a window', () => {
    const b: PathBudget = pathBudget({ ...asTreeBase(), model: undefined });
    expect(b.fit).toBeUndefined();
  });
});

function asTreeBase() {
  return { headId: 'm21', path, summaries: [] as SummaryRecord[] };
}
