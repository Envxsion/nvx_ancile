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
 *  Note     |  An option listed here must be read by its handler (or,
 *           |  for an event-driven job, by the feature it serves,
 *           |  through BuiltinSettings): Admin never offers a setting
 *           |  that does nothing. A git push never prompts, and a
 *           |  remote's credentials never reach a message.
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
import { SETTING, type SettingsStore } from '../settings';
import type { JobHandler, LinkedJob, SetupNeeded } from './runner';

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

const whole = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  unit: string | null,
  hint: string | null = null,
): AutomationOption => ({ key, label, hint, type: 'integer', min, max, unit, default: def });

/**
 * The settings of the built-in jobs that Admin can change, every one read
 * where the job runs. Jobs with none (memory backup) still have a switch.
 */
export function builtinOptions(retention: Retention): Record<string, AutomationOption[]> {
  return {
    cleanup: [
      whole('logs_days', 'Keep log lines for', retention.logsDays, 1, 3650, 'days'),
      whole('spans_days', 'Keep traces for', retention.spansDays, 1, 3650, 'days'),
      whole('run_events_days', 'Keep run events for', retention.runEventsDays, 1, 3650, 'days'),
    ],
    stale_sources: [
      whole(
        'url_stale_after_days',
        'Look at a web page again after',
        7,
        1,
        365,
        'days',
        'A page that changed is marked, with Refetch to bring it in again.',
      ),
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
    auto_tag_sources: [whole('max_tags', 'Tags per source, at most', 5, 1, 20, null)],
    duplicate_sources: [
      whole(
        'near_duplicate_percent',
        'Call two sources duplicates when they match',
        90,
        50,
        100,
        '%',
        'Lower finds more near copies, and more that are only alike.',
      ),
    ],
    branch_suggestions: [
      whole(
        'max_shared_percent',
        'Suggest a branch when a message shares less than',
        10,
        1,
        50,
        '% of its words',
        'Compared with your recent questions on the same path. Higher suggests more often.',
      ),
    ],
    context_overflow_warn: [
      whole('warn_at_percent', 'Warn when the context is', 80, 50, 98, '% full'),
      whole(
        'compact_at_percent',
        'Compact when it is',
        95,
        60,
        99,
        '% full',
        'The latest turns are always kept word for word.',
      ),
    ],
    draft_autosave: [
      whole(
        'server_every_s',
        'Save to NVX Ancile after you pause for',
        3,
        1,
        60,
        'seconds',
        'This device keeps every keystroke either way.',
      ),
    ],
    memory_capture: [
      {
        key: 'mode',
        label: 'What it keeps',
        hint: 'Also set at the top of Admin → Memory.',
        type: 'choice',
        min: null,
        max: null,
        unit: null,
        default: 'auto_confident',
        choices: [
          { value: 'auto_confident', label: 'What it is sure of, asking about the rest' },
          { value: 'propose_all', label: 'Nothing until you say yes' },
        ],
      },
    ],
  };
}

/** Settings that only make sense together: the reason a combination is refused, or null. */
export function builtinConfigProblem(id: string, config: Record<string, unknown>): string | null {
  if (id === 'context_overflow_warn') {
    const warn = intOption(config.warn_at_percent, 80, 50, 98);
    const compact = intOption(config.compact_at_percent, 95, 60, 99);
    if (warn >= compact) return 'config.warn_at_percent: the warning has to come before compacting';
  }
  return null;
}

/**
 * git's environment for a push nobody is watching: never ask for a password
 * (on a terminal, in a credential manager's window, or over ssh); fail at
 * once and say so instead. Saved credentials, keys and helpers still work.
 */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
};

/** A remote's credentials (https://user:token@host) never reach a message, a log or Admin. */
export function redactRemote(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1•••@');
}

/** The line of git's output that says what went wrong, without credentials. */
function gitProblem(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; killed?: boolean; code?: unknown };
  if (e.killed) return 'git took too long to answer.';
  const text = String(e.stderr || e.message || err);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Command failed:'));
  const line = lines.find((l) => /^(fatal|error|remote):/i.test(l)) ?? lines[0] ?? 'git could not push.';
  return redactRemote(line).slice(0, 300);
}

/**
 * Admin's Test push: whether the memory folder could be pushed to `remote`
 * now (git push --dry-run), without changing anything there.
 */
export async function testMemoryPush(
  memoryDir: string,
  remote: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; detail: string }> {
  if (!existsSync(join(memoryDir, '.git')))
    return { ok: false, detail: 'The memory folder has no history yet, so there is nothing to push.' };
  try {
    await run('git', ['push', '--dry-run', '--quiet', remote, 'HEAD'], {
      cwd: memoryDir,
      timeout: timeoutMs,
      env: GIT_ENV,
    });
    return { ok: true, detail: 'The remote took a test push. Nothing was changed there.' };
  } catch (err) {
    return { ok: false, detail: gitProblem(err) };
  }
}

type CaptureMode = 'auto_confident' | 'propose_all' | 'off';
const ON_MODES = ['auto_confident', 'propose_all'] as const;
const isOnMode = (v: unknown): v is (typeof ON_MODES)[number] => ON_MODES.includes(v as never);

/**
 * "Learn from corrections" is memory capture: its switch and its one setting
 * are the capture mode Admin → Memory shows, so both places always agree.
 * Off is mode off; on again brings back the mode it had (kept beside it).
 */
export function memoryCaptureLink(deps: {
  memory: { captureMode(): Promise<CaptureMode>; setCaptureMode(mode: CaptureMode): Promise<void> };
  settings: Pick<SettingsStore, 'get' | 'set'>;
}): LinkedJob {
  const lastOn = async () => {
    const v = await deps.settings.get<string>(SETTING.memoryCaptureLastOn).catch(() => undefined);
    return isOnMode(v) ? v : 'auto_confident';
  };
  return {
    read: async () => {
      const mode = await deps.memory.captureMode();
      return { enabled: mode !== 'off', config: { mode: mode === 'off' ? await lastOn() : mode } };
    },
    write: async (p) => {
      const current = await deps.memory.captureMode();
      let mode = isOnMode(current) ? current : await lastOn();
      if (isOnMode(p.config?.mode)) mode = p.config.mode;
      await deps.settings.set(SETTING.memoryCaptureLastOn, mode);
      const on = p.enabled ?? current !== 'off';
      await deps.memory.setCaptureMode(on ? mode : 'off');
    },
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
            hint: 'Set its git remote in Edit, or in Settings → API keys (or ANCILE_MEMORY_REMOTE).',
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
      try {
        await run('git', ['push', '--quiet', remote, 'HEAD'], {
          cwd: deps.memoryDir,
          timeout: 120_000,
          env: GIT_ENV,
        });
      } catch (err) {
        // git's message quotes the remote, credentials and all.
        throw new Error(gitProblem(err));
      }
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
  };
}
