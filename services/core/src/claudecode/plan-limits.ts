/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code plan limits
 *  Ref      |  docs/claude-code.md (Usage) · contracts usage.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  How much of a Claude plan's 5-hour session and weekly
 *           |  limits is used, and when each resets, as Claude Code's
 *           |  own /usage shows it.
 *  How      |  Two sources, newest wins per window. (1) Every
 *           |  rate_limit_event a live session pushes (the SDK's stable
 *           |  message) updates its window. (2) The bridge's `usage`
 *           |  op, the SDK's experimental usage report, asked at most
 *           |  every few minutes: on an open session's handle after a
 *           |  turn, or from a session that sends nothing when Settings
 *           |  → Usage asks. When that report is missing or changed,
 *           |  the event figures stand. The latest figures are kept in
 *           |  settings, so they survive a restart.
 *  Note     |  Only the plan's kind and the windows are kept: never an
 *           |  account, an email or an organisation.
 * ------------------------------------------------------------------
 */

import { homedir } from 'node:os';
import type { ClaudeCodePlanLimits, PlanWindow } from '@nvx/contracts';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { SettingsStore } from '../settings';
import type { LiveBridge } from './bridge-protocol';

const log = logFor('claude-code-limits');

export const PLAN_LIMITS_KEY = 'claude_code.plan_limits';
/** The usage report is asked for no more often than this. */
export const USAGE_MIN_INTERVAL_MS = 3 * 60_000;
/** Even a forced refresh waits this long after the last ask. */
export const USAGE_FORCE_INTERVAL_MS = 20_000;

/** What the bridge's `usage` op answers (services/claude-bridge/src/usage.ts). */
export interface BridgePlanUsage {
  rate_limits_available: boolean | null;
  subscription_type: string | null;
  windows: Record<string, { utilization: number | null; resets_at: string | null }>;
  model_scoped: { label: string; utilization: number | null; resets_at: string | null }[];
}

type Stored = Omit<ClaudeCodePlanLimits, 'can_refresh'>;

const EMPTY: Stored = { available: null, plan: null, windows: [], updated_at: null, source: null };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);

export function windowKind(id: string): PlanWindow['kind'] {
  if (id === 'five_hour') return 'session';
  if (id === 'seven_day') return 'week';
  if (id.startsWith('seven_day_') || id.startsWith('model:')) return 'week_model';
  return 'other';
}

const ORDER = ['session', 'week', 'week_model', 'other'];
const sortWindows = (ws: PlanWindow[]) =>
  [...ws].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));

/** A model window's label from its id, when the server gave none. */
function labelOf(id: string): string | null {
  if (id === 'seven_day_opus') return 'Opus';
  if (id === 'seven_day_sonnet') return 'Sonnet';
  if (id === 'seven_day_overage_included') return 'Extra usage';
  if (id === 'overage') return 'Extra usage';
  return null;
}

/**
 * A rate_limit_event's info as a window, or null when it is not one.
 * Its utilization is a share (0 to 1) in the SDK; a figure above 1 is read as a percent.
 */
export function windowFromEvent(info: unknown, at: string): PlanWindow | null {
  if (!isObj(info)) return null;
  const id =
    typeof info.rateLimitType === 'string' && /^[a-z_]{1,40}$/.test(info.rateLimitType)
      ? info.rateLimitType
      : null;
  if (!id) return null;
  const u =
    typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : null;
  const resets =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
      ? new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString()
      : null;
  const status = typeof info.status === 'string' && STATUSES.has(info.status) ? info.status : null;
  return {
    id,
    kind: windowKind(id),
    label: labelOf(id),
    percent: u === null ? (status === 'rejected' ? 100 : null) : clampPct(u <= 1 ? u * 100 : u),
    resets_at: resets,
    status: status as PlanWindow['status'],
    updated_at: at,
  };
}

/** The usage report's windows. */
export function windowsFromUsage(u: BridgePlanUsage, at: string): PlanWindow[] {
  const out: PlanWindow[] = [];
  for (const [id, w] of Object.entries(isObj(u.windows) ? u.windows : {})) {
    if (!isObj(w) || id === 'seven_day_oauth_apps') continue;
    const p = typeof w.utilization === 'number' ? clampPct(w.utilization) : null;
    out.push({
      id,
      kind: windowKind(id),
      label: labelOf(id),
      percent: p,
      resets_at: typeof w.resets_at === 'string' ? w.resets_at : null,
      status: null,
      updated_at: at,
    });
  }
  for (const w of Array.isArray(u.model_scoped) ? u.model_scoped : []) {
    if (!isObj(w) || typeof w.label !== 'string') continue;
    const id = `model:${w.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 30)}`;
    if (out.some((x) => x.id === id)) continue;
    out.push({
      id,
      kind: 'week_model',
      label: w.label,
      percent: typeof w.utilization === 'number' ? clampPct(w.utilization) : null,
      resets_at: typeof w.resets_at === 'string' ? w.resets_at : null,
      status: null,
      updated_at: at,
    });
  }
  return out;
}

export interface PlanLimitsDeps {
  settings: SettingsStore;
  bridge: LiveBridge;
  /** The verified Claude Code to run, or a throw when there is none. */
  cli(): Promise<{ path: string }>;
  env(): Promise<Record<string, string>>;
  /** A live session already open, to ask on (none: a session that sends nothing is opened). */
  openHandle(): string | null;
  bus?: EventBus;
  now?: () => number;
}

