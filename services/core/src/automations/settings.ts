/**
 * ------------------------------------------------------------------
 *  Title    |  Built-in switches
 *  Ref      |  config/automations.yaml · docs/configuration.md#automations
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the event-driven built-ins (thread titles, branch
 *           |  suggestions, the context watch, the knowledge jobs)
 *           |  read before they act: whether they are switched on,
 *           |  and their settings, as changed in Admin → Automations.
 *  How      |  A cache of core.automations over the YAML defaults,
 *           |  read at start, after every change made here, and once
 *           |  a minute for a change another Core made. Reads are
 *           |  synchronous so a hot path never waits on the database.
 *           |  A job nobody configured is on, with its defaults:
 *           |  exactly what the feature did before it had a switch.
 *  Note     |  KnowledgeSync sends the knowledge service its jobs'
 *           |  settings at start and after each change, and again
 *           |  until it has them (KnowledgeAutomations).
 * ------------------------------------------------------------------
 */

import {
  DEFAULT_KNOWLEDGE_AUTOMATIONS,
  KnowledgeAutomations,
  type KnowledgeAutomations as KnowledgeAutomationsT,
} from '@nvx/contracts';
import { logFor } from '../obs/logger';
import type { AutomationStore, JobSpec } from './runner';

const log = logFor('automations.settings');

/** What a feature asks before it acts. */
export interface JobSwitches {
  /** Switched on (a job nobody configured is on). */
  on(id: string): boolean;
  /** One setting: the value changed in Admin, else the YAML default, else undefined. */
  option(id: string, key: string): unknown;
}

/** Every job on, with the defaults its code had: for tests and a Core without automations. */
export const ALWAYS_ON: JobSwitches = { on: () => true, option: () => undefined };

/** A whole number from a job's settings within [min, max], or the fallback. */
export function intSetting(
  s: JobSwitches,
  id: string,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const v = s.option(id, key);
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

export class BuiltinSettings implements JobSwitches {
  private rows = new Map<string, { enabled: boolean; config: Record<string, unknown> }>();
  private listeners = new Set<(changed: string[]) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jobs: Record<string, JobSpec>,
    private readonly store?: Pick<AutomationStore, 'list'>,
  ) {}

  on(id: string): boolean {
    return this.rows.get(id)?.enabled ?? this.jobs[id]?.enabled ?? true;
  }

  option(id: string, key: string): unknown {
    const row = this.rows.get(id)?.config;
    if (row && Object.hasOwn(row, key)) return row[key];
    const spec = this.jobs[id]?.config;
    return spec && Object.hasOwn(spec, key) ? spec[key] : undefined;
  }

  /** Read the store again and tell listeners which jobs changed. */
  async refresh(): Promise<void> {
    if (!this.store) return;
    const next = new Map<string, { enabled: boolean; config: Record<string, unknown> }>();
    for (const r of await this.store.list())
      if (r.origin === 'builtin') next.set(r.id, { enabled: r.enabled, config: r.config });
    const changed: string[] = [];
    for (const id of new Set([...next.keys(), ...this.rows.keys()]))
      if (JSON.stringify(next.get(id)) !== JSON.stringify(this.rows.get(id))) changed.push(id);
    this.rows = next;
    if (changed.length) for (const l of this.listeners) l(changed);
  }

  /** Called with the ids whose switch or settings changed. */
  subscribe(fn: (changed: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Pick up a change another Core made. */
  start(everyMs = 60_000): void {
    this.stop();
    this.timer = setInterval(
      () => void this.refresh().catch((err: unknown) => log.warn({ err }, 'automation settings not read')),
      everyMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The knowledge service's jobs, as the knowledge service is sent them. */
export const KNOWLEDGE_JOBS = ['auto_tag_sources', 'duplicate_sources', 'stale_sources'] as const;

export function knowledgeAutomations(s: JobSwitches): KnowledgeAutomationsT {
  const d = DEFAULT_KNOWLEDGE_AUTOMATIONS;
  return KnowledgeAutomations.parse({
    auto_tag_sources: {
      enabled: s.on('auto_tag_sources'),
      max_tags: intSetting(s, 'auto_tag_sources', 'max_tags', d.auto_tag_sources.max_tags, 1, 20),
    },
    duplicate_sources: {
      enabled: s.on('duplicate_sources'),
      near_duplicate_percent: intSetting(
        s,
        'duplicate_sources',
        'near_duplicate_percent',
        d.duplicate_sources.near_duplicate_percent,
        50,
        100,
      ),
    },
    stale_sources: {
      enabled: s.on('stale_sources'),
      url_stale_after_days: intSetting(
        s,
        'stale_sources',
        'url_stale_after_days',
        d.stale_sources.url_stale_after_days,
        1,
        365,
      ),
    },
  });
}

/**
 * Keeps the knowledge service in step: sends its jobs' settings at start
 * and after every change to one of them, and tries again every half
 * minute until it has them (it may be starting, or restarting).
 */
export class KnowledgeSync {
  private pending = false;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private sending: Promise<boolean> | null = null;

  constructor(
    private readonly settings: BuiltinSettings,
    private readonly kn: { put(path: string, body: unknown): Promise<unknown> },
    private readonly retryMs = 30_000,
  ) {}

  start(): void {
    this.unsubscribe = this.settings.subscribe((changed) => {
      if (changed.some((id) => (KNOWLEDGE_JOBS as readonly string[]).includes(id))) void this.send();
    });
    this.timer = setInterval(() => {
      if (this.pending) void this.send();
    }, this.retryMs);
    this.timer.unref?.();
    void this.send();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether a send is still owed (the knowledge service did not take the last one). */
  get owed(): boolean {
    return this.pending;
  }

  /** Send the current settings now. Resolves true once the knowledge service has them. */
  async send(): Promise<boolean> {
    if (this.sending) await this.sending.catch(() => undefined);
    this.sending = this.kn
      .put('/maintenance/automations', knowledgeAutomations(this.settings))
      .then(() => {
        this.pending = false;
        return true;
      })
      .catch((err: unknown) => {
        if (!this.pending)
          log.warn({ err }, 'the knowledge service did not take its automation settings yet');
        this.pending = true;
        return false;
      });
    const ok = await this.sending;
    this.sending = null;
    return ok;
  }
}
