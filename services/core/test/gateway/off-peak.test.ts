/**
 * ------------------------------------------------------------------
 *  Title    |  Off-peak prices (PV1)
 *  Ref      |  gateway/usage.ts (inWindows, ratesAt, priceOf) · WY1 receipt
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  DeepSeek charges half price outside 01:00-04:00 and
 *           |  06:00-10:00 UTC on Monday to Friday. A call is priced at
 *           |  the rate in force when it was made, and the receipt keeps
 *           |  that rate. The window maths is UTC only (no daylight
 *           |  saving) and runs from a start up to, not including, an end.
 * ------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type ModelConfig, ModelsFile, type PriceWindow } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { noteCall, type RunningUsage, ratesOf, usageOut } from '../../src/conductor/receipt';
import { inWindows, priceOf, ratesAt } from '../../src/gateway/usage';
import { fakeModel } from './fake-provider';

type Windows = PriceWindow[];

/** DeepSeek's off-peak hours: everything outside the peak windows. */
const OFF: Windows = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '00:00', to: '01:00' },
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '04:00', to: '06:00' },
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '10:00', to: '24:00' },
  { days: ['sat', 'sun'], from: '00:00', to: '24:00' },
];

const at = (iso: string) => Date.parse(`${iso}Z`);

describe('inWindows', () => {
  // 2026-10-19 is a Monday.
  it.each([
    ['2026-10-19T00:00:00', true], //   Monday, the start of the first off-peak window
    ['2026-10-19T00:59:59', true],
    ['2026-10-19T01:00:00', false], //  peak begins (the end is not included)
    ['2026-10-19T03:59:00', false],
    ['2026-10-19T04:00:00', true],
    ['2026-10-19T05:59:00', true],
    ['2026-10-19T06:00:00', false],
    ['2026-10-19T09:59:00', false],
    ['2026-10-19T10:00:00', true],
    ['2026-10-23T23:59:00', true], //   Friday night
    ['2026-10-24T00:00:00', true], //   Saturday: the week boundary, all day
    ['2026-10-24T05:00:00', true],
    ['2026-10-25T23:59:00', true], //   Sunday night
    ['2026-10-26T00:30:00', true], //   Monday again
    ['2026-10-26T02:00:00', false],
  ])('%s is off-peak: %s', (iso, expected) => {
    expect(inWindows(OFF, at(iso))).toBe(expected);
  });

  it('does not follow daylight saving: the clock is UTC', () => {
    // 2026-03-29 and 2026-10-25 are the European clock changes; a Sunday is off-peak whatever the hour.
    expect(inWindows(OFF, at('2026-03-29T01:30:00'))).toBe(true);
    // A Monday 02:00 UTC is peak all year, summer or winter.
    expect(inWindows(OFF, at('2026-07-06T02:00:00'))).toBe(false);
    expect(inWindows(OFF, at('2026-01-05T02:00:00'))).toBe(false);
  });

  it('reads a Date or a number, and an invalid time as not inside', () => {
    expect(inWindows(OFF, new Date('2026-10-19T02:00:00Z'))).toBe(false);
    expect(inWindows(OFF, Number.NaN)).toBe(false);
  });
});

const deepseek: ModelConfig = {
  ...fakeModel('deepseek', 'echo'),
  id: 'deepseek/flash',
  provider: 'deepseek',
  price: {
    input_per_mtok: 0.3,
    output_per_mtok: 1.2,
    cached_per_mtok: 0.006,
    off_peak: { input_per_mtok: 0.15, output_per_mtok: 0.6, cached_per_mtok: 0.003, windows: OFF },
  },
};
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 500_000 };

describe('priceOf at the time of the call', () => {
  it('charges the peak rate in peak and half of it off-peak', () => {
    const peak = priceOf(deepseek, usage, at('2026-10-19T02:00:00'));
    const off = priceOf(deepseek, usage, at('2026-10-19T12:00:00'));
    // 0.5M fresh x 0.3 + 0.5M cached x 0.006 + 1M out x 1.2
    expect(peak).toBeCloseTo(0.15 + 0.003 + 1.2, 6);
    expect(off).toBeCloseTo(0.075 + 0.0015 + 0.6, 6);
    expect(off).toBeCloseTo(peak / 2, 6);
    // Saturday at 02:00 UTC is off-peak too.
    expect(priceOf(deepseek, usage, at('2026-10-24T02:00:00'))).toBeCloseTo(off, 6);
  });

  it('prices now when no time is given, and a model without off-peak rates the same at any time', () => {
    const plain = { ...deepseek, price: { input_per_mtok: 2, output_per_mtok: 8 } };
    expect(priceOf(plain, usage, at('2026-10-19T02:00:00'))).toBe(
      priceOf(plain, usage, at('2026-10-24T12:00:00')),
    );
    expect(priceOf(deepseek, usage)).toBe(priceOf(deepseek, usage, Date.now()));
  });

  it('lets an off-peak rate leave a field out and keep the normal one', () => {
    const m = {
      ...deepseek.price,
      off_peak: { input_per_mtok: 0.1, output_per_mtok: 0.2, windows: OFF },
    };
    expect(ratesAt(m, at('2026-10-24T02:00:00'))).toEqual({
      input_per_mtok: 0.1,
      output_per_mtok: 0.2,
      cached_per_mtok: 0.006,
    });
    expect(ratesAt(m, at('2026-10-19T02:00:00'))).toEqual({
      input_per_mtok: 0.3,
      output_per_mtok: 1.2,
      cached_per_mtok: 0.006,
    });
  });
});

