/**
 * ------------------------------------------------------------------
 *  Title    |  Scheduled actions
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  "Stop every node at 19:00 Melbourne time on weekdays."
 *  How      |  A small five-field cron matcher (minute hour day-of-
 *           |  month month day-of-week; *, lists, ranges, steps; DOW
 *           |  0 or 7 = Sunday; DOM/DOW use classic OR semantics when
 *           |  both are restricted), evaluated in the rule's time zone
 *           |  via Intl, so DST is the platform's problem, not ours.
 *           |  The runner passes the last fire time; any matching
 *           |  minute since then (capped at 24 h, so a long outage does
 *           |  not replay a week of schedules) fires once.
 * ------------------------------------------------------------------
 */

import type { NodeAction, Rule } from '@nvx/contracts/controller';
import { appliesTo, type NodeView, type RuleOutcome } from './types';

type ScheduleRule = Extract<Rule, { kind: 'schedule' }>;

interface CronField {
  values: Set<number>;
  any: boolean;
}
export interface Cron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(src: string, [lo, hi]: [number, number], name: string): CronField {
  const values = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${name}: cannot read "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) throw new Error(`cron ${name}: step must be at least 1`);
    let from = lo;
    let to = hi;
    if (m[1] !== '*') {
      from = Number(m[2]);
      to = m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    }
    if (from < lo || to > hi || from > to) throw new Error(`cron ${name}: ${part} is outside ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any: src === '*' };
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error('cron must have five fields: minute hour day-of-month month day-of-week');
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  const [minute, hour, dom, month, dow] = parts.map((p, i) =>
    parseField(p, RANGES[i] as [number, number], names[i] as string),
  ) as [CronField, CronField, CronField, CronField, CronField];
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dom, month, dow };
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatters.get(tz);
  if (!fmt) {
    // Throws RangeError for an unknown zone: rule validation surfaces it.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

export function zonedParts(d: Date, tz: string) {
  const parts = formatter(tz).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    dom: Number(get('day')),
    month: Number(get('month')),
    dow: WEEKDAY[get('weekday')] ?? 0,
  };
}

export function cronMatches(cron: Cron, d: Date, tz: string): boolean {
  const p = zonedParts(d, tz);
  if (!cron.minute.values.has(p.minute) || !cron.hour.values.has(p.hour) || !cron.month.values.has(p.month))
    return false;
  const domOk = cron.dom.values.has(p.dom);
  const dowOk = cron.dow.values.has(p.dow);
  if (!cron.dom.any && !cron.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

const MAX_LOOKBACK_MS = 24 * 3_600_000;

/** The latest matching minute in (since, now], or null. */
export function lastMatch(cron: Cron, tz: string, since: Date | null, now: Date): Date | null {
  const floor = Math.max(since ? since.getTime() : now.getTime() - 60_000, now.getTime() - MAX_LOOKBACK_MS);
  let t = Math.floor(now.getTime() / 60_000) * 60_000;
  while (t > floor) {
    const d = new Date(t);
    if (cronMatches(cron, d, tz)) return d;
    t -= 60_000;
  }
  return null;
}

function wants(action: NodeAction, node: NodeView): boolean {
  switch (action) {
    case 'stop':
      return node.state === 'running' || node.state === 'starting';
    case 'start':
      return node.state === 'stopped';
    case 'restart':
      return node.state === 'running';
    case 'terminate':
      return node.state !== 'terminated' && node.state !== 'terminating';
  }
}

export function evaluateSchedule(
  rule: ScheduleRule,
  nodes: NodeView[],
  lastFiredAt: Date | null,
  now: Date,
): RuleOutcome & { firedAt: Date | null } {
  const out = { actions: [], blockRouting: false, notices: [], firedAt: null } as RuleOutcome & {
    firedAt: Date | null;
  };
  if (!rule.enabled) return out;
  const fired = lastMatch(parseCron(rule.config.cron), rule.config.tz, lastFiredAt, now);
  if (!fired) return out;
  out.firedAt = fired;
  for (const node of nodes) {
    if (
      !appliesTo(rule.config.node_ids, node.id) ||
      node.hasLiveOperation ||
      !wants(rule.config.action, node)
    )
      continue;
    out.actions.push({
      nodeId: node.id,
      action: rule.config.action,
      reason: `rule:${rule.id} schedule ${rule.config.cron}`,
    });
  }
  if (out.actions.length > 0) {
    out.notices.push({
      level: 'info',
      title: `Scheduled ${rule.config.action}`,
      body: `${out.actions.length} node${out.actions.length === 1 ? '' : 's'} affected by "${rule.config.cron}" (${rule.config.tz}).`,
    });
  }
  return out;
}
