/**
 * ------------------------------------------------------------------
 *  Title    |  Off-peak prices in your own hours
 *  Ref      |  roadmap PV1 (DeepSeek off-peak) · config/models.yaml
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Some providers charge less at quiet hours. Core knows
 *           |  the windows in UTC; this says them in your local time,
 *           |  in words ("Weekdays before 9 am and after 7 pm, and all
 *           |  weekend"), and names the discount.
 *  How      |  The week is laid out minute by minute in UTC, shifted by
 *           |  the zone's offset, cut back into local days, and days
 *           |  with the same hours are grouped. Adjacent windows merge
 *           |  for free because the week is one array.
 *  Note     |  The offset is the one in force on `now`. Across a clock
 *           |  change the hours move by an hour for a few weeks; the
 *           |  rates themselves are always charged by UTC window.
 * ------------------------------------------------------------------
 */

import type { PriceWindow } from '@nvx/contracts';

/** The off-peak rates of one model, per million tokens. */
export interface OffPeakRates {
  in: number;
  out: number;
  windows: PriceWindow[];
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_NAME = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEK = 7 * 1440;

const clock = (t: string): number => {
  const [h = '0', m = '0'] = t.split(':');
  return Number(h) * 60 + Number(m);
};

/** What Core sent as a model's off-peak price, or undefined when it sent none or something unreadable. */
export function offPeakOf(raw: unknown): OffPeakRates | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const windows = o.windows;
  if (typeof o.input_per_mtok !== 'number' || typeof o.output_per_mtok !== 'number') return undefined;
  if (!Array.isArray(windows) || windows.length === 0) return undefined;
  return { in: o.input_per_mtok, out: o.output_per_mtok, windows: windows as PriceWindow[] };
}

/** Minutes the zone is ahead of UTC at `at` (Sydney in summer: 660). */
export function zoneOffsetMinutes(timeZone: string | undefined, at: Date): number {
  if (!timeZone) return -at.getTimezoneOffset();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** Per local day (Monday first), the off-peak spans as [from, to) minutes. */
export function localSpans(
  windows: PriceWindow[],
  timeZone?: string,
  now: Date = new Date(),
): [number, number][][] {
  const utc = new Uint8Array(WEEK);
  for (const w of windows) {
    const from = clock(w.from);
    const to = Math.min(clock(w.to), 1440);
    for (const d of w.days) {
      const i = DAYS.indexOf(d as (typeof DAYS)[number]);
      if (i < 0) continue;
      for (let m = from; m < to; m++) utc[i * 1440 + m] = 1;
    }
  }
  const offset = zoneOffsetMinutes(timeZone, now);
  const out: [number, number][][] = [];
  for (let day = 0; day < 7; day++) {
    const spans: [number, number][] = [];
    let start = -1;
    for (let m = 0; m <= 1440; m++) {
      const on = m < 1440 && utc[(((day * 1440 + m - offset) % WEEK) + WEEK) % WEEK] === 1;
      if (on && start < 0) start = m;
      if (!on && start >= 0) {
        spans.push([start, m]);
        start = -1;
      }
    }
    out.push(spans);
  }
  return out;
}

/** "9 am", "7:30 pm", "midnight", "noon". */
export function timeWords(minutes: number): string {
  const m = minutes % 1440;
  if (m === 0) return 'midnight';
  if (m === 720) return 'noon';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

function joinWords(parts: string[], last = 'and'): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} ${last} ${parts[parts.length - 1]}`;
}

function spanWords(spans: [number, number][]): string {
  return joinWords(
    spans.map(([a, b]) => {
      if (a === 0) return `before ${timeWords(b)}`;
      if (b === 1440) return `after ${timeWords(a)}`;
      return `from ${timeWords(a)} to ${timeWords(b)}`;
    }),
  );
}

function daysWords(days: number[], allDay: boolean): string {
  const key = days.join(',');
  if (key === '0,1,2,3,4') return allDay ? 'all day on weekdays' : 'weekdays';
  if (key === '5,6') return allDay ? 'all weekend' : 'weekends';
  if (key === '0,1,2,3,4,5,6') return allDay ? 'all day, every day' : 'every day';
  const consecutive = days.length >= 3 && days.every((d, i) => i === 0 || d === (days[i - 1] ?? 0) + 1);
  const names = consecutive
    ? `${DAY_NAME[days[0] ?? 0]} to ${DAY_NAME[days[days.length - 1] ?? 0]}`
    : joinWords(days.map((d) => `${DAY_NAME[d]}s`));
  return allDay ? `all day on ${names}` : names;
}

/**
 * The off-peak hours in plain words, in `timeZone` (the browser's own when
 * omitted): "Weekdays before 9 am and after 7 pm, and all weekend".
 */
export function offPeakWords(windows: PriceWindow[], timeZone?: string, now: Date = new Date()): string {
  const perDay = localSpans(windows, timeZone, now);
  const groups = new Map<string, number[]>();
  perDay.forEach((spans, day) => {
    if (!spans.length) return;
    const sig = spans.map((s) => s.join('-')).join(',');
    groups.set(sig, [...(groups.get(sig) ?? []), day]);
  });
  if (!groups.size) return 'There are no off-peak hours.';
  const clauses = [...groups.entries()]
    .sort((a, b) => (a[1][0] ?? 0) - (b[1][0] ?? 0))
    .map(([sig, days]) => {
      const spans = sig.split(',').map((s) => s.split('-').map(Number) as [number, number]);
      const allDay = spans.length === 1 && spans[0]?.[0] === 0 && spans[0]?.[1] === 1440;
      const d = daysWords(days, allDay);
      if (allDay) return d;
      const day = d.charAt(0).toUpperCase() + d.slice(1);
      return `${day} ${spanWords(spans)}`;
    });
  const joined =
    clauses.length <= 1
      ? clauses.join('')
      : clauses.length === 2
        ? `${clauses[0]}, and ${clauses[1]}`
        : `${clauses.slice(0, -1).join('; ')}; and ${clauses[clauses.length - 1]}`;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
}

/** "Half price off-peak", "25% cheaper off-peak" or "Cheaper off-peak" when input and output differ. */
export function offPeakLabel(normal: { in: number; out: number }, off: OffPeakRates): string {
  const rin = normal.in > 0 ? off.in / normal.in : null;
  const rout = normal.out > 0 ? off.out / normal.out : null;
  const ratio = rin ?? rout;
  if (ratio === null || (rin !== null && rout !== null && Math.abs(rin - rout) > 0.02))
    return 'Cheaper off-peak';
  if (Math.abs(ratio - 0.5) < 0.02) return 'Half price off-peak';
  const off100 = Math.round((1 - ratio) * 100);
  return off100 > 0 ? `${off100}% cheaper off-peak` : 'Cheaper off-peak';
}

/** The tag's tooltip: the hours, in your time zone. */
export function offPeakTitle(
  normal: { in: number; out: number },
  off: OffPeakRates,
  timeZone?: string,
  now: Date = new Date(),
): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${offPeakLabel(normal, off)}. ${offPeakWords(off.windows, zone, now)} (your time, ${zone}).`;
}
