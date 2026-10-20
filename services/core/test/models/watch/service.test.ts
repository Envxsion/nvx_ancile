/**
 * The model watch: checks, follow latest with a test call, use, go back,
 * retirement, prices, and the schedule (MD4, MD5).
 */
import { ModelWatchReport } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  CHECK_EVERY_MS,
  FIRST_RUN_DELAY_MS,
  MANUAL_MIN_GAP_MS,
  UPGRADE_DELAY_MS,
} from '../../../src/models/watch/service';
import { entry, world } from './world';

const HOUR = 3_600_000;
const OPUS = 'anthropic/opus';
const base = () => [entry('claude-opus-5-5'), entry('claude-sonnet-5-5'), entry('claude-haiku-4-5-20251001')];

describe('a check', () => {
  it('reads the list, offers a new model, and the report matches the contract', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-6')];
    const report = await w.watch.check('anthropic');
    ModelWatchReport.parse(report);
    expect(report.providers).toEqual([
      expect.objectContaining({ provider: 'anthropic', ok: true, models: 4, unsupported: false }),
    ]);
    expect(report.changes.map((c) => [c.kind, c.model_id])).toEqual([
      ['new_model', 'anthropic/claude-opus-5-6'],
    ]);
    const line = report.lines.find((l) => l.id === OPUS);
    expect(line).toMatchObject({
      current_id: 'anthropic/claude-opus-5-5',
      latest_id: 'anthropic/claude-opus-5-6',
      follow: false,
      previous_id: null,
      pending: { model_id: 'anthropic/claude-opus-5-6', state: 'offered' },
    });
    expect(report.bundled_prices_date).toBe('2026-10-16');
    expect(report.openrouter_prices).toBe(true);
    expect(w.events).toEqual([{ type: 'models.changed', what: 'watch', unseen: 1 }]);
    // Bundled prices are shown as such for a model with no live price.
    const m = report.models.find((x) => x.id === 'anthropic/claude-opus-5-5');
    expect(m).toMatchObject({ price_source: 'bundled', price_checked_at: '2026-10-16', in_catalogue: true });
    expect(w.tested).toEqual([]);
  });

  it('sends the key only to the provider, with the workspace header for a personal key', async () => {
    const w = await world({ keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID'] });
    w.anthropic.data = base();
    await w.watch.check();
    const call = w.calls.find((c) => c.url.includes('anthropic.com'));
    expect(call?.headers['x-api-key']).toBe('sk-test-secret');
    expect(call?.headers['anthropic-workspace-id']).toBe('sk-test-secret');
    expect(
      w.calls
        .filter((c) => c.url.includes('openrouter.ai'))
        .every((c) => Object.keys(c.headers).length === 0),
    ).toBe(true);
  });

  it('makes no call for a provider without a key', async () => {
    const w = await world({ keys: [] });
    const report = await w.watch.report();
    expect(report.providers).toEqual([]);
    await expect(w.watch.check()).resolves.toMatchObject({ providers: [] });
    expect(w.calls).toEqual([]);
  });

  it('keeps a key that may not list models as working: a documented code, not "rejected"', async () => {
    const w = await world();
    w.anthropic.fail = 403;
    const report = await w.watch.check('anthropic');
    expect(report.providers[0]).toMatchObject({ ok: false, error_code: 'models.list_forbidden' });
    expect(report.providers[0]?.error_title).not.toMatch(/reject/i);
    expect(report.providers[0]?.next_at).toBeTruthy();
  });

  it('refuses a manual check of the same provider within a minute', async () => {
    const w = await world();
    w.anthropic.data = base();
    await w.watch.check('anthropic');
    await expect(w.watch.check('anthropic')).rejects.toMatchObject({
      code: 'models.check_too_soon',
      status: 429,
    });
    w.clock.advance(MANUAL_MIN_GAP_MS);
    await expect(w.watch.check('anthropic')).resolves.toBeDefined();
    await expect(w.watch.check('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('retires a catalogue model missing from three successful checks, keeps its row, and resolves it', async () => {
    const w = await world();
    w.anthropic.data = base();
    await w.watch.check('anthropic');
    w.anthropic.data = base().filter((e) => e.id !== 'claude-opus-5-5');
    for (let i = 0; i < 3; i++) {
      w.clock.advance(MANUAL_MIN_GAP_MS);
      await w.watch.check('anthropic');
    }
    const report = await w.watch.report();
    const retired = report.changes.find((c) => c.kind === 'retired');
    expect(retired).toMatchObject({ model_id: 'anthropic/claude-opus-5-5', before: null, after: null });
    expect(report.models.find((m) => m.id === 'anthropic/claude-opus-5-5')?.lifecycle).toBe('retired');
    expect(w.registry.getExact('anthropic/claude-opus-5-5')).toBeDefined();
  });
});

describe('prices from OpenRouter', () => {
  const orOpus = {
    id: 'anthropic/claude-opus-5.5',
    pricing: { prompt: '0.000003', completion: '0.000015' },
  };

  it('overlays a matched price once per run, without a key, and costs follow', async () => {
    const w = await world();
    w.anthropic.data = base();
    w.openrouter.data = [orOpus];
    const report = await w.watch.check();
    const or = w.calls.filter((c) => c.url.startsWith('https://openrouter.ai/'));
    expect(or).toHaveLength(1);
    expect(or[0]?.headers).toEqual({});
    expect(report.changes.find((c) => c.kind === 'price')).toMatchObject({
      model_id: 'anthropic/claude-opus-5-5',
      before: { input_per_mtok: 2, output_per_mtok: 10 },
      after: { input_per_mtok: 3, output_per_mtok: 15 },
    });
    expect(report.models.find((m) => m.id === 'anthropic/claude-opus-5-5')).toMatchObject({
      price_source: 'openrouter',
      price_checked_at: '2026-10-18',
    });
    expect(w.registry.get('anthropic/claude-opus-5-5')?.price.input_per_mtok).toBe(3);
  });

  it('never calls OpenRouter when the setting is off, and the bundled price comes back', async () => {
    const w = await world();
    w.anthropic.data = base();
    w.openrouter.data = [orOpus];
    await w.watch.check();
    const off = await w.watch.setOpenrouterPrices(false);
    expect(off.openrouter_prices).toBe(false);
    expect(w.registry.get('anthropic/claude-opus-5-5')?.price.input_per_mtok).toBe(2);
    w.calls.length = 0;
    w.clock.advance(MANUAL_MIN_GAP_MS);
    await w.watch.check();
    expect(w.calls.some((c) => c.url.startsWith('https://openrouter.ai/'))).toBe(false);
  });

  it('keeps the last prices when OpenRouter is down', async () => {
    const w = await world();
    w.anthropic.data = base();
    w.openrouter.data = [orOpus];
    await w.watch.check();
    w.openrouter.fail = true;
    w.clock.advance(MANUAL_MIN_GAP_MS);
    const report = await w.watch.check();
    expect(report.providers[0]?.ok).toBe(true);
    expect(w.registry.get('anthropic/claude-opus-5-5')?.price.input_per_mtok).toBe(3);
  });
});

describe('follow latest (GR16)', () => {
  const newer = () => [...base(), entry('claude-opus-5-6', { display_name: 'Claude Opus 5.6' })];

  it('moves only after a passing test call, adds the model, and keeps a way back', async () => {
    const w = await world();
    w.anthropic.data = base();
    await w.watch.check('anthropic');
    await w.watch.updateLine(OPUS, { follow: true });
    await w.watch.idle();
    expect(w.tested).toEqual([]);
    w.anthropic.data = newer();
    w.clock.advance(CHECK_EVERY_MS);
    const report = await w.watch.check('anthropic');
    expect(w.tested.map((m) => m.id)).toEqual(['anthropic/claude-opus-5-6']);
    // The test used a model that was not in the registry yet; it is now.
    expect(w.registry.getExact('anthropic/claude-opus-5-6')).toBeDefined();
    expect(w.registry.isFromWatch('anthropic/claude-opus-5-6')).toBe(true);
    const line = report.lines.find((l) => l.id === OPUS);
    expect(line).toMatchObject({
      current_id: 'anthropic/claude-opus-5-6',
      previous_id: 'anthropic/claude-opus-5-5',
      pending: null,
      follow: true,
    });
    expect(w.registry.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-6');
    const moved = report.changes.find((c) => c.kind === 'line_moved');
    expect(moved).toMatchObject({
      line_id: OPUS,
      reason: 'followed',
      before: 'anthropic/claude-opus-5-5',
      after: 'anthropic/claude-opus-5-6',
    });
    expect(w.events.some((e) => e.what === 'line')).toBe(true);
    // Persisted: a new registry over the same settings still resolves the same way.
    await w.registry.refresh();
    expect(w.registry.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-6');
  });

  it('stays put and says why when the test call fails, then tries again at the next run', async () => {
    const w = await world();
    w.anthropic.data = base();
    await w.watch.check('anthropic');
    await w.watch.updateLine(OPUS, { follow: true });
    w.anthropic.data = newer();
    w.testResult = { ok: false, detail: 'Claude Opus 5.6 did not answer the test call (permanent).' };
    w.clock.advance(CHECK_EVERY_MS);
    const failed = await w.watch.check('anthropic');
    expect(failed.lines.find((l) => l.id === OPUS)).toMatchObject({
      current_id: 'anthropic/claude-opus-5-5',
      pending: {
        model_id: 'anthropic/claude-opus-5-6',
        state: 'failed',
        detail: 'Claude Opus 5.6 did not answer the test call (permanent).',
      },
    });
    expect(failed.changes.some((c) => c.kind === 'line_moved')).toBe(false);
    // The model was only tried, not added.
    expect(w.registry.getExact('anthropic/claude-opus-5-6')).toBeUndefined();
    w.testResult = { ok: true, detail: null };
    w.clock.advance(CHECK_EVERY_MS);
    const passed = await w.watch.check('anthropic');
    expect(w.tested).toHaveLength(2);
    expect(passed.lines.find((l) => l.id === OPUS)?.current_id).toBe('anthropic/claude-opus-5-6');
  });

  it('turns a thrown test call into a failure', async () => {
    const w = await world();
    w.anthropic.data = base();
    await w.watch.check('anthropic');
    await w.watch.updateLine(OPUS, { follow: true });
    w.anthropic.data = newer();
    (w.watch as unknown as { deps: { testCall: unknown } }).deps.testCall = async () => {
      throw new Error('boom');
    };
    w.clock.advance(CHECK_EVERY_MS);
    const r = await w.watch.check('anthropic');
    expect(r.lines.find((l) => l.id === OPUS)?.pending?.state).toBe('failed');
  });

  it('only offers when follow is off, and makes no test call', async () => {
    const w = await world();
    w.anthropic.data = newer();
    await w.watch.check('anthropic');
    expect(w.tested).toEqual([]);
    expect(w.registry.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-5');
  });

  it('never follows a preview', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-7-preview')];
    await w.watch.check('anthropic');
    await w.watch.updateLine(OPUS, { follow: true });
    await w.watch.idle();
    w.clock.advance(CHECK_EVERY_MS);
    const r = await w.watch.check('anthropic');
    expect(w.tested).toEqual([]);
    expect(r.lines.find((l) => l.id === OPUS)).toMatchObject({
      current_id: 'anthropic/claude-opus-5-5',
      latest_id: 'anthropic/claude-opus-5-5',
      pending: null,
    });
  });

  it('turning follow on tries a waiting newer model at once, in the background', async () => {
    const w = await world();
    w.anthropic.data = newer();
    await w.watch.check('anthropic');
    const line = await w.watch.updateLine(OPUS, { follow: true });
    expect(line.follow).toBe(true);
    await w.watch.idle();
    expect(w.registry.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-6');
  });

  it('moves a retired current model to the newest stable, with reason retired', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-4')];
    await w.watch.check('anthropic');
    w.anthropic.data = [
      ...base().filter((e) => e.id !== 'claude-opus-5-5'),
      entry('claude-opus-5-5', { lifecycle: 'retired' }),
      entry('claude-opus-5-4'),
    ];
    w.clock.advance(CHECK_EVERY_MS);
    const r = await w.watch.check('anthropic');
    expect(r.lines.find((l) => l.id === OPUS)).toMatchObject({
      current_id: 'anthropic/claude-opus-5-4',
      previous_id: 'anthropic/claude-opus-5-5',
    });
    const moved = r.changes.find((c) => c.kind === 'line_moved');
    expect(moved?.reason).toBe('retired');
    const retired = r.changes.find((c) => c.kind === 'retired');
    expect(retired).toMatchObject({ before: null, after: 'anthropic/claude-opus-5-4' });
    // Not following: no test call needed.
    expect(w.tested).toEqual([]);
  });

  it('keeps a retired current model when following and no replacement passes', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-4')];
    await w.watch.check('anthropic');
    await w.watch.updateLine(OPUS, { follow: true });
    await w.watch.idle();
    w.testResult = { ok: false, detail: 'no' };
    w.anthropic.data = [
      ...base().filter((e) => e.id !== 'claude-opus-5-5'),
      entry('claude-opus-5-5', { lifecycle: 'retired' }),
      entry('claude-opus-5-4'),
    ];
    w.clock.advance(CHECK_EVERY_MS);
    const r = await w.watch.check('anthropic');
    expect(r.lines.find((l) => l.id === OPUS)).toMatchObject({
      current_id: 'anthropic/claude-opus-5-5',
      pending: { state: 'failed' },
    });
  });
});

describe('use and go back', () => {
  it('use moves at once with no test call, previews allowed, reason chosen', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-7-preview')];
    await w.watch.check('anthropic');
    const line = await w.watch.updateLine(OPUS, { use: 'anthropic/claude-opus-5-7-preview' });
    expect(line).toMatchObject({
      current_id: 'anthropic/claude-opus-5-7-preview',
      previous_id: 'anthropic/claude-opus-5-5',
    });
    expect(w.tested).toEqual([]);
    expect(w.registry.get('anthropic/opus:latest')?.id).toBe('anthropic/claude-opus-5-7-preview');
    const moved = (await w.watch.report()).changes.find((c) => c.kind === 'line_moved');
    expect(moved?.reason).toBe('chosen');
  });

  it('refuses a model that is not in the line, with a 400', async () => {
    const w = await world();
    await expect(w.watch.updateLine(OPUS, { use: 'anthropic/claude-sonnet-5-5' })).rejects.toMatchObject({
      code: 'models.line_model_not_in_line',
      status: 400,
    });
    await expect(w.watch.updateLine('anthropic/nothing', { follow: true })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('go back swaps current and previous, and answers 409 when there is no previous', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-6')];
    await w.watch.check('anthropic');
    await expect(w.watch.back(OPUS)).rejects.toMatchObject({ code: 'models.line_no_previous', status: 409 });
    await w.watch.updateLine(OPUS, { use: 'anthropic/claude-opus-5-6' });
    const back = await w.watch.back(OPUS);
    expect(back).toMatchObject({
      current_id: 'anthropic/claude-opus-5-5',
      previous_id: 'anthropic/claude-opus-5-6',
    });
    const again = await w.watch.back(OPUS);
    expect(again.current_id).toBe('anthropic/claude-opus-5-6');
    const reasons = (await w.watch.report()).changes
      .filter((c) => c.kind === 'line_moved')
      .map((c) => c.reason);
    expect(reasons.sort()).toEqual(['back', 'back', 'chosen']);
  });
});

describe('add', () => {
  it('adds an offered model to the registry; unknown ids are 404', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-6', { display_name: 'Claude Opus 5.6' })];
    await w.watch.check('anthropic');
    const info = await w.watch.add('anthropic/claude-opus-5-6');
    expect(info).toMatchObject({ id: 'anthropic/claude-opus-5-6', provider: 'anthropic', status: 'ready' });
    expect(w.registry.isCustom('anthropic/claude-opus-5-6')).toBe(true);
    expect(w.registry.isFromWatch('anthropic/claude-opus-5-6')).toBe(true);
    await expect(w.watch.add('anthropic/not-a-thing')).rejects.toMatchObject({ status: 404 });
  });

  it('marks changes seen', async () => {
    const w = await world();
    w.anthropic.data = [...base(), entry('claude-opus-5-6')];
    const r = await w.watch.check('anthropic');
    await w.watch.markSeen(r.changes.map((c) => c.id));
    expect((await w.watch.report()).changes.every((c) => c.seen)).toBe(true);
  });
});

describe('schedule', () => {
  it('first run 60 s after start, then only providers due: 24 h when good, 1 h doubling when failing', async () => {
    const w = await world();
    w.anthropic.data = base();
    w.watch.start();
    expect(w.timers.timeouts.map((t) => t.ms)).toEqual([FIRST_RUN_DELAY_MS, UPGRADE_DELAY_MS]);
    expect(w.timers.intervals.map((t) => t.ms)).toEqual([HOUR]);
    const anthropicCalls = () => w.calls.filter((c) => c.url.includes('anthropic.com')).length;

    await w.watch.tick();
    expect(anthropicCalls()).toBe(1);
    // An hour later nothing is due.
    w.clock.advance(HOUR);
    await w.watch.tick();
    expect(anthropicCalls()).toBe(1);
    w.clock.advance(23 * HOUR);
    await w.watch.tick();
    expect(anthropicCalls()).toBe(2);

    // Now it fails: retried after 1 h, then 2 h, then 4 h.
    w.anthropic.fail = 503;
    w.clock.advance(CHECK_EVERY_MS);
    await w.watch.tick();
    expect(anthropicCalls()).toBe(3);
    w.clock.advance(HOUR - 1);
    await w.watch.tick();
    expect(anthropicCalls()).toBe(3);
    w.clock.advance(1);
    await w.watch.tick();
    expect(anthropicCalls()).toBe(4);
    w.clock.advance(HOUR);
    await w.watch.tick();
    expect(anthropicCalls()).toBe(4);
    w.clock.advance(HOUR);
    await w.watch.tick();
    expect(anthropicCalls()).toBe(5);
    const r = await w.watch.report();
    expect(r.providers[0]).toMatchObject({ ok: false, error_code: 'models.list_unavailable' });
    expect(Date.parse(r.providers[0]?.next_at ?? '') - w.clock.t).toBe(4 * HOUR);

    // A good check clears the failure.
    w.anthropic.fail = undefined;
    w.clock.advance(4 * HOUR);
    await w.watch.tick();
    expect((await w.watch.report()).providers[0]?.ok).toBe(true);
    w.watch.stop();
    expect(w.timers.timeouts[0]?.cleared).toBe(true);
    expect(w.timers.intervals[0]?.cleared).toBe(true);
  });

  it('checks on wake whatever came due while asleep, and no more', async () => {
    const w = await world();
    w.anthropic.data = base();
    await w.watch.tick();
    const n = () => w.calls.filter((c) => c.url.includes('anthropic.com')).length;
    await w.watch.onWake();
    expect(n()).toBe(1);
    w.clock.advance(30 * HOUR);
    await w.watch.onWake();
    expect(n()).toBe(2);
  });

  it('does nothing after stop()', async () => {
    const w = await world();
    w.anthropic.data = base();
    w.watch.start();
    w.watch.stop();
    await w.watch.tick();
    expect(w.calls).toEqual([]);
  });

  it('runs one check at a time', async () => {
    const w = await world();
    w.anthropic.data = base();
    await Promise.all([w.watch.tick(), w.watch.tick()]);
    expect(w.calls.filter((c) => c.url.includes('anthropic.com'))).toHaveLength(1);
  });
});
