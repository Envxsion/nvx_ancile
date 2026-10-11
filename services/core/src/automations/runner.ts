/**
 * ------------------------------------------------------------------
 *  Title    |  Automations runner
 *  Ref      |  DESIGN.md §13.6, config/automations.yaml · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The quiet work on a schedule (clean-up, memory backup,
 *           |  stale-source checks, model statistics) and the
 *           |  automations you make yourself, with a record a person
 *           |  can read: last run, how long, what went wrong, when
 *           |  next. Run now, edit, reset and switch off from Admin.
 *  How      |  config/automations.yaml lists the built-in jobs and is
 *           |  their default; core.automations keeps their state and
 *           |  any schedule or setting changed in Admin (customised),
 *           |  which wins over the file until Reset to default. Your
 *           |  own automations live in the same table (origin 'user')
 *           |  and run through the same tick, lease and history. A
 *           |  tick every 30 s runs whatever is due, one job at a
 *           |  time, each under a lease row update so two Cores never
 *           |  run the same job twice. A built-in that is not set up
 *           |  (memory backup with no remote) is not run at all; Admin
 *           |  says what to do. Jobs without a schedule are
 *           |  event-driven (after a turn, on ingest): listed so you
 *           |  can see them, run by the features they serve.
 * ------------------------------------------------------------------
 */

import type { AutomationOption, AutomationView, UserAutomationKind } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import { logFor } from '../obs/logger';
import { withSpan } from '../obs/spans';
import { cronWords, nextRun, parseCron } from './cron';

const log = logFor('automations');

export interface JobSpec {
  enabled: boolean;
  cron?: string | undefined;
  config: Record<string, unknown>;
}

export interface JobResult {
  status: 'succeeded' | 'skipped';
  /** What the run did, in a sentence. */
  detail?: string;
  /** Where to see it in the Cockpit (a thread, a notebook). */
  href?: string;
}

export interface JobContext {
  id: string;
  title: string;
}

export type JobHandler = (
  config: Record<string, unknown>,
  signal: AbortSignal,
  ctx: JobContext,
) => Promise<JobResult>;

/** Why a built-in job cannot run yet, and what to do about it. */
export interface SetupNeeded {
  title: string;
  hint: string;
}

export interface RunnerExtras {
  /** Handlers for your own automations, by kind. */
  userHandlers?: Partial<Record<UserAutomationKind, JobHandler>>;
  /** Built-in jobs that may need setting up first: null when ready. */
  setup?: Record<string, () => SetupNeeded | null>;
  /** The settings of each built-in job that can be changed from Admin. */
  options?: Record<string, AutomationOption[]>;
}

export interface AutomationRow {
  id: string;
  kind: string;
  origin: 'builtin' | 'user';
  title: string | null;
  cron: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  customised: boolean;
  last_run_at: string | null;
  last_status: AutomationView['last_status'];
  last_error: string | null;
  last_detail: string | null;
  last_href: string | null;
  last_duration_ms: number | null;
  next_run_at: string | null;
  runs: number;
}

export interface NewUserAutomation {
  id: string;
  kind: UserAutomationKind;
  title: string;
  cron: string;
  config: Record<string, unknown>;
  enabled: boolean;
  next_run_at: string | null;
}

export type RowPatch = Partial<
  Pick<
    AutomationRow,
    | 'enabled'
    | 'cron'
    | 'config'
    | 'title'
    | 'customised'
    | 'next_run_at'
    | 'last_run_at'
    | 'last_status'
    | 'last_error'
    | 'last_detail'
    | 'last_href'
    | 'last_duration_ms'
    | 'runs'
  >
>;

export interface AutomationStore {
  /** Make sure each built-in job has a row; on/off choices and Admin changes are kept. */
  ensure(
    jobs: { id: string; cron: string | null; config: Record<string, unknown>; enabled: boolean }[],
  ): Promise<void>;
  list(): Promise<AutomationRow[]>;
  create(a: NewUserAutomation): Promise<void>;
  /** Your own automations only; built-ins cannot be removed. */
  remove(id: string): Promise<boolean>;
  /** Claim a due job: true only for the one caller that moved its next run on. */
  claim(id: string, dueAt: string | null, next: string | null): Promise<boolean>;
  patch(id: string, p: RowPatch): Promise<void>;
}

