/**
 * ------------------------------------------------------------------
 *  Title    |  The plan's monthly API credit
 *  Ref      |  docs/models.md (Monthly API credit) · roadmap CR1
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A Max or Team plan includes a monthly API credit in one
 *           |  Claude Console organisation. An Anthropic key from it
 *           |  spends the credit. This counts this cycle's spend so the
 *           |  Cockpit can show a meter, warns at 80%, and learns when
 *           |  Anthropic says it is gone.
 *  How      |  The cycle runs from `resets_on_day` (clamped to the end of
 *           |  a short month) at local midnight in the person's time
 *           |  zone. Spend is the sum of billed_usd (else cost_usd) of
 *           |  answers whose recorded billing is `credit`, read from the
 *           |  messages, so a receipt and the meter always agree.
 *  Note     |  This is Ancile's own count. Anthropic's balance needs an
 *           |  Admin key, which Ancile never asks for. Spend made with the
 *           |  same key elsewhere is not seen.
 * ------------------------------------------------------------------
 */

import {
  type CreditRouting,
  type CreditStatus,
  DEFAULT_CREDIT_ROUTING,
  type PlanCredit,
} from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { SettingsStore } from '../settings';
import { localMidnight, parts, validZone } from '../usage/report';

export const CREDIT_SETTING = {
  config: 'credit.config',
  routing: 'credit.routing',
  /** The cycle start (ISO) the 80% warning was sent for. */
  warned: 'credit.warned',
  /** The cycle start (ISO) Anthropic said the credit ran out in. */
  exhausted: 'credit.exhausted',
} as const;

/** The share of the credit at which a notification warns. */
export const WARN_AT = 0.8;
const DAY_MS = 86_400_000;

/** The last day of a month (month is 1 to 12). */
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The instant of local midnight on the reset day of a month, the day clamped to a short month. */
function resetAt(tz: string, y: number, m: number, day: number): number {
  return localMidnight(tz, y, m, Math.min(day, daysIn(y, m)));
}

/** The cycle that holds `now`: [start, end), both local midnights on a reset day. */
export function cycleOf(now: number, resetsOnDay: number, tz: string): { start: number; end: number } {
  const p = parts(tz, now);
  let y = p.y;
  let m = p.m;
  if (now < resetAt(tz, y, m, resetsOnDay)) {
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  const start = resetAt(tz, y, m, resetsOnDay);
  let ny = y;
  let nm = m + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  return { start, end: resetAt(tz, ny, nm, resetsOnDay) };
}

/** What a cycle has spent from the credit. */
export interface CreditSpendSource {
  spentUsd(from: Date, to: Date): Promise<number>;
}

export class PgCreditSpend implements CreditSpendSource {
  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
  ) {}

  async spentUsd(from: Date, to: Date): Promise<number> {
    const rows = await this.sql<{ spent: string | number | null }[]>`
      select coalesce(sum(coalesce((m.usage->>'billed_usd')::numeric, (m.usage->>'cost_usd')::numeric, 0)), 0) as spent
      from core.messages m
      join core.threads t on t.id = m.thread_id
      where m.usage->'billing'->>'kind' = 'credit'
        and m.created_at >= ${from}
        and m.created_at < ${to}
        and t.workspace_id = ${this.workspaceId}`;
    return Number(rows[0]?.spent ?? 0);
  }
}

