/**
 * ------------------------------------------------------------------
 *  Title    |  Run progress, for the Activity panel
 *  Ref      |  docs/activity.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The step each unfinished run is on, from its own event
 *           |  log: the latest step started, fact-check progress or
 *           |  flow node started.
 *  How      |  One query over core.run_events (primary key run_id,
 *           |  seq): the latest matching event per run.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import type { RunProgress } from './service';

const STAGES: Record<string, string> = {
  extracting: 'Finding claims',
  gathering: 'Gathering evidence',
  verifying: 'Checking claims',
  done: 'Done',
  failed: 'Failed',
};

/** What one progress event says. */
export function progressOf(type: string, data: Record<string, unknown>): RunProgress | null {
  if (type === 'step.started') return { label: typeof data.label === 'string' ? data.label : null };
  if (type === 'factcheck.progress') {
    const stage = typeof data.stage === 'string' ? data.stage : '';
    return {
      label: STAGES[stage] ?? 'Checking claims',
      ...(typeof data.done === 'number' && { done: data.done }),
      ...(typeof data.total === 'number' && { total: data.total }),
    };
  }
  if (type === 'flow.node.started') {
    const label = typeof data.label === 'string' && data.label ? data.label : null;
    const kind = typeof data.kind === 'string' ? data.kind : 'node';
    return { label: label ? `Flow: ${label}` : `Flow: a ${kind} node` };
  }
  return null;
}

export function pgRunProgress(sql: Sql) {
  return async (ids: string[]): Promise<Map<string, RunProgress>> => {
    const out = new Map<string, RunProgress>();
    if (!ids.length) return out;
    const rows = await sql<{ run_id: string; type: string; data: Record<string, unknown> }[]>`
      select distinct on (run_id) run_id, type, data from core.run_events
      where run_id = any(${ids}::text[])
        and type in ('step.started', 'factcheck.progress', 'flow.node.started')
      order by run_id, seq desc`;
    for (const r of rows) {
      const p = progressOf(r.type, r.data ?? {});
      if (p) out.set(r.run_id, p);
    }
    return out;
  };
}
