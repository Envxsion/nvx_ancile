/**
 * ------------------------------------------------------------------
 *  Title    |  Rule drafts
 *  Ref      |  DESIGN.md §7.3 · packages/contracts/src/controller.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The words and checks behind the rule dialog: a draft
 *           |  the form edits as text, whether it is ready to save,
 *           |  the rule it becomes, and how a saved rule reads in the
 *           |  list.
 *  How      |  Pure functions over the contract's Rule, so the form
 *           |  and its tests agree. New drafts start empty: the person
 *           |  types the minutes, the amount or the time.
 *  Note     |  A schedule the form can read is "M H * * *" plus
 *           |  optional weekdays. Anything else (set over the API) is
 *           |  shown as its cron and is not editable here.
 * ------------------------------------------------------------------
 */

import { type Rule, WEEKDAYS, type Weekday } from '@nvx/contracts/controller';

export type RuleKind = Rule['kind'];
export type OnReach = Extract<Rule, { kind: 'cost_cap' }>['config']['on_reach'];
export type ScheduleAction = 'stop' | 'start';

export const DAY_LABEL: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};
export const DAY_NAME: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface RuleDraft {
  id?: string;
  kind: RuleKind;
  enabled: boolean;
  /** 'all', or the chosen node ids. */
  scope: 'all' | 'chosen';
  nodeIds: string[];
  minutes: string;
  amount: string;
  onReach: OnReach;
  time: string;
  action: ScheduleAction;
  days: Weekday[];
  tz: string;
}

export function emptyDraft(kind: RuleKind, tz: string): RuleDraft {
  return {
    kind,
    enabled: true,
    scope: 'all',
    nodeIds: [],
    minutes: '',
    amount: '',
    onReach: 'block_routing',
    time: '',
    action: 'stop',
    days: [...WEEKDAYS],
    tz,
  };
}

const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

/** "M H * * *" as "HH:MM", or null for any other cron. */
export function dailyTime(cron: string): string | null {
  const m = DAILY.exec(cron.trim());
  if (!m) return null;
  return `${(m[2] ?? '').padStart(2, '0')}:${(m[1] ?? '').padStart(2, '0')}`;
}

/** Can the dialog edit this rule without losing anything? */
export function editable(rule: Rule): boolean {
  if (rule.kind !== 'schedule') return true;
  return (
    dailyTime(rule.config.cron) !== null && (rule.config.action === 'stop' || rule.config.action === 'start')
  );
}