describe('the receipt uses the rates in force at the call', () => {
  it('shows off-peak rates on an answer made off-peak, and peak rates otherwise', () => {
    expect(ratesOf(deepseek, at('2026-10-19T12:00:00'))).toEqual({
      input: 0.15,
      cached: 0.003,
      cache_write: 0.15,
      output: 0.6,
    });
    expect(ratesOf(deepseek, at('2026-10-19T02:00:00'))).toMatchObject({ input: 0.3, output: 1.2 });
  });

  it('prices each call at its own start, so one answer can span the boundary', () => {
    const u: RunningUsage = { input: 0, output: 0, cached: 0, costUsd: 0 };
    const call = {
      model: deepseek,
      modelId: deepseek.id,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      startedMs: 0,
      ms: 1,
    };
    const peak = noteCall(u, { ...call, at: at('2026-10-19T09:59:59') });
    const off = noteCall(u, { ...call, at: at('2026-10-19T10:00:00') });
    expect(peak).toBeCloseTo(0.3, 6);
    expect(off).toBeCloseTo(0.15, 6);
    expect(u.listUsd).toBeCloseTo(0.45, 6);
    expect(
      usageOut(u, { model: deepseek, billing: null, ms: 1, at: at('2026-10-19T10:00:00') }).rates,
    ).toMatchObject({ input: 0.15 });
  });
});

describe('the schema and the shipped models', () => {
  it('rejects a window that crosses midnight or has a bad time', () => {
    const bad = (windows: unknown) =>
      ModelsFile.safeParse({
        version: 1,
        models: [
          { ...deepseek, price: { ...deepseek.price, off_peak: { ...deepseek.price.off_peak, windows } } },
        ],
      }).success;
    expect(bad([{ days: ['mon'], from: '22:00', to: '02:00' }])).toBe(false);
    expect(bad([{ days: ['mon'], from: '25:00', to: '26:00' }])).toBe(false);
    expect(bad([{ days: [], from: '01:00', to: '02:00' }])).toBe(false);
    expect(bad([{ days: ['funday'], from: '01:00', to: '02:00' }])).toBe(false);
    expect(bad([{ days: ['mon'], from: '22:00', to: '24:00' }])).toBe(true);
  });

  it('ships DeepSeek at half price off-peak, and a valid models.yaml', () => {
    const file = fileURLToPath(new URL('../../../../config/models.yaml', import.meta.url));
    const models = ModelsFile.parse(parse(readFileSync(file, 'utf8'))).models;
    const pro = models.find((m) => m.id === 'deepseek/deepseek-v4-pro');
    const flash = models.find((m) => m.id === 'deepseek/deepseek-flash');
    expect(pro?.price.off_peak?.input_per_mtok).toBeCloseTo((pro?.price.input_per_mtok ?? 0) / 2, 6);
    expect(flash?.price.off_peak?.output_per_mtok).toBeCloseTo((flash?.price.output_per_mtok ?? 0) / 2, 6);
    // Peak hours: Monday 02:00 and 08:00 UTC; off-peak: Monday 12:00 and Sunday 08:00.
    const w = flash?.price.off_peak?.windows ?? [];
    expect(inWindows(w, at('2026-10-19T02:00:00'))).toBe(false);
    expect(inWindows(w, at('2026-10-19T08:00:00'))).toBe(false);
    expect(inWindows(w, at('2026-10-19T12:00:00'))).toBe(true);
    expect(inWindows(w, at('2026-10-25T08:00:00'))).toBe(true);
    // Every PV1 provider has its models, none of them on by default.
    for (const provider of ['deepseek', 'moonshot', 'minimax', 'zai', 'qwen', 'xai', 'mistral']) {
      const mine = models.filter((m) => m.provider === provider);
      expect(mine.length, provider).toBeGreaterThanOrEqual(1);
      expect(
        mine.every((m) => !m.enabled && !m.base_url),
        provider,
      ).toBe(true);
    }
  });
});
