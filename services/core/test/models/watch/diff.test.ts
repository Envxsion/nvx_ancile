/**
 * What a check finds: new models, price, context, abilities, retirement,
 * and three misses in a row (MD5).
 */
import type { ModelConfig, WatchPrice } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { diffProvider, effectiveCaps } from '../../../src/models/watch/diff';
import type { Listed } from '../../../src/models/watch/listers';
import type { StoredModel } from '../../../src/models/watch/store';

const cat = (id: string, pm: string, over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: `anthropic/${id}`,
  provider: 'anthropic',
  provider_model: pm,
  display_name: id,
  via: 'direct',
  family: 'anthropic',
  context_window: 200_000,
  max_output: 64_000,
  capabilities: ['tools', 'vision', 'reasoning', 'json'],
  price: { input_per_mtok: 4, output_per_mtok: 20 },
  enabled: true,
  ...over,
});

const listed = (pm: string, over: Partial<Listed> = {}): Listed => ({
  provider_model: pm,
  display_name: pm,
  context_window: null,
  max_output: null,
  capabilities: [],
  capsKnown: false,
  capsDenied: [],
  other_abilities: [],
  price: null,
  lifecycle: 'active',
  retires_at: null,
  created_at: null,
  ...over,
});

let n = 0;
const run = (
  over: Partial<Parameters<typeof diffProvider>[0]> & Pick<Parameters<typeof diffProvider>[0], 'listed'>,
) =>
  diffProvider({
    provider: 'anthropic',
    vendor: 'anthropic',
    now: '2026-10-18T10:00:00.000Z',
    previous: [],
    catalogue: [cat('claude-opus-5-5', 'claude-opus-5-5')],
    prices: { mode: 'off' },
    newId: () => `c${++n}`,
    ...over,
  });

const prevRow = (r: Partial<StoredModel> & Pick<StoredModel, 'id'>): StoredModel => ({
  provider: 'anthropic',
  provider_model: r.id.split('/')[1] ?? r.id,
  display_name: r.id,
  line_id: null,
  version: null,
  preview: false,
  context_window: null,
  max_output: null,
  capabilities: [],
  other_abilities: [],
  price: null,
  price_source: null,
  price_checked_at: null,
  lifecycle: 'active',
  retires_at: null,
  first_seen: '2026-10-01T00:00:00.000Z',
  last_seen: '2026-10-17T00:00:00.000Z',
  in_catalogue: false,
  caps_known: false,
  created_at: null,
  missed: 0,
  line_name: null,
  line_tier: null,
  ...r,
});

describe('new models', () => {
  it('offers a model you do not have, once, with the contract shape', () => {
    const first = run({
      previous: [prevRow({ id: 'anthropic/claude-opus-5-5', in_catalogue: true })],
      listed: [listed('claude-opus-5-5'), listed('claude-opus-5-6')],
    });
    const news = first.changes.filter((c) => c.kind === 'new_model');
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      model_id: 'anthropic/claude-opus-5-6',
      line_id: 'anthropic/opus',
      before: null,
      after: null,
      seen: false,
    });
    // The row now exists, so the next check does not say it again.
    const again = run({
      previous: first.rows,
      listed: [listed('claude-opus-5-5'), listed('claude-opus-5-6')],
    });
    expect(again.changes.filter((c) => c.kind === 'new_model')).toEqual([]);
  });

  it('offers models with no line too (never followed)', () => {
    const r = run({
      previous: [prevRow({ id: 'anthropic/claude-opus-5-5', in_catalogue: true })],
      listed: [listed('claude-opus-5-5'), listed('claude-mystery-1')],
    });
    expect(r.changes.find((c) => c.kind === 'new_model')).toMatchObject({
      model_id: 'anthropic/claude-mystery-1',
      line_id: null,
    });
  });

  it('records the first check quietly, except the newest stable model of a line you use', () => {
    const r = run({
      listed: [
        listed('claude-opus-5-5'),
        listed('claude-opus-5-6'),
        listed('claude-opus-5-7-preview'),
        listed('claude-opus-4-1'),
        listed('claude-instant-1'),
      ],
    });
    expect(r.rows).toHaveLength(5);
    expect(r.changes.filter((c) => c.kind === 'new_model').map((c) => c.model_id)).toEqual([
      'anthropic/claude-opus-5-6',
    ]);
  });

  it('treats a dated snapshot and its undated id as one model, matching the catalogue', () => {
    const r = run({
      catalogue: [cat('claude-haiku-4-5', 'claude-haiku-4-5-20251001')],
      previous: [prevRow({ id: 'anthropic/other' })],
      listed: [listed('claude-haiku-4-5-20251001'), listed('claude-haiku-4-5')],
    });
    const row = r.rows.find((x) => x.id === 'anthropic/claude-haiku-4-5');
    expect(row).toMatchObject({ in_catalogue: true, provider_model: 'claude-haiku-4-5-20251001' });
    expect(r.rows.filter((x) => x.provider_model.startsWith('claude-haiku'))).toHaveLength(1);
    expect(r.changes.filter((c) => c.kind === 'new_model')).toEqual([]);
  });

  it('never offers new models from a provider that suppresses them (OpenRouter)', () => {
    const r = run({
      suppressNew: true,
      previous: [prevRow({ id: 'anthropic/x' })],
      listed: [listed('a/b')],
    });
    expect(r.changes).toEqual([]);
  });
});