export interface CreditLedgerDeps {
  settings: SettingsStore;
  spend: CreditSpendSource;
  /** The state models and routing need, handed over whenever it may have changed. */
  onState?: (s: { enabled: boolean; exhausted: boolean; first: boolean }) => void;
  /** Tell the person (a notification on the bus). */
  notify?: (n: { id: string; level: 'warn' | 'info'; title: string; body: string }) => void | Promise<void>;
  now?: () => number;
  /** This computer's zone, when the person's was not saved. */
  defaultTz?: () => string;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export class CreditLedger {
  private config: PlanCredit | null = null;
  private routing: CreditRouting = DEFAULT_CREDIT_ROUTING;
  private loaded = false;
  private first = false;
  private readonly now: () => number;

  constructor(private readonly deps: CreditLedgerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Read what is saved. Cheap; call after a change. */
  async load(): Promise<void> {
    this.config = (await this.deps.settings.get<PlanCredit>(CREDIT_SETTING.config)) ?? null;
    this.routing = {
      ...DEFAULT_CREDIT_ROUTING,
      ...((await this.deps.settings.get<CreditRouting>(CREDIT_SETTING.routing)) ?? {}),
    };
    this.loaded = true;
    await this.refreshGoal();
  }

  /** The credit as saved; null when never set up. Synchronous after load(). */
  current(): PlanCredit | null {
    return this.config;
  }

  get enabled(): boolean {
    return this.config?.enabled === true;
  }

  routingGoal(): CreditRouting {
    return this.routing;
  }

  async setConfig(next: PlanCredit | null): Promise<void> {
    await this.deps.settings.set(CREDIT_SETTING.config, next);
    // Saving again is the person saying the credit is there (bought credit, a new cycle): try it again.
    await this.deps.settings.set(CREDIT_SETTING.exhausted, null);
    this.config = next;
    this.loaded = true;
    await this.refreshGoal();
  }

  async setRouting(next: CreditRouting): Promise<void> {
    await this.deps.settings.set(CREDIT_SETTING.routing, next);
    this.routing = next;
    await this.refreshGoal();
  }

  private tz(): string {
    return (
      validZone(this.config?.tz) ??
      validZone(this.deps.defaultTz?.()) ??
      validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
      'UTC'
    );
  }

  /** This cycle's spend and what is left, as Ancile counts it. Null when the credit is not set up. */
  async status(): Promise<CreditStatus | null> {
    if (!this.loaded) await this.load();
    const c = this.config;
    if (!c) return null;
    const now = this.now();
    const tz = this.tz();
    const cyc = cycleOf(now, c.resets_on_day, tz);
    const spent = this.deps.spend
      ? await this.deps.spend.spentUsd(new Date(cyc.start), new Date(cyc.end))
      : 0;
    const startIso = new Date(cyc.start).toISOString();
    const told = (await this.deps.settings.get<string>(CREDIT_SETTING.exhausted)) === startIso;
    const left = Math.max(0, c.monthly_usd - spent);
    return {
      enabled: c.enabled,
      monthly_usd: c.monthly_usd,
      spent_usd: round(spent),
      left_usd: round(left),
      used: round(c.monthly_usd > 0 ? spent / c.monthly_usd : 0),
      cycle_start: startIso,
      cycle_ends: new Date(cyc.end).toISOString(),
      days_left: Math.max(0, Math.ceil((cyc.end - now) / DAY_MS)),
      // Only Anthropic's own refusal marks it spent: Ancile's count can run behind bought credit.
      exhausted: told,
      counted_by_ancile: true,
      tz,
    };
  }

  /** Anthropic refused a call for lack of credit: the credit is gone until the cycle ends. */
  async markExhausted(): Promise<void> {
    const s = await this.status();
    if (!s) return;
    const told = (await this.deps.settings.get<string>(CREDIT_SETTING.exhausted)) === s.cycle_start;
    await this.deps.settings.set(CREDIT_SETTING.exhausted, s.cycle_start);
    await this.refreshGoal();
    if (told) return;
    await this.deps.notify?.({
      id: `ntf_credit_out_${s.cycle_start}`,
      level: 'warn',
      title: "Your plan's monthly API credit is used up",
      body: `Anthropic stopped answering on it. Models paid from it are skipped until ${s.cycle_ends.slice(0, 10)}.`,
    });
  }

  /** Warn once a cycle when 80% is spent. Returns whether a warning went out. */
  async check(): Promise<boolean> {
    const s = await this.status();
    if (!s?.enabled || s.used < WARN_AT) return false;
    if ((await this.deps.settings.get<string>(CREDIT_SETTING.warned)) === s.cycle_start) return false;
    await this.deps.settings.set(CREDIT_SETTING.warned, s.cycle_start);
    await this.deps.notify?.({
      id: `ntf_credit_warn_${s.cycle_start}`,
      level: 'warn',
      title: `${Math.round(s.used * 100)}% of your monthly API credit is used`,
      body: `About $${s.left_usd.toFixed(2)} is left until ${s.cycle_ends.slice(0, 10)}. This is Ancile's own count.`,
    });
    return true;
  }

  /**
   * RT1: should models paid from the credit go first now? On, in the last
   * `last_days` of the cycle, with credit left. Worked out here and kept for
   * spendFirst(), which routing asks synchronously.
   */
  async refreshGoal(): Promise<boolean> {
    if (!this.loaded) await this.load();
    const s = await this.status();
    this.first =
      this.routing.spend_credit_first &&
      !!s?.enabled &&
      !s.exhausted &&
      s.left_usd > 0 &&
      s.days_left <= this.routing.last_days;
    this.deps.onState?.({ enabled: !!s?.enabled, exhausted: !!s?.exhausted, first: this.first });
    return this.first;
  }

  /** The answer refreshGoal() last found. */
  spendFirst(): boolean {
    return this.first;
  }
}
