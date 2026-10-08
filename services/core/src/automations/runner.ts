/**
 * ------------------------------------------------------------------
 *  Title    |  Automations runner
 *  Ref      |  DESIGN.md §13.6, config/automations.yaml · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The quiet work on a schedule (clean-up, memory backup,
 *           |  stale-source checks, model statistics), with a record a
 *           |  person can read: last run, how long, what went wrong,
 *           |  when next. Run now and switch off from Admin.
 *  How      |  config/automations.yaml lists the jobs; core.automations
 *           |  keeps their state (your on/off wins over the file). A
 *           |  tick every 30 s runs whatever is due, one job at a time,
 *           |  each under a lease row update so two Cores never run the
 *           |  same job twice. Jobs without a schedule are event-driven
 *           |  (after a turn, on ingest): listed so you can see them,
 *           |  run by the features they serve.
 * ------------------------------------------------------------------
 */

import type { AutomationView } from '@nvx/contracts';
import type { Sql } from 'postgres';
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
  detail?: string;
}

export type JobHandler = (config: Record<string, unknown>, signal: AbortSignal) => Promise<JobResult>;

export interface AutomationRow {
  id: string;
  kind: string;
  cron: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  last_status: AutomationView['last_status'];
  last_error: string | null;
  last_duration_ms: number | null;
  next_run_at: string | null;
  runs: number;
}

export interface AutomationStore {
  /** Make sure each job has a row; existing on/off choices are kept. */
  ensure(
    jobs: { id: string; cron: string | null; config: Record<string, unknown>; enabled: boolean }[],
  ): Promise<void>;
  list(): Promise<AutomationRow[]>;
  /** Claim a due job: true only for the one caller that moved its next run on. */
  claim(id: string, dueAt: string | null, next: string | null): Promise<boolean>;
  patch(id: string, p: Partial<AutomationRow>): Promise<void>;
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
    description: 'Pushes your memory files to the remote in ANCILE_MEMORY_REMOTE, when one is set.',
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

export class AutomationRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    private readonly jobs: Record<string, JobSpec>,
    private readonly handlers: Record<string, JobHandler>,
    private readonly store: AutomationStore,
    private readonly now: () => Date = () => new Date(),
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
      log.warn({ err, cron }, 'a cron schedule in automations.yaml could not be read');
      return null;
    }
  }

  async views(): Promise<AutomationView[]> {
    const rows = await this.store.list();
    return rows
      .filter((r) => r.id in this.jobs)
      .map((r) => ({
        id: r.id,
        title: CATALOGUE[r.id]?.title ?? r.id.replace(/_/g, ' '),
        description: CATALOGUE[r.id]?.description ?? '',
        trigger: r.cron ? ('schedule' as const) : ('event' as const),
        cron: r.cron,
        schedule_words: r.cron ? cronWords(r.cron) : null,
        enabled: r.enabled,
        last_run_at: r.last_run_at,
        last_status: this.running.has(r.id) ? 'running' : r.last_status,
        last_error: r.last_error,
        last_duration_ms: r.last_duration_ms,
        next_run_at: r.enabled ? r.next_run_at : null,
        runs: r.runs,
      }))
      .sort((a, b) =>
        a.trigger === b.trigger ? a.title.localeCompare(b.title) : a.trigger === 'schedule' ? -1 : 1,
      );
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const row = (await this.store.list()).find((r) => r.id === id);
    if (!row) return false;
    await this.store.patch(id, {
      enabled,
      next_run_at: enabled && row.cron ? this.nextFor(row.cron) : row.next_run_at,
    });
    return true;
  }

  /** Run every due job once. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const row of await this.store.list()) {
      if (!row.enabled || !row.cron || !row.next_run_at || Date.parse(row.next_run_at) > now.getTime())
        continue;
      const next = this.nextFor(row.cron, now);
      if (!(await this.store.claim(row.id, row.next_run_at, next))) continue;
      await this.execute(row);
    }
  }

  /** Run one job now (Admin's Run now); scheduled or not, unless it is already running. */
  async runNow(id: string): Promise<AutomationRow['last_status'] | 'unknown' | 'busy'> {
    const row = (await this.store.list()).find((r) => r.id === id);
    if (!row) return 'unknown';
    if (this.running.has(id)) return 'busy';
    return this.execute(row);
  }

  private async execute(row: AutomationRow): Promise<AutomationRow['last_status']> {
    const handler = this.handlers[row.id];
    const started = performance.now();
    this.running.add(row.id);
    try {
      const result: JobResult = handler
        ? await withSpan(`automation ${row.id}`, 'internal', { automation: row.id }, () =>
            handler(row.config, AbortSignal.timeout(10 * 60_000)),
          )
        : { status: 'skipped', detail: 'Runs on events, not on a schedule.' };
      const ms = Math.round(performance.now() - started);
      await this.store.patch(row.id, {
        last_run_at: this.now().toISOString(),
        last_status: result.status,
        last_error: result.status === 'skipped' ? (result.detail ?? null) : null,
        last_duration_ms: ms,
        runs: row.runs + 1,
      });
      log.info(
        { automation: row.id, status: result.status, ms, detail: result.detail },
        `automation ${row.id} ${result.status}`,
      );
      return result.status;
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      await this.store.patch(row.id, {
        last_run_at: this.now().toISOString(),
        last_status: 'failed',
        last_error: message,
        last_duration_ms: ms,
        runs: row.runs + 1,
      });
      log.error({ err, automation: row.id }, `automation ${row.id} failed`);
      return 'failed';
    } finally {
      this.running.delete(row.id);
    }
  }
}