describe('changes to a model you have', () => {
  const prev = [prevRow({ id: 'anthropic/claude-opus-5-5', in_catalogue: true })];

  it('says context and output when the live values differ, and nothing when they match', () => {
    const changed = run({
      previous: prev,
      listed: [listed('claude-opus-5-5', { context_window: 1_000_000, max_output: 64_000 })],
    });
    expect(changed.changes).toHaveLength(1);
    expect(changed.changes[0]).toMatchObject({
      kind: 'context',
      before: { context_window: 200_000, max_output: 64_000 },
      after: { context_window: 1_000_000, max_output: 64_000 },
    });
    expect(
      run({ previous: prev, listed: [listed('claude-opus-5-5', { context_window: 200_000 })] }).changes,
    ).toEqual([]);
  });

  it('says a known ability gained or lost, but not when the list says nothing about abilities', () => {
    const lost = run({
      previous: prev,
      listed: [
        listed('claude-opus-5-5', {
          capsKnown: true,
          capabilities: ['tools', 'vision', 'reasoning'],
          capsDenied: ['json'],
        }),
      ],
    });
    expect(lost.changes[0]).toMatchObject({
      kind: 'capability',
      before: ['tools', 'vision', 'reasoning', 'json'],
      after: ['tools', 'vision', 'reasoning'],
    });
    // Left out of the list is not the same as lost.
    expect(
      run({
        previous: prev,
        listed: [listed('claude-opus-5-5', { capsKnown: true, capabilities: ['tools', 'vision'] })],
      }).changes,
    ).toEqual([]);
    expect(run({ previous: prev, listed: [listed('claude-opus-5-5')] }).changes).toEqual([]);
  });

  it('says an ability NVX Ancile does not use yet, when it is new', () => {
    const before = [
      prevRow({ id: 'anthropic/claude-opus-5-5', in_catalogue: true, other_abilities: ['pdf_input'] }),
    ];
    const r = run({
      previous: before,
      listed: [listed('claude-opus-5-5', { other_abilities: ['pdf_input', 'video_input'] })],
    });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({
      kind: 'unsupported_capability',
      before: ['pdf_input'],
      after: ['pdf_input', 'video_input'],
    });
  });

  it('says a price that differs from the one in use, per million tokens, from OpenRouter', () => {
    const index = new Map<string, WatchPrice>([
      ['anthropic/claude-opus-5-5', { input_per_mtok: 3, output_per_mtok: 15 }],
    ]);
    const r = run({ previous: prev, prices: { mode: 'index', index }, listed: [listed('claude-opus-5-5')] });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({
      kind: 'price',
      before: { input_per_mtok: 4, output_per_mtok: 20 },
      after: { input_per_mtok: 3, output_per_mtok: 15 },
    });
    expect(r.rows[0]).toMatchObject({ price_source: 'openrouter', price_checked_at: '2026-10-18' });
    // Once the live price is in use there is nothing more to say.
    const settled = run({
      previous: r.rows,
      catalogue: [
        cat('claude-opus-5-5', 'claude-opus-5-5', { price: { input_per_mtok: 3, output_per_mtok: 15 } }),
      ],
      prices: { mode: 'index', index },
      listed: [listed('claude-opus-5-5')],
    });
    expect(settled.changes).toEqual([]);
  });

  it('keeps the last OpenRouter price when the public list could not be read, and drops it when the setting is off', () => {
    const withPrice = [
      prevRow({
        id: 'anthropic/claude-opus-5-5',
        in_catalogue: true,
        price: { input_per_mtok: 3, output_per_mtok: 15 },
        price_source: 'openrouter',
        price_checked_at: '2026-10-10',
      }),
    ];
    const kept = run({ previous: withPrice, prices: { mode: 'keep' }, listed: [listed('claude-opus-5-5')] });
    expect(kept.rows[0]?.price?.input_per_mtok).toBe(3);
    expect(kept.rows[0]?.price_checked_at).toBe('2026-10-10');
    const off = run({ previous: withPrice, prices: { mode: 'off' }, listed: [listed('claude-opus-5-5')] });
    expect(off.rows[0]?.price).toBeNull();
  });

  it('uses the provider list price as is (OpenRouter itself)', () => {
    const r = run({
      provider: 'anthropic',
      ownPrices: true,
      previous: prev,
      listed: [listed('claude-opus-5-5', { price: { input_per_mtok: 5, output_per_mtok: 25 } })],
    });
    expect(r.rows[0]).toMatchObject({ price_source: 'provider' });
    expect(r.changes[0]?.kind).toBe('price');
  });

  it('says retired or deprecated when the provider says so, once', () => {
    const r = run({
      previous: prev,
      listed: [listed('claude-opus-5-5', { lifecycle: 'deprecated', retires_at: '2026-12-01' })],
    });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: 'retired', before: null, after: null });
    expect(r.rows[0]).toMatchObject({ lifecycle: 'deprecated', retires_at: '2026-12-01' });
    expect(
      run({ previous: r.rows, listed: [listed('claude-opus-5-5', { lifecycle: 'deprecated' })] }).changes,
    ).toEqual([]);
  });
});

