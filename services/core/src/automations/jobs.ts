/**
 * ------------------------------------------------------------------
 *  Title    |  Scheduled jobs
 *  Ref      |  config/automations.yaml · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What each scheduled automation does. Each returns what
 *           |  it did in a sentence, for the Automations page.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import type { KnowledgeClient } from '../knowledge/client';
import type { ObsStore } from '../obs/store';
import type { JobHandler } from './runner';

const run = promisify(execFile);
const DAY = 86_400_000;

export function scheduledJobs(deps: {
  sql?: Sql;
  obs: ObsStore;
  kn?: KnowledgeClient;
  memoryDir: string;
  /** The backup remote: ANCILE_MEMORY_REMOTE, or the one saved in Settings → API keys. */
  memoryRemote?: string | undefined | (() => Promise<string | undefined>);
  retention: { logsDays: number; spansDays: number; runEventsDays: number };
}): Record<string, JobHandler> {
  return {
    cleanup: async () => {
      const now = Date.now();
      const pruned = await deps.obs.prune({
        logsBefore: new Date(now - deps.retention.logsDays * DAY),
        spansBefore: new Date(now - deps.retention.spansDays * DAY),
      });
      let events = 0;
      if (deps.sql) {
        const cutoff = new Date(now - deps.retention.runEventsDays * DAY);
        const res = await deps.sql`
          delete from core.run_events e using core.runs r
          where e.run_id = r.id and r.status in ('succeeded', 'failed', 'cancelled') and r.updated_at < ${cutoff}`;
        events = res.count;
      }
      return {
        status: 'succeeded',
        detail: `Removed ${pruned.logs} log lines, ${pruned.spans} spans and ${events} run events.`,
      };
    },

    memory_backup: async () => {
      const remote = typeof deps.memoryRemote === 'function' ? await deps.memoryRemote() : deps.memoryRemote;
      if (!remote)
        return {
          status: 'skipped',
          detail: 'No remote is set (Settings → API keys, or ANCILE_MEMORY_REMOTE).',
        };
      if (!existsSync(join(deps.memoryDir, '.git')))
        return { status: 'skipped', detail: 'The memory folder has no history yet.' };
      await run('git', ['push', '--quiet', remote, 'HEAD'], {
        cwd: deps.memoryDir,
        timeout: 120_000,
      });
      return { status: 'succeeded', detail: 'Memory pushed to its remote.' };
    },

    stale_sources: async () => {
      if (!deps.kn) return { status: 'skipped', detail: 'The Knowledge service is not connected.' };
      const r = await deps.kn.post<Record<string, unknown>>('/maintenance/stale-check', {});
      const checked = typeof r.checked === 'number' ? r.checked : null;
      const stale = typeof r.stale === 'number' ? r.stale : null;
      return {
        status: 'succeeded',
        detail:
          checked !== null
            ? `Checked ${checked} ${checked === 1 ? 'link' : 'links'}${stale !== null ? `; ${stale} changed` : ''}.`
            : 'Checked the web sources.',
      };
    },

    model_stats_rollup: async () => {
      if (!deps.sql) return { status: 'skipped', detail: 'No database.' };
      // TODO(phase-6): feed model suggestions from these totals.
      const [r] = await deps.sql<{ n: string }[]>`
        select count(*)::text as n from core.messages
        where role = 'assistant' and model_id is not null and created_at > now() - interval '15 minutes'`;
      return { status: 'succeeded', detail: `${r?.n ?? 0} answers in the last 15 minutes.` };
    },
  };
}