/** Plain-language names for the jobs in automations.yaml. */
export const CATALOGUE: Record<string, { title: string; description: string }> = {
  auto_title: {
    title: 'Name new threads',
    description: 'Gives a thread a short title after its first answer.',
  },
  auto_tag_sources: { title: 'Tag sources', description: 'Adds topic tags to a source when it is read.' },
  stale_sources: {
    title: 'Check links for changes',
    description: 'Looks again at web sources and suggests a refetch when the page changed.',
  },
  tldr: { title: 'Summarise long threads', description: 'Keeps a short summary at the top of long threads.' },
  draft_autosave: {
    title: 'Save drafts',
    description: 'Keeps what you are writing on the server as you type.',
  },
  cleanup: {
    title: 'Clean up old records',
    description: 'Drops log lines, spans and run events past their keep-for time.',
  },
  memory_backup: {
    title: 'Back up memory',
    description: 'Pushes your memory files to a git remote, when one is set.',
  },
  duplicate_sources: {
    title: 'Spot duplicate sources',
    description: 'Notices when the same document is added twice and offers to merge.',
  },
  branch_suggestions: {
    title: 'Suggest a branch',
    description: 'Offers to branch when a conversation changes topic. Never branches by itself.',
  },
  model_suggestions: {
    title: 'Suggest models',
    description: 'Learns which model does best at each kind of task.',
  },
  context_overflow_warn: {
    title: 'Watch the context window',
    description: 'Warns at 80% full and compacts at 95%, keeping the latest turns word for word.',
  },
  memory_capture: {
    title: 'Learn from corrections',
    description: 'Turns corrections and fixed failures into memory, asking first when unsure.',
  },
  model_stats_rollup: {
    title: 'Total up model statistics',
    description: 'Adds up calls, failures and speed per model for suggestions and Admin.',
  },
};

/** What each kind of your own automation does, for its card. */
export const USER_KINDS: Record<UserAutomationKind, string> = {
  ask_model: 'Asks a model and keeps the answer in a new thread.',
  run_flow: 'Sends a message through a flow and keeps the answer in a new thread.',
  recheck_sources: "Checks a notebook's web sources for changes.",
  notify: 'Sends you a reminder.',
};

const isUserKind = (k: string): k is UserAutomationKind => k in USER_KINDS;

