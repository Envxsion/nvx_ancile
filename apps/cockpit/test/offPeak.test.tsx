/**
 * PV1: a model with off-peak prices says so with a small tag, and the hours
 * are told in the viewer's own time zone, adjacent windows merged.
 */
import type { ModelInfo, PriceWindow } from '@nvx/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { toModelView } from '../src/lib/mappers';
import { billingTitle } from '../src/models/billing';
import { OffPeakTag } from '../src/models/OffPeakTag';
import {
  localSpans,
  type OffPeakRates,
  offPeakLabel,
  offPeakOf,
  offPeakTitle,
  offPeakWords,
  timeWords,
  zoneOffsetMinutes,
} from '../src/models/offPeak';

// DeepSeek's off-peak hours as Core holds them (UTC).
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
const WINDOWS: PriceWindow[] = [
  { days: [...WEEKDAYS], from: '00:00', to: '01:00' },
  { days: [...WEEKDAYS], from: '04:00', to: '06:00' },
  { days: [...WEEKDAYS], from: '10:00', to: '24:00' },
  { days: ['sat', 'sun'], from: '00:00', to: '24:00' },
];
const OFF: OffPeakRates = { in: 0.66, out: 1.98, windows: WINDOWS };
const JANUARY = new Date('2026-01-15T12:00:00Z');

describe('time zones', () => {
  it('knows the offset of a zone on a date', () => {
    expect(zoneOffsetMinutes('Australia/Sydney', JANUARY)).toBe(660);
    expect(zoneOffsetMinutes('Australia/Sydney', new Date('2026-07-15T12:00:00Z'))).toBe(600);
    expect(zoneOffsetMinutes('Europe/London', JANUARY)).toBe(0);
    expect(zoneOffsetMinutes('Europe/London', new Date('2026-07-15T12:00:00Z'))).toBe(60);
    expect(zoneOffsetMinutes('UTC', JANUARY)).toBe(0);
  });

  it('says times as people do', () => {
    expect(timeWords(0)).toBe('midnight');
    expect(timeWords(540)).toBe('9 am');
    expect(timeWords(720)).toBe('noon');
    expect(timeWords(1170)).toBe('7:30 pm');
  });
});

describe('off-peak hours in words', () => {
  it('keeps UTC as it is, and calls the weekend all weekend', () => {
    expect(offPeakWords(WINDOWS, 'UTC', JANUARY)).toBe(
      'Weekdays before 1 am, from 4 am to 6 am and after 10 am, and all weekend',
    );
  });

  it('moves them into London time (winter is UTC, summer is an hour on)', () => {
    expect(offPeakWords(WINDOWS, 'Europe/London', JANUARY)).toBe(
      'Weekdays before 1 am, from 4 am to 6 am and after 10 am, and all weekend',
    );
    expect(offPeakWords(WINDOWS, 'Europe/London', new Date('2026-07-15T12:00:00Z'))).toBe(
      'Weekdays before 2 am, from 5 am to 7 am and after 11 am, and all weekend',
    );
  });

  it('moves them into Sydney time and merges the windows that now touch', () => {
    // Sunday evening UTC is Monday morning in Sydney: the weekend runs into the 00:00-01:00 window.
    expect(offPeakWords(WINDOWS, 'Australia/Sydney', JANUARY)).toBe(
      'Weekdays before noon, from 3 pm to 5 pm and after 9 pm, and all weekend',
    );
  });

  it('lets a window that crosses a local midnight land on both days', () => {
    const spans = localSpans([{ days: ['sat'], from: '00:00', to: '24:00' }], 'Australia/Sydney', JANUARY);
    // UTC Saturday is Saturday 11:00 to Sunday 11:00 in Sydney.
    expect(spans[5]).toEqual([[660, 1440]]);
    expect(spans[6]).toEqual([[0, 660]]);
  });

  it('joins windows that are written apart but touch', () => {
    const split: PriceWindow[] = [
      { days: ['mon'], from: '00:00', to: '12:00' },
      { days: ['mon'], from: '12:00', to: '24:00' },
    ];
    expect(offPeakWords(split, 'UTC', JANUARY)).toBe('All day on Mondays');
  });
});

