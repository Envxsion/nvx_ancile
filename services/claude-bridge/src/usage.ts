/**
 * ------------------------------------------------------------------
 *  Title    |  Plan usage, read defensively
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · src/session.ts
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Ask a live session for the figures behind Claude Code's
 *           |  own /usage (plan limits for a Claude plan sign-in), and
 *           |  hand Core only those figures.
 *  How      |  The SDK method is marked experimental and may change or
 *           |  go: it is looked up by name, called with skipBehaviors
 *           |  (no scan of local transcripts), and its answer is read
 *           |  loosely, field by field. Anything missing or odd becomes
 *           |  null; a missing method is a clear error Core falls back
 *           |  from (the limits Claude Code reports while working).
 *  Note     |  Only the plan's kind, the windows and the session's cost
 *           |  estimate leave this file: never an account, an email or
 *           |  an organisation, whatever the answer holds.
 * ------------------------------------------------------------------
 */

/** The SDK's experimental method; its name will change when it is stable. */
export const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

export interface PlanWindowOut {
  utilization: number | null;
  resets_at: string | null;
}

export interface PlanUsageOut {
  /** null: the answer did not say. */
  rate_limits_available: boolean | null;
  subscription_type: string | null;
  /** By window id (five_hour, seven_day, seven_day_opus, …). */
  windows: Record<string, PlanWindowOut>;
  /** Per-model weekly windows, with the server's label. */
  model_scoped: (PlanWindowOut & { label: string })[];
  session_cost_usd: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
};
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const short = (v: unknown, max = 40): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;

const WINDOW_ID = /^[a-z][a-z0-9_]{0,40}$/;

/** Read the experimental answer loosely; never throws. */
export function readPlanUsage(raw: unknown): PlanUsageOut {
  const r = isObj(raw) ? raw : {};
  const out: PlanUsageOut = {
    rate_limits_available: typeof r.rate_limits_available === 'boolean' ? r.rate_limits_available : null,
    subscription_type: short(r.subscription_type, 24),
    windows: {},
    model_scoped: [],
    session_cost_usd: isObj(r.session) ? num(r.session.total_cost_usd) : null,
  };
  const limits = isObj(r.rate_limits) ? r.rate_limits : null;
  if (!limits) return out;
  for (const [id, w] of Object.entries(limits)) {
    if (id === 'model_scoped' || id === 'extra_usage' || !WINDOW_ID.test(id) || !isObj(w)) continue;
    if (!('utilization' in w) && !('resets_at' in w)) continue;
    out.windows[id] = { utilization: pct(w.utilization), resets_at: iso(w.resets_at) };
  }
  if (Array.isArray(limits.model_scoped))
    for (const w of limits.model_scoped.slice(0, 12)) {
      if (!isObj(w)) continue;
      const label = short(w.display_name);
      if (label)
        out.model_scoped.push({ label, utilization: pct(w.utilization), resets_at: iso(w.resets_at) });
    }
  return out;
}

/** Call the experimental method on a query, if this SDK has it. */
export async function planUsage(q: unknown): Promise<PlanUsageOut> {
  const fn = isObj(q) || typeof q === 'function' ? (q as Record<string, unknown>)[USAGE_METHOD] : undefined;
  if (typeof fn !== 'function') throw new Error('This Claude Code does not report plan usage');
  const raw = await (fn as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, {
    skipBehaviors: true,
  });
  return readPlanUsage(raw);
}

/** Where Claude Code compacts by itself, as a percent of its window; null when it will not or did not say. */
export function compactsAt(u: Record<string, unknown>): number | null {
  if (u.isAutoCompactEnabled === false) return null;
  const t = num(u.autoCompactThreshold);
  const max = num(u.maxTokens);
  if (t === null || t <= 0) return null;
  // A count of tokens (the usual), a share (0 to 1), or a percent.
  if (t > 100 && max && max > 0) return Math.min(100, Math.round((t / max) * 1000) / 10);
  if (t <= 1) return Math.round(t * 1000) / 10;
  return t <= 100 ? t : null;
}