export class AutomationRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    private readonly jobs: Record<string, JobSpec>,
    private readonly handlers: Record<string, JobHandler>,
    private readonly store: AutomationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly extras: RunnerExtras = {},
  ) {}

  async start(tickMs = 30_000): Promise<void> {
    await this.store.ensure(
      Object.entries(this.jobs).map(([id, j]) => ({
        id,
        cron: j.cron ?? null,
        config: j.config,
        enabled: j.enabled,
      })),
    );
    // Any job without a next run gets one.
    for (const row of await this.store.list()) {
      if (!row.cron || row.next_run_at) continue;
      await this.store.patch(row.id, { next_run_at: this.nextFor(row.cron) });
    }
    const loop = () => {
      this.timer = setTimeout(async () => {
        await this.tick().catch((err: unknown) => log.error({ err }, 'automation tick failed'));
        if (this.timer) loop();
      }, tickMs);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private nextFor(cron: string, after = this.now()): string | null {
    try {
      return nextRun(parseCron(cron), after)?.toISOString() ?? null;
    } catch (err) {
      log.warn({ err, cron }, 'an automation schedule could not be read');
      return null;
    }
  }

  /** Why this job cannot run yet, or null. Only built-ins need setting up. */
  setupFor(row: Pick<AutomationRow, 'id' | 'origin'>): SetupNeeded | null {
    if (row.origin !== 'builtin') return null;
    return this.extras.setup?.[row.id]?.() ?? null;
  }

  /** A built-in job's defaults from automations.yaml (undefined for your own). */
  builtin(id: string): JobSpec | undefined {
    return Object.hasOwn(this.jobs, id) ? this.jobs[id] : undefined;
  }

  private visible(r: AutomationRow): boolean {
    return r.origin === 'user' ? isUserKind(r.kind) : Object.hasOwn(this.jobs, r.id);
  }

  private toView(r: AutomationRow): AutomationView {
    const user = r.origin === 'user';
    const setup = this.setupFor(r);
    return {
      id: r.id,
      title: user ? (r.title ?? 'Automation') : (CATALOGUE[r.id]?.title ?? r.id.replace(/_/g, ' ')),
      description: user
        ? (USER_KINDS[r.kind as UserAutomationKind] ?? '')
        : (CATALOGUE[r.id]?.description ?? ''),
      origin: r.origin,
      kind: r.kind,
      trigger: r.cron ? 'schedule' : 'event',
      cron: r.cron,
      schedule_words: r.cron ? cronWords(r.cron) : null,
      default_cron: user ? null : (this.jobs[r.id]?.cron ?? null),
      customised: !user && r.customised,
      config: r.config,
      options: user ? [] : (this.extras.options?.[r.id] ?? []),
      setup,
      enabled: r.enabled,
      last_run_at: r.last_run_at,
      last_status: this.running.has(r.id) ? 'running' : r.last_status,
      last_error: r.last_error,
      last_detail: r.last_detail,
      last_href: r.last_href,
      last_duration_ms: r.last_duration_ms,
      next_run_at: r.enabled && !setup ? r.next_run_at : null,
      runs: r.runs,
    };
  }

  async views(): Promise<AutomationView[]> {
    const rows = await this.store.list();
    const order = (v: AutomationView) => (v.origin === 'user' ? 0 : v.trigger === 'schedule' ? 1 : 2);
    return rows
      .filter((r) => this.visible(r))
      .map((r) => this.toView(r))
      .sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title));
  }

  async view(id: string): Promise<AutomationView | undefined> {
    const row = await this.row(id);
    return row ? this.toView(row) : undefined;
  }

  private async row(id: string): Promise<AutomationRow | undefined> {
    return (await this.store.list()).find((r) => r.id === id && this.visible(r));
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.edit(id, { enabled });
  }

  /**
   * Change a job: on/off, schedule, settings, name. A new schedule or
   * switching on moves the next run to the schedule's next slot. The
   * caller checks what is allowed (routes.ts); this only applies it.
   */
  async edit(
    id: string,
    p: { enabled?: boolean; cron?: string; config?: Record<string, unknown>; title?: string },
  ): Promise<boolean> {
    const row = await this.row(id);
    if (!row) return false;
    const cron = p.cron ?? row.cron;
    const enabled = p.enabled ?? row.enabled;
    const rescheduled = p.cron !== undefined && p.cron !== row.cron;
    const switchedOn = p.enabled === true && !row.enabled;
    const patch: RowPatch = {};
    if (p.enabled !== undefined) patch.enabled = p.enabled;
    if (p.cron !== undefined) patch.cron = p.cron;
    if (p.config !== undefined) patch.config = p.config;
    if (p.title !== undefined && row.origin === 'user') patch.title = p.title;
    if (row.origin === 'builtin' && (p.cron !== undefined || p.config !== undefined)) {
      const spec = this.jobs[id];
      const sameCron = (p.cron ?? row.cron) === (spec?.cron ?? null);
      const sameConfig = sameJson(p.config ?? row.config, spec?.config ?? {});
      patch.customised = !(sameCron && sameConfig);
    }
    if (cron && enabled && (rescheduled || switchedOn)) patch.next_run_at = this.nextFor(cron);
    await this.store.patch(id, patch);
    return true;
  }

  /** Put a built-in job's schedule and settings back to automations.yaml. On/off is kept. */
  async reset(id: string): Promise<boolean> {
    const row = await this.row(id);
    const spec = this.jobs[id];
    if (row?.origin !== 'builtin' || !spec) return false;
    const cron = spec.cron ?? null;
    await this.store.patch(id, {
      cron,
      config: spec.config,
      customised: false,
      next_run_at: cron ? this.nextFor(cron) : null,
    });
    return true;
  }

  async create(a: {
    kind: UserAutomationKind;
    title: string;
    cron: string;
    config: Record<string, unknown>;
    enabled: boolean;
  }): Promise<AutomationView> {
    const id = `aut_${ulid()}`;
    await this.store.create({ id, ...a, next_run_at: this.nextFor(a.cron) });
    const v = await this.view(id);
    if (!v) throw new Error('the new automation was not saved');
    log.info({ automation: id, kind: a.kind }, 'automation created');
    return v;
  }

  async remove(id: string): Promise<boolean> {
    const row = await this.row(id);
    if (row?.origin !== 'user') return false;
    return this.store.remove(id);
  }

  /** Run every due job once. Jobs that are not set up wait, unrun. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const row of await this.store.list()) {
      if (!this.visible(row)) continue;
      if (!row.enabled || !row.cron || !row.next_run_at || Date.parse(row.next_run_at) > now.getTime())
        continue;
      if (this.setupFor(row)) continue;
      const next = this.nextFor(row.cron, now);
      if (!(await this.store.claim(row.id, row.next_run_at, next))) continue;
      await this.execute(row);
    }
  }

  /** Run one job now (Admin's Run now); scheduled or not, unless it is running or not set up. */
  async runNow(id: string): Promise<AutomationRow['last_status'] | 'unknown' | 'busy' | 'not_set_up'> {
    const row = await this.row(id);
    if (!row) return 'unknown';
    if (this.running.has(id)) return 'busy';
    if (this.setupFor(row)) return 'not_set_up';
    return this.execute(row);
  }

  private handlerFor(row: AutomationRow): JobHandler | undefined {
    if (row.origin === 'user') return isUserKind(row.kind) ? this.extras.userHandlers?.[row.kind] : undefined;
    return this.handlers[row.id];
  }

  private async execute(row: AutomationRow): Promise<AutomationRow['last_status']> {
    const handler = this.handlerFor(row);
    const started = performance.now();
    const title = row.title ?? CATALOGUE[row.id]?.title ?? row.id;
    this.running.add(row.id);
    try {
      const result: JobResult = handler
        ? await withSpan(`automation ${row.kind}`, 'internal', { automation: row.id }, () =>
            handler(row.config, AbortSignal.timeout(10 * 60_000), { id: row.id, title }),
          )
        : {
            status: 'skipped',
            detail:
              row.origin === 'user'
                ? 'This kind of automation is not available here.'
                : 'Runs on events, not on a schedule.',
          };
      const ms = Math.round(performance.now() - started);
      await this.store.patch(row.id, {
        last_run_at: this.now().toISOString(),
        last_status: result.status,
        last_error: result.status === 'skipped' ? (result.detail ?? null) : null,
        last_detail: result.detail ?? null,
        last_href: result.href ?? null,
        last_duration_ms: ms,
        runs: row.runs + 1,
      });
      // The detail can quote a prompt or a title you wrote; the log keeps only what ran.
      log.info(
        { automation: row.id, kind: row.kind, status: result.status, ms },
        `automation ${row.kind} ${result.status}`,
      );
      return result.status;
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      await this.store.patch(row.id, {
        last_run_at: this.now().toISOString(),
        last_status: 'failed',
        last_error: message,
        last_detail: null,
        last_href: null,
        last_duration_ms: ms,
        runs: row.runs + 1,
      });
      log.error({ err, automation: row.id, kind: row.kind }, `automation ${row.kind} failed`);
      return 'failed';
    } finally {
      this.running.delete(row.id);
    }
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([k, x]) => [k, norm(x)]),
        )
      : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/* ---- Stores ------------------------------------------------------------------- */

