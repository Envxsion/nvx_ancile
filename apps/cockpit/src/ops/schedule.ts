/**
 * ------------------------------------------------------------------
 *  Title    |  Schedules
 *  Ref      |  services/core/src/automations/cron.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a cron schedule into the friendly picker (every N
 *           |  minutes or hours, daily at a time, weekly on chosen days
 *           |  at a time) and back, and say what is wrong with a
 *           |  custom one before it is sent.
 *  How      |  Pure functions. Anything the picker cannot show opens as
 *           |  Custom with its text untouched. Core checks the schedule
 *           |  again (automation.bad_schedule, automation.too_often).
 * ------------------------------------------------------------------
 */

export type ScheduleMode = 'minutes' | 'hours' | 'daily' | 'weekly' | 'custom';

export interface ScheduleDraft {
  mode: ScheduleMode;
  /** Every N minutes (5 to 59) or hours (1 to 23). */
  every: number;
  /** HH:MM, for daily and weekly. */
  time: string;
  /** Weekdays, 0 = Sunday. */
  days: number[];
  /** The schedule as typed, for custom. */
  cron: string;
}

/** The shortest gap Core accepts (MIN_INTERVAL_MINUTES in cron.ts). */
export const MIN_MINUTES = 5;

const two = (n: number) => String(n).padStart(2, '0');
const NUM = /^\d+$/;
const EVERY = /^\*\/(\d+)$/;

export const DEFAULT_DRAFT: ScheduleDraft = {
  mode: 'daily',
  every: 15,
  time: '09:00',
  days: [1, 2, 3, 4, 5],
  cron: '0 9 * * *',
};

function expandDays(w: string): number[] | null {
  const out = new Set<number>();
  for (const part of w.split(',')) {
    const range = /^([0-7])-([0-7])$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b) return null;
      for (let d = a; d <= b; d++) out.add(d % 7);
    } else if (/^[0-7]$/.test(part)) out.add(Number(part) % 7);
    else return null;
  }
  return [...out].sort((a, b) => a - b);
}

/** The picker's view of a schedule; Custom when the picker cannot show it. */
export function draftFromCron(cron: string): ScheduleDraft {
  const base = { ...DEFAULT_DRAFT, cron: cron.trim() };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, mode: 'custom' };
  const [mi, h, d, mo, w] = parts as [string, string, string, string, string];
  if (d !== '*' || mo !== '*') return { ...base, mode: 'custom' };
  if (w === '*') {
    const m = EVERY.exec(mi);
    if (m && h === '*') return { ...base, mode: 'minutes', every: Number(m[1]) };
    if (mi === '0' && h === '*') return { ...base, mode: 'hours', every: 1 };
    const hh = EVERY.exec(h);
    if (mi === '0' && hh) return { ...base, mode: 'hours', every: Number(hh[1]) };
  }
  if (NUM.test(mi) && NUM.test(h) && Number(mi) < 60 && Number(h) < 24) {
    const time = `${two(Number(h))}:${two(Number(mi))}`;
    if (w === '*') return { ...base, mode: 'daily', time };
    const days = expandDays(w);
    if (days?.length) return { ...base, mode: 'weekly', time, days };
  }
  return { ...base, mode: 'custom' };
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

/** The cron text for a picker state. */
export function cronFromDraft(d: ScheduleDraft): string {
  const [h, m] = d.time.split(':').map(Number);
  const hh = clamp(h ?? 9, 0, 23);
  const mm = clamp(m ?? 0, 0, 59);
  switch (d.mode) {
    case 'minutes':
      return `*/${clamp(d.every, MIN_MINUTES, 59)} * * * *`;
    case 'hours': {
      const n = clamp(d.every, 1, 23);
      return n === 1 ? '0 * * * *' : `0 */${n} * * *`;
    }
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekly': {
      const days = [...new Set(d.days)].sort((a, b) => a - b);
      return `${mm} ${hh} * * ${days.length ? days.join(',') : '*'}`;
    }
    case 'custom':
      return d.cron.trim().replace(/\s+/g, ' ');
  }
}

const FIELDS: { name: string; lo: number; hi: number }[] = [
  { name: 'minute', lo: 0, hi: 59 },
  { name: 'hour', lo: 0, hi: 23 },
  { name: 'day of month', lo: 1, hi: 31 },
  { name: 'month', lo: 1, hi: 12 },
  { name: 'weekday', lo: 0, hi: 7 },
];

/** What is wrong with a schedule, in a sentence, or null when it reads. */
export function cronError(cron: string): string | null {
  const parts = cron.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5)
    return 'Use five fields: minute, hour, day of month, month and weekday, for example "0 9 * * 1-5".';
  for (const [i, text] of parts.entries()) {
    const f = FIELDS[i] as { name: string; lo: number; hi: number };
    for (const part of text.split(',')) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
      if (!m) return `"${part}" is not a ${f.name}.`;
      const nums = [m[1], m[2]].filter((x): x is string => !!x && x !== '*').map(Number);
      if (nums.some((n) => n < f.lo || n > f.hi)) return `The ${f.name} must be ${f.lo} to ${f.hi}.`;
      if (m[3] !== undefined && Number(m[3]) < 1) return `"${part}" steps by nothing.`;
    }
  }
  if (parts[0] === '*' || /^\*\/[1-4]$/.test(parts[0] ?? ''))
    return `Leave at least ${MIN_MINUTES} minutes between runs.`;
  return null;
}

export const WEEKDAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: 'Mon', name: 'Monday' },
  { value: 2, short: 'Tue', name: 'Tuesday' },
  { value: 3, short: 'Wed', name: 'Wednesday' },
  { value: 4, short: 'Thu', name: 'Thursday' },
  { value: 5, short: 'Fri', name: 'Friday' },
  { value: 6, short: 'Sat', name: 'Saturday' },
  { value: 0, short: 'Sun', name: 'Sunday' },
];
