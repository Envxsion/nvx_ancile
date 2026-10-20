/**
 * `<provider>/<line>:latest` ids resolve offline from the catalogue; a
 * retired model's id answers with its line's current model; answers record
 * the concrete model (MD4).
 */
import { describe, expect, it } from 'vitest';
import type { StoredModel } from '../../../src/models/watch/store';
import { CATALOGUE, claude, world } from './world';

const row = (id: string, over: Partial<StoredModel> = {}): StoredModel => ({
  id,
  provider: 'anthropic',
  provider_model: id.split('/')[1] as string,
  display_name: id,
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
  last_seen: '2026-10-18T00:00:00.000Z',
  in_catalogue: true,
  caps_known: false,
  created_at: null,
  missed: 0,
  line_name: null,
  line_tier: null,
  ...over,
});

describe('aliases before any check', () => {
  it('resolve offline to the newest stable catalogue model of the line', async () => {
    const w = await world();
    const r = w.registry;
    expect(r.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-5');
    expect(r.get('anthropic/sonnet:latest')?.id).toBe('anthropic/claude-sonnet-5-5');
    expect(r.get('anthropic/haiku:latest')?.id).toBe('anthropic/claude-haiku-4-5');
    expect(r.resolve('anthropic/opus:latest')).toMatchObject({
      via: 'alias',
      requested: 'anthropic/opus:latest',
    });
    expect(r.get('anthropic/fable:latest')).toBeUndefined();
    expect(r.get('openai/gpt:latest')).toBeUndefined();
    // A literal id is itself, and getExact never follows an alias.
    expect(r.get('anthropic/claude-opus-5-5')?.id).toBe('anthropic/claude-opus-5-5');
    expect(r.getExact('anthropic/opus:latest')).toBeUndefined();
  });

  it('picks the newest stable model, not a preview and not an older snapshot', async () => {
    const w = await world({
      models: [
        ...CATALOGUE,
        claude('claude-opus-5-6-preview', 'claude-opus-5-6-preview'),
        claude('claude-opus-5-6', 'claude-opus-5-6'),
        claude('claude-opus-5-6-dated', 'claude-opus-5-6-20260901'),
        claude('claude-opus-4-1', 'claude-opus-4-1'),
      ],
    });
    expect(w.registry.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-6');
  });

  it('makes chain() use concrete models, for aliases in a class and as the explicit choice', async () => {
    const w = await world({
      taskClasses: {
        'chat.default': ['anthropic/sonnet:latest', 'anthropic/opus:latest'],
        utility: ['anthropic/haiku:latest'],
      },
    });
    expect(w.registry.chain('chat.default').map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-opus-5-5',
    ]);
    // The pin goes first; utility also wants a small model, so the other ready ones follow by closeness to it.
    expect(w.registry.chain('utility').map((m) => m.id)[0]).toBe('anthropic/claude-haiku-4-5');
    // An explicit alias goes first and is recorded as the concrete model.
    expect(w.registry.chain('chat.default', 'anthropic/opus:latest').map((m) => m.id)).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
    ]);
  });

  it("lists one alias entry per line in info(), with the current model's status and price", async () => {
    const w = await world();
    const info = w.registry.info();
    const alias = info.find((m) => m.id === 'anthropic/opus:latest');
    expect(alias).toMatchObject({
      display_name: 'Claude Opus',
      alias_of: 'anthropic/claude-opus-5-5',
      line_id: 'anthropic/opus',
      status: 'ready',
      provider: 'anthropic',
      context_window: 200_000,
      price: { input_per_mtok: 2, output_per_mtok: 10 },
    });
    expect(alias?.custom).toBeUndefined();
    const concrete = info.find((m) => m.id === 'anthropic/claude-opus-5-5');
    expect(concrete).toMatchObject({ line_id: 'anthropic/opus', lifecycle: 'active' });
    expect(concrete?.alias_of).toBeUndefined();
    expect(
      info
        .filter((m) => m.alias_of)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['anthropic/haiku:latest', 'anthropic/opus:latest', 'anthropic/sonnet:latest']);
  });
});

describe('retired models', () => {
  it("answer with the line's current model, with a note, and are never deleted", async () => {
    const w = await world({ models: [...CATALOGUE, claude('claude-opus-5-6', 'claude-opus-5-6')] });
    expect(w.registry.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-6');
    w.registry.setWatch([row('anthropic/claude-opus-5-5', { lifecycle: 'retired' })]);
    const r = w.registry.resolve('anthropic/claude-opus-5-5');
    expect(r?.via).toBe('retired');
    expect(r?.model.id).toBe('anthropic/claude-opus-5-6');
    expect(r?.note).toMatch(/retired/);
    expect(w.registry.getExact('anthropic/claude-opus-5-5')).toBeDefined();
    expect(w.registry.info().find((m) => m.id === 'anthropic/claude-opus-5-5')?.lifecycle).toBe('retired');
    // chain() follows it too.
    expect(w.registry.chain('chat.default', 'anthropic/claude-opus-5-5')[0]?.id).toBe(
      'anthropic/claude-opus-5-6',
    );
  });

  it("a retired model that is its line's current one hands over to the newest stable other", async () => {
    const w = await world({ models: [...CATALOGUE, claude('claude-opus-5-4', 'claude-opus-5-4')] });
    w.registry.setWatch([row('anthropic/claude-opus-5-5', { lifecycle: 'retired' })]);
    expect(w.registry.get('anthropic/claude-opus-5-5')?.id).toBe('anthropic/claude-opus-5-4');
    // With nothing else in the line it stays itself.
    const solo = await world();
    solo.registry.setWatch([row('anthropic/claude-opus-5-5', { lifecycle: 'retired' })]);
    expect(solo.registry.get('anthropic/claude-opus-5-5')?.id).toBe('anthropic/claude-opus-5-5');
  });
});

describe('live values over the bundled ones', () => {
  it('lays price, window and abilities over a catalogue model without changing the catalogue', async () => {
    const w = await world();
    w.registry.setWatch([
      row('anthropic/claude-opus-5-5', {
        price: { input_per_mtok: 3, output_per_mtok: 15 },
        price_source: 'openrouter',
        context_window: 1_000_000,
        capabilities: ['tools', 'vision'],
        caps_known: true,
      }),
    ]);
    const m = w.registry.get('anthropic/claude-opus-5-5');
    expect(m?.price).toEqual({ input_per_mtok: 3, output_per_mtok: 15 });
    expect(m?.context_window).toBe(1_000_000);
    expect(m?.max_output).toBe(64_000);
    expect(m?.capabilities).toEqual(['tools', 'vision']);
    // Taking the watch away puts the bundled values back.
    w.registry.setWatch([]);
    expect(w.registry.get('anthropic/claude-opus-5-5')?.price).toEqual({
      input_per_mtok: 2,
      output_per_mtok: 10,
    });
    expect(w.registry.get('anthropic/claude-opus-5-5')?.context_window).toBe(200_000);
  });
});