export function draftOf(rule: Rule, tz: string): RuleDraft {
  const d = emptyDraft(rule.kind, tz);
  d.id = rule.id;
  d.enabled = rule.enabled;
  const nodes = rule.kind === 'cost_cap' ? (rule.config.node_ids ?? '*') : rule.config.node_ids;
  if (nodes !== '*') {
    d.scope = 'chosen';
    d.nodeIds = [...nodes];
  }
  if (rule.kind === 'idle_timeout') d.minutes = String(rule.config.idle_minutes);
  if (rule.kind === 'cost_cap') {
    d.amount = String(rule.config.monthly_usd);
    d.onReach = rule.config.on_reach;
  }
  if (rule.kind === 'schedule') {
    d.time = dailyTime(rule.config.cron) ?? '';
    d.action = rule.config.action === 'start' ? 'start' : 'stop';
    d.days = rule.config.weekdays ? [...rule.config.weekdays] : [...WEEKDAYS];
    d.tz = rule.config.tz;
  }
  return d;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export type DraftProblem = { field: 'minutes' | 'amount' | 'time' | 'days' | 'nodes'; message: string };

/** What stops this draft from saving, field by field. Empty means ready. */
export function problems(d: RuleDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  const needsNodes = d.kind !== 'cost_cap' || d.onReach === 'stop_nodes';
  if (needsNodes && d.scope === 'chosen' && d.nodeIds.length === 0)
    out.push({ field: 'nodes', message: 'Choose at least one node, or pick All nodes.' });
  if (d.kind === 'idle_timeout') {
    const n = Number(d.minutes);
    if (!d.minutes.trim()) out.push({ field: 'minutes', message: 'Type how many minutes.' });
    else if (!Number.isInteger(n) || n < 5 || n > 1440)
      out.push({ field: 'minutes', message: 'Use a whole number from 5 to 1440.' });
  }
  if (d.kind === 'cost_cap') {
    const n = Number(d.amount);
    if (!d.amount.trim()) out.push({ field: 'amount', message: 'Type the monthly amount.' });
    else if (!Number.isFinite(n) || n <= 0) out.push({ field: 'amount', message: 'Use an amount above $0.' });
  }
  if (d.kind === 'schedule') {
    if (!d.time.trim()) out.push({ field: 'time', message: 'Type the time.' });
    else if (!TIME.test(d.time.trim()))
      out.push({ field: 'time', message: 'Use 24-hour time, hours and minutes.' });
    if (d.days.length === 0) out.push({ field: 'days', message: 'Choose at least one day.' });
  }
  return out;
}

/** The rule a ready draft saves as. Call only when problems() is empty. */
export function ruleOf(d: RuleDraft): Omit<Rule, 'id'> & { id?: string } {
  const node_ids = d.scope === 'all' ? ('*' as const) : [...d.nodeIds];
  const base = { ...(d.id ? { id: d.id } : {}), enabled: d.enabled };
  if (d.kind === 'idle_timeout')
    return { ...base, kind: 'idle_timeout', config: { node_ids, idle_minutes: Number(d.minutes) } };
  if (d.kind === 'cost_cap')
    return {
      ...base,
      kind: 'cost_cap',
      config: {
        monthly_usd: Number(d.amount),
        on_reach: d.onReach,
        ...(d.onReach === 'stop_nodes' && node_ids !== '*' ? { node_ids } : {}),
      },
    };
  const [h, m] = d.time.trim().split(':').map(Number);
  const days = WEEKDAYS.filter((w) => d.days.includes(w));
  return {
    ...base,
    kind: 'schedule',
    config: {
      node_ids,
      cron: `${m} ${h} * * *`,
      action: d.action,
      tz: d.tz,
      ...(days.length < WEEKDAYS.length ? { weekdays: days } : {}),
    },
  };
}

/** "Mon to Fri", "Sat and Sun", "Mon, Wed, Fri", "every day". */
export function daysWords(days: readonly Weekday[] | undefined): string {
  if (!days || days.length === WEEKDAYS.length) return 'every day';
  const sorted = WEEKDAYS.filter((w) => days.includes(w));
  const idx = sorted.map((w) => WEEKDAYS.indexOf(w));
  const run = idx.every((v, i) => i === 0 || v === (idx[i - 1] ?? 0) + 1);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (sorted.length >= 3 && run && first && last) return `${DAY_LABEL[first]} to ${DAY_LABEL[last]}`;
  const labels = sorted.map((w) => DAY_LABEL[w]);
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return labels.join(', ');
}

export function nodesWords(ids: string[] | '*' | undefined, names: Map<string, string>): string {
  if (!ids || ids === '*') return 'all nodes';
  const known = ids.map((id) => names.get(id)).filter((n): n is string => Boolean(n));
  if (known.length === 0) return ids.length === 1 ? '1 node' : `${ids.length} nodes`;
  if (known.length <= 2 && known.length === ids.length) return known.join(' and ');
  return `${ids.length} nodes`;
}

export function ruleTitle(rule: Rule): string {
  if (rule.kind === 'idle_timeout') return 'Stop idle nodes';
  if (rule.kind === 'cost_cap') return 'Monthly cap';
  const word = { stop: 'Stop', start: 'Start', restart: 'Restart', terminate: 'Terminate' }[
    rule.config.action
  ];
  return `${word} on a schedule`;
}

const REACH_WORDS: Record<OnReach, string> = {
  block_routing: 'then use cloud models',
  stop_nodes: 'then stop',
  notify_only: 'then just tell me',
};

/** One plain line under the rule's title. */
export function ruleSummary(rule: Rule, names: Map<string, string>): string {
  if (rule.kind === 'idle_timeout')
    return `After ${rule.config.idle_minutes} minutes with no requests, on ${nodesWords(rule.config.node_ids, names)}`;
  if (rule.kind === 'cost_cap') {
    const amount = `$${rule.config.monthly_usd.toLocaleString('en-GB', { maximumFractionDigits: 2 })} a month`;
    if (rule.config.on_reach === 'stop_nodes')
      return `${amount}, then stop ${nodesWords(rule.config.node_ids, names)}`;
    return `${amount}, ${REACH_WORDS[rule.config.on_reach]}`;
  }
  const time = dailyTime(rule.config.cron);
  const when = time
    ? `At ${time} ${daysWords(rule.config.weekdays)}`
    : `${rule.config.cron}${rule.config.weekdays ? `, ${daysWords(rule.config.weekdays)}` : ''}`;
  return `${when} (${rule.config.tz}), on ${nodesWords(rule.config.node_ids, names)}`;
}