/* ---- Stores ------------------------------------------------------------------- */

export class MemoryAutomationStore implements AutomationStore {
  rows = new Map<string, AutomationRow>();
  async ensure(
    jobs: { id: string; cron: string | null; config: Record<string, unknown>; enabled: boolean }[],
  ) {
    for (const j of jobs) {
      const prev = this.rows.get(j.id);
      this.rows.set(j.id, {
        id: j.id,
        kind: j.id,
        cron: j.cron,
        config: j.config,
        enabled: prev?.enabled ?? j.enabled,
        last_run_at: prev?.last_run_at ?? null,
        last_status: prev?.last_status ?? null,
        last_error: prev?.last_error ?? null,
        last_duration_ms: prev?.last_duration_ms ?? null,
        next_run_at: prev && prev.cron === j.cron ? prev.next_run_at : null,
        runs: prev?.runs ?? 0,
      });
    }
  }
  async list() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async claim(id: string, dueAt: string | null, next: string | null) {
    const r = this.rows.get(id);
    if (!r || r.next_run_at !== dueAt) return false;
    r.next_run_at = next;
    return true;
  }
  async patch(id: string, p: Partial<AutomationRow>) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, p);
  }
}

interface Row {
  id: string;
  kind: string;
  cron: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: { message?: string } | null;
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
      // A changed schedule needs a fresh next run; the person's on/off is kept.
      await this.sql`
        insert into core.automations (id, kind, cron, config, enabled)
        values (${j.id}, ${j.id}, ${j.cron}, ${this.sql.json(j.config as never)}, ${j.enabled})
        on conflict (id) do update set
          cron = excluded.cron, config = excluded.config,
          next_run_at = case when core.automations.cron is distinct from excluded.cron then null
                             else core.automations.next_run_at end`;
    }
  }

  async list() {
    const rows = await this.sql<Row[]>`select * from core.automations order by id`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      cron: r.cron,
      config: r.config ?? {},
      enabled: r.enabled,
      last_run_at: r.last_run_at?.toISOString() ?? null,
      last_status: (r.last_status as AutomationRow['last_status']) ?? null,
      last_error: r.last_error?.message ?? null,
      last_duration_ms: r.last_duration_ms,
      next_run_at: r.next_run_at?.toISOString() ?? null,
      runs: r.runs ?? 0,
    }));
  }

  async claim(id: string, dueAt: string | null, next: string | null) {
    const res = await this.sql`
      update core.automations set next_run_at = ${next}
      where id = ${id} and next_run_at is not distinct from ${dueAt}`;
    return res.count === 1;
  }

  async patch(id: string, p: Partial<AutomationRow>) {
    const sql = this.sql;
    const sets = [];
    if (p.enabled !== undefined) sets.push(sql`enabled = ${p.enabled}`);
    if (p.next_run_at !== undefined) sets.push(sql`next_run_at = ${p.next_run_at}`);
    if (p.last_run_at !== undefined) sets.push(sql`last_run_at = ${p.last_run_at}`);
    if (p.last_status !== undefined) sets.push(sql`last_status = ${p.last_status}`);
    if (p.last_error !== undefined)
      sets.push(sql`last_error = ${p.last_error === null ? null : sql.json({ message: p.last_error })}`);
    if (p.last_duration_ms !== undefined) sets.push(sql`last_duration_ms = ${p.last_duration_ms}`);
    if (p.runs !== undefined) sets.push(sql`runs = ${p.runs}`);
    if (!sets.length) return;
    const assignments = sets.reduce((a, b) => sql`${a}, ${b}`);
    await sql`update core.automations set ${assignments} where id = ${id}`;
  }
}