const blank = {
  last_run_at: null,
  last_status: null,
  last_error: null,
  last_detail: null,
  last_href: null,
  last_duration_ms: null,
  runs: 0,
} as const;

export class MemoryAutomationStore implements AutomationStore {
  rows = new Map<string, AutomationRow>();
  async ensure(
    jobs: { id: string; cron: string | null; config: Record<string, unknown>; enabled: boolean }[],
  ) {
    for (const j of jobs) {
      const prev = this.rows.get(j.id);
      const keep = prev?.customised === true;
      const cron = keep ? (prev?.cron ?? null) : j.cron;
      this.rows.set(j.id, {
        ...blank,
        ...prev,
        id: j.id,
        kind: j.id,
        origin: 'builtin',
        title: null,
        cron,
        config: keep ? (prev?.config ?? {}) : j.config,
        enabled: prev?.enabled ?? j.enabled,
        customised: keep,
        next_run_at: prev && prev.cron === cron ? prev.next_run_at : null,
      });
    }
  }
  async list() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async create(a: NewUserAutomation) {
    this.rows.set(a.id, { ...blank, ...a, origin: 'user', customised: false });
  }
  async remove(id: string) {
    const r = this.rows.get(id);
    if (r?.origin !== 'user') return false;
    return this.rows.delete(id);
  }
  async claim(id: string, dueAt: string | null, next: string | null) {
    const r = this.rows.get(id);
    if (!r || r.next_run_at !== dueAt) return false;
    r.next_run_at = next;
    return true;
  }
  async patch(id: string, p: RowPatch) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, p);
  }
}

