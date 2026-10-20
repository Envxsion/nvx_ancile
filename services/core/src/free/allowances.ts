/**
 * ------------------------------------------------------------------
 *  Title    |  Free allowances and daily counters
 *  Ref      |  docs/decisions.md (Free first) · ROADMAP FR2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Count what has been used against each provider's free
 *           |  allowance (Workers AI: 10,000 neurons a day) and against
 *           |  our own daily spend caps, so a route can be left before
 *           |  the edge, never over it. Reusable by the free mode (FR2).
 *  How      |  One persistent table of named counters for the current
 *           |  UTC day (core.settings, key free.counters). An allowance
 *           |  is a definition: a limit, a ceiling we hold ourselves to
 *           |  (the margin is limit minus ceiling), and the day it
 *           |  resets. canSpend() asks before a call, record() counts
 *           |  after it, exhaust() applies a provider saying "no more".
 *  Note     |  Resets are UTC midnight (Cloudflare: 00:00 UTC, which is
 *           |  11 am AEDT). A counter from an earlier day is dropped on
 *           |  the next read, so a restart never carries a spent day
 *           |  over. Writes are queued so two calls cannot lose a count.
 * ------------------------------------------------------------------
 */

import type { SettingsStore } from '../settings';

export const COUNTERS_SETTING = 'free.counters';

export interface AllowanceDef {
  id: string;
  label: string;
  unit: string;
  /** What the provider gives free each day. */
  limit: number;
  /** The most we count before switching away: the limit less a small margin. */
  defaultCeiling: number;
  /** Where the figure comes from (checked 2026-10-20). */
  source: string;
}

interface Saved {
  day: string;
  used: Record<string, number>;
}

/** The UTC day, `2026-10-20`. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The next 00:00 UTC after `ms`. */
export const nextUtcMidnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};

export class Counters {
  private state: Saved | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: SettingsStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<Saved> {
    const today = utcDay(this.now());
    if (!this.state) {
      const saved = await this.settings.get<Saved>(COUNTERS_SETTING);
      this.state =
        saved && typeof saved.day === 'string'
          ? { day: saved.day, used: { ...saved.used } }
          : { day: today, used: {} };
    }
    if (this.state.day !== today) this.state = { day: today, used: {} };
    return this.state;
  }

  async get(key: string): Promise<number> {
    return (await this.load()).used[key] ?? 0;
  }

  /** Add to a counter (never below zero). */
  add(key: string, amount: number): Promise<number> {
    const run = async () => {
      const s = await this.load();
      s.used[key] = Math.max(0, (s.used[key] ?? 0) + amount);
      await this.settings.set(COUNTERS_SETTING, s);
      return s.used[key] as number;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Raise a counter to at least `value`: the provider said the allowance is gone. */
  raiseTo(key: string, value: number): Promise<void> {
    const run = async () => {
      const s = await this.load();
      if ((s.used[key] ?? 0) < value) {
        s.used[key] = value;
        await this.settings.set(COUNTERS_SETTING, s);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined).then(() => undefined);
    return next;
  }
}

export class Allowances {
  constructor(
    private readonly counters: Counters,
    private readonly defs: readonly AllowanceDef[],
    private readonly now: () => number = Date.now,
  ) {}

  def(id: string): AllowanceDef | undefined {
    return this.defs.find((d) => d.id === id);
  }

  /** The ceiling in force: a person's own, never above the provider's limit. */
  ceiling(id: string, ceilings: Record<string, number> = {}): number {
    const d = this.def(id);
    if (!d) return 0;
    return Math.min(d.limit, ceilings[id] ?? d.defaultCeiling);
  }

  async used(id: string): Promise<number> {
    return this.counters.get(`allowance:${id}`);
  }

  /** Would `amount` more stay at or under the ceiling? */
  async canSpend(id: string, amount: number, ceilings?: Record<string, number>): Promise<boolean> {
    return (await this.used(id)) + amount <= this.ceiling(id, ceilings);
  }

  /** Fraction left to the ceiling, 0 to 1; for rotating among providers. */
  async remainingFraction(id: string, ceilings?: Record<string, number>): Promise<number> {
    const c = this.ceiling(id, ceilings);
    return c <= 0 ? 0 : Math.max(0, (c - (await this.used(id))) / c);
  }

  async record(id: string, amount: number): Promise<void> {
    await this.counters.add(`allowance:${id}`, amount);
  }

  /** The provider says it is used up: stop counting on it until the reset. */
  async exhaust(id: string): Promise<void> {
    const d = this.def(id);
    if (d) await this.counters.raiseTo(`allowance:${id}`, d.limit);
  }

  async meters(ceilings?: Record<string, number>) {
    const resets = nextUtcMidnight(this.now());
    return Promise.all(
      this.defs.map(async (d) => ({
        id: d.id,
        label: d.label,
        unit: d.unit,
        used: Math.round(await this.used(d.id)),
        limit: d.limit,
        ceiling: this.ceiling(d.id, ceilings),
        resets_at: resets,
        source: d.source,
      })),
    );
  }
}