describe('gone from the list', () => {
  it('retires a model after three successful checks that did not list it, and keeps the row', () => {
    let rows = [prevRow({ id: 'anthropic/claude-opus-5-5', in_catalogue: true })];
    const other = listed('claude-sonnet-5-5');
    const results = [1, 2, 3].map(() => {
      const r = run({ previous: rows, listed: [other] });
      rows = r.rows;
      return r;
    });
    expect(results[0]?.changes.filter((c) => c.kind === 'retired')).toEqual([]);
    expect(results[1]?.changes.filter((c) => c.kind === 'retired')).toEqual([]);
    expect(results[2]?.changes.filter((c) => c.kind === 'retired')).toHaveLength(1);
    const kept = rows.find((r) => r.id === 'anthropic/claude-opus-5-5');
    expect(kept).toMatchObject({ lifecycle: 'retired', missed: 3 });
    // A fourth miss says nothing more.
    expect(run({ previous: rows, listed: [other] }).changes.filter((c) => c.kind === 'retired')).toEqual([]);
  });

  it('resets the count when the model is listed again', () => {
    const r = run({
      previous: [prevRow({ id: 'anthropic/claude-opus-5-5', in_catalogue: true, missed: 2 })],
      listed: [listed('claude-opus-5-5')],
    });
    expect(r.rows[0]?.missed).toBe(0);
  });
});

describe('effectiveCaps', () => {
  it('never takes an ability away because a list leaves it out', () => {
    expect(
      effectiveCaps({ capabilities: ['tools'], capsDenied: [] }, ['tools', 'json', 'vision']).sort(),
    ).toEqual(['json', 'tools', 'vision']);
  });
  it('adds what the list says yes to and drops only what it says no to', () => {
    expect(
      effectiveCaps({ capabilities: ['tools', 'reasoning'], capsDenied: ['vision'] }, [
        'tools',
        'vision',
      ]).sort(),
    ).toEqual(['reasoning', 'tools']);
  });
});
