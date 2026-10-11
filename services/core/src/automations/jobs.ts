/**
 * ------------------------------------------------------------------
 *  Title    |  Scheduled jobs
 *  Ref      |  config/automations.yaml · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What each built-in scheduled automation does, which of
 *           |  its settings can be changed from Admin, and what it
 *           |  needs before it can run at all. Each returns what it
 *           |  did in a sentence, for the Automations page.
 *  Note     |  An option listed here must be read by its handler:
 *           |  Admin never offers a setting that does nothing.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AutomationOption } from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { KnowledgeClient } from '../knowledge/client';
import type { ObsStore } from '../obs/store';
import type { JobHandler, SetupNeeded } from './runner';

const run = promisify(execFile);
const DAY = 86_400_000;

interface Retention {
  logsDays: number;
  spansDays: number;
  runEventsDays: number;
}

/** A whole number from a job's config within [min, max], or the fallback. */
export function intOption(v: unknown, fallback: number, min = 1, max = 3650): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

/** The settings of the built-in jobs that Admin can change. */
export function builtinOptions(retention: Retention): Record<string, AutomationOption[]> {
  const keep = (key: string, label: string, def: number): AutomationOption => ({
    key,
    label,
    hint: null,
    type: 'integer',
    min: 1,
    max: 3650,
    unit: 'days',
    default: def,
  });
  return {
    cleanup: [
      keep('logs_days', 'Keep log lines for', retention.logsDays),
      keep('spans_days', 'Keep traces for', retention.spansDays),
      keep('run_events_days', 'Keep run events for', retention.runEventsDays),
    ],
    stale_sources: [
      {
        key: 'force',
        label: 'Check every link each time',
        hint: 'Off: only the links that are due a check.',
        type: 'boolean',
        min: null,
        max: null,
        unit: null,
        default: false,
      },
    ],
  };
}

/** Built-in jobs that cannot run until something is configured, and what to do. */
export function jobSetup(deps: {
  memoryRemote?: string | undefined | (() => string | undefined);
}): Record<string, () => SetupNeeded | null> {
  const remote = () => (typeof deps.memoryRemote === 'function' ? deps.memoryRemote() : deps.memoryRemote);
  return {
    memory_backup: () =>
      remote()
        ? null
        : {
            title: 'Not set up',
            hint: 'Add a git remote for your memory in Settings → API keys (or ANCILE_MEMORY_REMOTE).',
          },
  };
}

export function scheduledJobs(deps: {
  sql?: Sql;
  obs: ObsStore;
  kn?: KnowledgeClient;
  memoryDir: string;
  /** The backup remote: ANCILE_MEMORY_REMOTE, or the one saved in Settings → API keys. */
  memoryRemote?: string | undefined | (() => Promise<string | undefined>);
  retention: Retention;
}): Record<string, JobHandler> {
  return {
    cleanup: async (config) => {
      const now = Date.now();
      const logsDays = intOption(config.logs_days, deps.retention.logsDays);
      const spansDays = intOption(config.spans_days, deps.retention.spansDays);
      const runEventsDays = intOption(config.run_events_days, deps.retention.runEventsDays);
      const pruned = await deps.obs.prune({
        logsBefore: new Date(now - logsDays * DAY),
        spansBefore: new Date(now - spansDays * DAY),
      });
      let events = 0;
      if (deps.sql) {
        const cutoff = new Date(now - runEventsDays * DAY);
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
      // jobSetup() keeps this from running without a remote; this is the backstop.
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

    stale_sources: async (config) => {
      if (!deps.kn) return { status: 'skipped', detail: 'The Knowledge service is not connected.' };
      const r = await deps.kn.post<Record<string, unknown>>('/maintenance/stale-check', {
        force: config.force === true,
      });
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