export class PlanLimits {
  private cache: Stored | null = null;
  private lastAsk = 0;
  private asking: Promise<void> | null = null;
  private ready: { at: number; ok: boolean } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PlanLimitsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async load(): Promise<Stored> {
    if (this.cache) return this.cache;
    const v = await this.deps.settings.get<Stored>(PLAN_LIMITS_KEY).catch(() => undefined);
    this.cache = isObj(v) && Array.isArray(v.windows) ? { ...EMPTY, ...v } : { ...EMPTY };
    return this.cache;
  }

  private async save(next: Stored): Promise<void> {
    this.cache = next;
    await this.deps.settings
      .set(PLAN_LIMITS_KEY, next)
      .catch((err: unknown) => log.warn({ err: (err as Error).message }, 'plan limits not saved'));
    await this.deps.bus?.publish({ type: 'claude_code.changed', what: 'limits' }).catch(() => undefined);
  }

  private merge(cur: Stored, ws: PlanWindow[]): PlanWindow[] {
    const by = new Map(cur.windows.map((w) => [w.id, w]));
    for (const w of ws) {
      const old = by.get(w.id);
      // An event's status outlives a report that does not carry one.
      by.set(w.id, { ...w, status: w.status ?? old?.status ?? null });
    }
    return sortWindows([...by.values()]);
  }

  /** Every message a live session pushes passes here; only rate_limit_event is read. */
  async observe(m: Record<string, unknown>): Promise<void> {
    if (m.type !== 'rate_limit_event') return;
    const at = new Date(this.now()).toISOString();
    const w = windowFromEvent(m.rate_limit_info, at);
    if (!w) return;
    const cur = await this.load();
    await this.save({
      ...cur,
      // Only a plan sign-in gets these events.
      available: true,
      windows: this.merge(cur, [w]),
      updated_at: at,
      source: 'event',
    });
  }

  /**
   * When the window that is used up resets (a rejected window, or one at
   * 100%), the soonest still ahead; null when none is, or none is known.
   */
  async blockedUntil(): Promise<string | null> {
    const cur = await this.load();
    const now = this.now();
    const ahead = cur.windows
      .filter((w) => w.status === 'rejected' || (w.percent ?? 0) >= 100)
      .map((w) => (w.resets_at ? Date.parse(w.resets_at) : Number.NaN))
      .filter((t) => Number.isFinite(t) && t > now)
      .sort((a, b) => a - b);
    return ahead.length ? new Date(ahead[0] as number).toISOString() : null;
  }

  /** A turn ended on this handle: ask for the usage report if the last one is old. */
  afterTurn(handle: string): void {
    if (this.now() - this.lastAsk < USAGE_MIN_INTERVAL_MS) return;
    void this.ask(handle).catch(() => undefined);
  }

  /** The figures as last seen; with refresh, Claude Code is asked first (rate-limited). */
  async get(opts: { refresh?: boolean } = {}): Promise<ClaudeCodePlanLimits> {
    let canRefresh = true;
    if (opts.refresh && this.now() - this.lastAsk >= USAGE_FORCE_INTERVAL_MS) {
      try {
        await this.ask(this.deps.openHandle());
      } catch (err) {
        canRefresh = !(err instanceof NoClaudeCode);
      }
    } else {
      // Whether Claude Code can be asked, checked at most once a minute.
      if (!this.ready || this.now() - this.ready.at > 60_000)
        this.ready = {
          at: this.now(),
          ok: await this.deps.cli().then(
            () => true,
            () => false,
          ),
        };
      canRefresh = this.ready.ok;
    }
    return { ...(await this.load()), can_refresh: canRefresh };
  }

  /** Ask the usage report, once at a time. */
  private ask(handle: string | null): Promise<void> {
    this.asking ??= this.askNow(handle).finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  private async askNow(handle: string | null): Promise<void> {
    this.lastAsk = this.now();
    let own: string | null = null;
    let h = handle;
    if (!h) {
      const cli = await this.deps.cli().catch(() => null);
      if (!cli) throw new NoClaudeCode();
      own = (
        await this.deps.bridge.open({
          cwd: homedir(),
          path_to_cli: cli.path,
          persist: false,
          permission_mode: 'default',
          env: await this.deps.env(),
        })
      ).handle;
      h = own;
    }
    try {
      const u = await this.deps.bridge.control<BridgePlanUsage>(h, 'usage');
      if (!isObj(u)) return;
      const at = new Date(this.now()).toISOString();
      const cur = await this.load();
      if (u.rate_limits_available === false) {
        await this.save({ available: false, plan: null, windows: [], updated_at: at, source: 'usage' });
        return;
      }
      const ws = windowsFromUsage(u, at);
      await this.save({
        available: u.rate_limits_available ?? (ws.length ? true : cur.available),
        plan: typeof u.subscription_type === 'string' ? u.subscription_type.slice(0, 24) : cur.plan,
        windows: this.merge(cur, ws),
        updated_at: at,
        source: 'usage',
      });
    } catch (err) {
      // The report is experimental: the figures from rate_limit_event stand.
      log.info(
        { err: (err as Error).message },
        'Claude Code usage report not available; keeping what it reported while working',
      );
    } finally {
      if (own) await this.deps.bridge.close(own).catch(() => undefined);
    }
  }
}

class NoClaudeCode extends Error {
  constructor() {
    super('Claude Code is not installed and verified');
  }
}
