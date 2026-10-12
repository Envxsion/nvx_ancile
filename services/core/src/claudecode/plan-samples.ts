/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code plan-limit samples
 *  Ref      |  docs/claude-code.md (Usage) · migration 0029
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep how much of each plan window was used over time,
 *           |  so headroom can be shown as a trend (Insights, Pro),
 *           |  not only as the figure right now.
 *  How      |  PlanLimits hands over every window it saves. A sample
 *           |  is kept when its share changed, or an hour after the
 *           |  last one kept for that window (a flat line still has
 *           |  points). core.plan_limit_samples in Postgres; memory in
 *           |  tests. A failed write is logged and dropped: the figure
 *           |  on screen never waits for history.
 *  Note     |  Window, share and reset time only: no account, no
 *           |  content, nothing that leaves this computer.
 * ------------------------------------------------------------------
 */

import type { PlanWindow } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { logFor } from '../obs/logger';

const log = logFor('claude-code-limits');

/** A flat window still gets a point this often. */
export const SAMPLE_EVERY_MS = 60 * 60_000;

export interface PlanSample {
  window_id: string;
  kind: PlanWindow['kind'];
  label: string | null;
  percent: number;
  resets_at: string | null;
  at: string;
}

export interface PlanSampleStore {
  insert(rows: PlanSample[]): Promise<void>;
}

export class MemoryPlanSampleStore implements PlanSampleStore {
  readonly rows: PlanSample[] = [];
  async insert(rows: PlanSample[]) {
    this.rows.push(...rows);
  }
}

export class PgPlanSampleStore implements PlanSampleStore {
  constructor(private readonly sql: Sql) {}
  async insert(rows: PlanSample[]) {
    for (const r of rows)
      await this.sql`
        insert into core.plan_limit_samples (window_id, kind, label, percent, resets_at, at)
        values (${r.window_id}, ${r.kind}, ${r.label}, ${r.percent}, ${r.resets_at}, ${r.at})`;
  }
}

export class PlanSamples {
  private readonly last = new Map<string, { percent: number; at: number }>();

  constructor(private readonly store: PlanSampleStore) {}

  /** Keep what changed (or has not been kept for an hour). Never throws. */
  async record(windows: PlanWindow[], at: string): Promise<void> {
    const now = Date.parse(at);
    const keep: PlanSample[] = [];
    for (const w of windows) {
      if (w.percent === null || !Number.isFinite(w.percent)) continue;
      const prev = this.last.get(w.id);
      if (prev && prev.percent === w.percent && now - prev.at < SAMPLE_EVERY_MS) continue;
      keep.push({
        window_id: w.id,
        kind: w.kind,
        label: w.label,
        percent: Math.min(100, Math.max(0, w.percent)),
        resets_at: w.resets_at,
        at,
      });
    }
    if (!keep.length) return;
    try {
      await this.store.insert(keep);
      for (const k of keep) this.last.set(k.window_id, { percent: k.percent, at: now });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'plan limit history not kept');
    }
  }
}
