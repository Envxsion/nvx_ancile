/**
 * ------------------------------------------------------------------
 *  Title    |  Usage: queries and words
 *  Ref      |  docs/api.md (Usage) · contracts usage.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What Settings → Usage, the status bar and Claude Code's
 *           |  usage popover read: the plan limits and the totals, and
 *           |  the words each figure is shown in.
 *  How      |  React Query. Plan limits poll every minute while shown
 *           |  and are invalidated by claude_code.changed {what:
 *           |  'limits'}; Refresh asks Core to ask Claude Code (Core
 *           |  keeps it to once every 20 seconds). Totals are cut in
 *           |  this browser's time zone.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodePlanLimits, PlanWindow, UsageRange, UsageReport } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';

export const USAGE_KEYS = {
  all: ['usage'] as const,
  limits: ['usage', 'plan-limits'] as const,
  report: (range: UsageRange) => ['usage', 'report', range] as const,
};

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function usePlanLimits(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: USAGE_KEYS.limits,
    queryFn: () => api.get<ClaudeCodePlanLimits>('/claude-code/plan-limits'),
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Ask Claude Code for its figures now, and show them. */
export async function refreshPlanLimits(): Promise<ClaudeCodePlanLimits> {
  const fresh = await api.get<ClaudeCodePlanLimits>('/claude-code/plan-limits?refresh=1');
  queryClient.setQueryData(USAGE_KEYS.limits, fresh);
  return fresh;
}

export function useUsageReport(range: UsageRange, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: USAGE_KEYS.report(range),
    queryFn: () => api.get<UsageReport>(`/usage?range=${range}&tz=${encodeURIComponent(localZone())}`),
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
}

/* ---- Words ------------------------------------------------------------------ */

/** neutral below 70%, warn from 70%, over from 90% (the same steps as every meter here). */
export type MeterTone = 'calm' | 'high' | 'over';
export function toneOf(percent: number | null, over = 90, high = 70): MeterTone {
  if (percent === null) return 'calm';
  return percent >= over ? 'over' : percent >= high ? 'high' : 'calm';
}

export function windowTitle(w: PlanWindow): string {
  if (w.kind === 'session') return 'Current session (5 hours)';
  if (w.kind === 'week') return 'This week';
  if (w.kind === 'week_model') return `This week, ${w.label ?? 'one model'}`;
  return w.label ?? 'Extra usage';
}

const time = (d: Date) =>
  d
    .toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/\s?([ap])m$/i, ' $1m');

/** "resets at 3:40 pm" within a day, else "resets Mon 9:00 am". */
export function resetWords(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= now) return 'reset since';
  if (d.getTime() - now < 20 * 3600_000) return `resets at ${time(d)}`;
  const day = d.toLocaleDateString('en-GB', { weekday: 'short' });
  return `resets ${day} ${time(d)}`;
}

/** "Current session (5 hours): 42% used, resets at 3:40 pm". */
export function windowLine(w: PlanWindow, now = Date.now()): string {
  const used = w.percent === null ? 'use not reported' : `${Math.round(w.percent)}% used`;
  const resets = resetWords(w.resets_at, now);
  return `${windowTitle(w)}: ${used}${resets ? `, ${resets}` : ''}`;
}

export function updatedWords(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Not reported yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'Updated just now';
  if (s < 3600) return `Updated ${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `Updated ${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `Updated ${d === 1 ? 'yesterday' : `${d} days ago`}`;
}

export const ENGINE_WORDS: Record<string, string> = {
  gateway: 'Chat and flows',
  claude_code: 'Claude Code',
  lab: 'Lab',
  other: 'Other',
};

export function tokensWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function costWords(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

/** The model's name without its provider ("anthropic/claude-x" → "claude-x"). */
export function modelWords(id: string | null): string {
  if (!id) return 'Other models';
  const cc = id.startsWith('claude-code/') ? id.slice('claude-code/'.length) : null;
  if (cc) return cc;
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}