interface Row {
  id: string;
  kind: string;
  origin: string | null;
  title: string | null;
  cron: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  customised: boolean | null;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: { message?: string } | null;
  last_detail: string | null;
  last_href: string | null;
  last_duration_ms: number | null;
  next_run_at: Date | null;
  runs: number;
}

export class PgAutomationStore implements AutomationStore {
  constructor(private readonly sql: Sql) {}

  async ensure(
    jobs: { id: string; cron: string | null; config: Record<string, unknown>; enabled: boolean }[],
  ) {
    for (const j of jobs) {
      // The file is the default: a schedule or setting changed in Admin is kept
      // (customised). A changed schedule needs a fresh next run; on/off is kept.
      await this.sql`
        insert into core.automations (id, kind, origin, cron, config, enabled)
        values (${j.id}, ${j.id}, 'builtin', ${j.cron}, ${this.sql.json(j.config as never)}, ${j.enabled})
        on conflict (id) do update set
          cron = case when core.automations.customised then core.automations.cron else excluded.cron end,
          config = case when core.automations.customised then core.automations.config else excluded.config end,
          next_run_at = case
            when not core.automations.customised and core.automations.cron is distinct from excluded.cron then null
            else core.automations.next_run_at end
        where core.automations.origin = 'builtin'`;
    }
  }

  async list() {
    const rows = await this.sql<Row[]>`select * from core.automations order by created_at, id`;
    return rows.map(
      (r): AutomationRow => ({
        id: r.id,
        kind: r.kind,
        origin: r.origin === 'user' ? 'user' : 'builtin',
        title: r.title ?? null,
        cron: r.cron,
        config: r.config ?? {},
        enabled: r.enabled,
        customised: r.customised === true,
        last_run_at: r.last_run_at?.toISOString() ?? null,
        last_status: (r.last_status as AutomationRow['last_status']) ?? null,
        last_error: r.last_error?.message ?? null,
        last_detail: r.last_detail ?? null,
        last_href: r.last_href ?? null,
        last_duration_ms: r.last_duration_ms,
        next_run_at: r.next_run_at?.toISOString() ?? null,
        runs: r.runs ?? 0,
      }),
    );
  }

  async create(a: NewUserAutomation) {
    await this.sql`
      insert into core.automations (id, kind, origin, title, cron, config, enabled, next_run_at)
      values (${a.id}, ${a.kind}, 'user', ${a.title}, ${a.cron}, ${this.sql.json(a.config as never)},
              ${a.enabled}, ${a.next_run_at})`;
  }

  async remove(id: string) {
    const res = await this.sql`delete from core.automations where id = ${id} and origin = 'user'`;
    return res.count === 1;
  }

  async claim(id: string, dueAt: string | null, next: string | null) {
    const res = await this.sql`
      update core.automations set next_run_at = ${next}
      where id = ${id} and next_run_at is not distinct from ${dueAt}`;
    return res.count === 1;
  }

  async patch(id: string, p: RowPatch) {
    const sql = this.sql;
    const sets = [];
    if (p.enabled !== undefined) sets.push(sql`enabled = ${p.enabled}`);
    if (p.cron !== undefined) sets.push(sql`cron = ${p.cron}`);
    if (p.config !== undefined) sets.push(sql`config = ${sql.json(p.config as never)}`);
    if (p.title !== undefined) sets.push(sql`title = ${p.title}`);
    if (p.customised !== undefined) sets.push(sql`customised = ${p.customised}`);
    if (p.next_run_at !== undefined) sets.push(sql`next_run_at = ${p.next_run_at}`);
    if (p.last_run_at !== undefined) sets.push(sql`last_run_at = ${p.last_run_at}`);
    if (p.last_status !== undefined) sets.push(sql`last_status = ${p.last_status}`);
    if (p.last_error !== undefined)
      sets.push(sql`last_error = ${p.last_error === null ? null : sql.json({ message: p.last_error })}`);
    if (p.last_detail !== undefined) sets.push(sql`last_detail = ${p.last_detail}`);
    if (p.last_href !== undefined) sets.push(sql`last_href = ${p.last_href}`);
    if (p.last_duration_ms !== undefined) sets.push(sql`last_duration_ms = ${p.last_duration_ms}`);
    if (p.runs !== undefined) sets.push(sql`runs = ${p.runs}`);
    if (!sets.length) return;
    const assignments = sets.reduce((a, b) => sql`${a}, ${b}`);
    await sql`update core.automations set ${assignments} where id = ${id}`;
  }
}