describe('the price tag', () => {
  it('says half price when both prices are halved', () => {
    expect(offPeakLabel({ in: 1.32, out: 3.96 }, OFF)).toBe('Half price off-peak');
  });

  it('names another ratio, or stays general when the two differ', () => {
    expect(offPeakLabel({ in: 4, out: 8 }, { ...OFF, in: 3, out: 6 })).toBe('25% cheaper off-peak');
    expect(offPeakLabel({ in: 4, out: 8 }, { ...OFF, in: 3, out: 2 })).toBe('Cheaper off-peak');
  });

  it('tells the hours in the title, with the zone', () => {
    const title = offPeakTitle({ in: 1.32, out: 3.96 }, OFF, 'Australia/Sydney', JANUARY);
    expect(title).toContain('Half price off-peak.');
    expect(title).toContain('Weekdays before noon');
    expect(title).toContain('Australia/Sydney');
    expect(title).not.toContain('—');
  });

  it('renders as a small tag, with the hours for a screen reader too', () => {
    render(<OffPeakTag price={{ in: 1.32, out: 3.96 }} offPeak={OFF} />);
    const tag = screen.getByText('Half price off-peak');
    expect(tag).toBeInTheDocument();
    expect(tag.closest('.tag')?.getAttribute('title')).toMatch(/all weekend/);
    expect(screen.getByText(/all weekend/, { selector: '.sr-only' })).toBeInTheDocument();
  });

  it('adds itself to a model badge tooltip', () => {
    const title = billingTitle({ kind: 'key', payer: 'deepseek' }, { in: 1.32, out: 3.96, offPeak: OFF });
    expect(title).toBe(
      'DeepSeek API key, pay per use: $1.32 in, $3.96 out per million tokens. Half price off-peak',
    );
    expect(billingTitle({ kind: 'key', payer: 'deepseek' }, { in: 1.32, out: 3.96 })).not.toContain(
      'off-peak',
    );
  });
});

describe('what Core sends', () => {
  it('reads an off_peak price, and ignores anything else', () => {
    expect(offPeakOf({ input_per_mtok: 1, output_per_mtok: 2, windows: WINDOWS })).toEqual({
      in: 1,
      out: 2,
      windows: WINDOWS,
    });
    expect(offPeakOf(undefined)).toBeUndefined();
    expect(offPeakOf({ input_per_mtok: 1 })).toBeUndefined();
    expect(offPeakOf({ input_per_mtok: 1, output_per_mtok: 2, windows: [] })).toBeUndefined();
  });
});

describe('the model list', () => {
  const wire = (price: object) =>
    ({
      id: 'deepseek/deepseek-pro',
      display_name: 'DeepSeek V4.1 Pro',
      provider: 'deepseek',
      family: 'deepseek',
      via: 'direct',
      context_window: 128_000,
      max_output: 8_000,
      capabilities: [],
      price,
      status: 'ready',
      billing: { kind: 'key', payer: 'deepseek' },
      secret: 'DEEPSEEK_API_KEY',
      offline: false,
    }) as unknown as ModelInfo;

  it('carries off-peak prices into the view when Core sends them', () => {
    const m = toModelView(
      wire({
        input_per_mtok: 1.32,
        output_per_mtok: 3.96,
        off_peak: { input_per_mtok: 0.66, output_per_mtok: 1.98, windows: WINDOWS },
      }),
    );
    expect(m.provider).toBe('DeepSeek');
    expect(m.price?.offPeak?.in).toBe(0.66);
  });

  it('has none for an ordinary price', () => {
    expect(toModelView(wire({ input_per_mtok: 3, output_per_mtok: 15 })).price).toEqual({ in: 3, out: 15 });
  });
});
