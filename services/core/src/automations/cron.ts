/**
 * ------------------------------------------------------------------
 *  Title    |  Cron
 *  Ref      |  config/automations.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The five-field schedules the automations use, read in
 *           |  the server's local time: when is the next run, and how
 *           |  to say the schedule in words.
 *  How      |  Each field becomes the set of values it allows (*, a,
 *           |  a-b, a-b/n, *\/n, lists). next() walks forward minute by
 *           |  minute, skipping whole hours and days that cannot
 *           |  match, so it stays fast for rare schedules. Standard
 *           |  cron rule: when both day-of-month and day-of-week are
 *           |  restricted, either may match.
 * ------------------------------------------------------------------
 */

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
  source: string;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function field(text: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a valid ${name} in a cron schedule`);
    const step = m[3] ? Number(m[3]) : 1;
    const start = m[1] === '*' ? lo : Number(m[1]);
    const end = m[1] === '*' ? hi : m[2] ? Number(m[2]) : m[3] ? hi : start;
    if (step < 1 || start < lo || end > hi || start > end)
      throw new Error(`"${part}" is out of range for ${name} (${lo}-${hi})`);
    for (let v = start; v <= end; v += step) out.add(name === 'weekday' && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(source: string): Cron {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`A cron schedule has five fields; "${source}" has ${parts.length}`);
  const names = ['minute', 'hour', 'day of month', 'month', 'weekday'];
  const [mi, h, d, mo, w] = parts.map((p, i) => field(p, RANGES[i] as [number, number], names[i] as string));
  return {
    minutes: mi as Set<number>,
    hours: h as Set<number>,
    days: d as Set<number>,
    months: mo as Set<number>,
    weekdays: w as Set<number>,
    dayRestricted: parts[2] !== '*',
    weekdayRestricted: parts[4] !== '*',
    source,
  };
}

function dayMatches(c: Cron, t: Date): boolean {
  const dom = c.days.has(t.getDate());
  const dow = c.weekdays.has(t.getDay());
  if (c.dayRestricted && c.weekdayRestricted) return dom || dow;
  if (c.dayRestricted) return dom;
  if (c.weekdayRestricted) return dow;
  return true;
}

/** The first minute strictly after `after` that the schedule allows (null if none within ~4 years). */
export function nextRun(c: Cron, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const two = (n: number) => String(n).padStart(2, '0');

/** A schedule in plain words, for the common shapes; the cron text otherwise. */
export function cronWords(source: string): string {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) return source;
  const [mi, h, d, mo, w] = parts as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/;
  if (d === '*' && mo === '*' && w === '*') {
    if (h === '*' && every.test(mi)) return `Every ${every.exec(mi)?.[1]} minutes`;
    if (h === '*' && /^\d+$/.test(mi)) return mi === '0' ? 'Every hour' : `Every hour at :${two(Number(mi))}`;
    if (/^\d+$/.test(h) && /^\d+$/.test(mi)) return `Every day at ${two(Number(h))}:${two(Number(mi))}`;
  }
  if (d === '*' && mo === '*' && /^\d$/.test(w) && /^\d+$/.test(h) && /^\d+$/.test(mi))
    return `Every ${DAYS[Number(w) % 7]} at ${two(Number(h))}:${two(Number(mi))}`;
  return source;
}
