/**
 * ------------------------------------------------------------------
 *  Title    |  Which models have this thread cached
 *  Ref      |  ROADMAP.md CA12 · packages/contracts/src/cache.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Data and wording for two quiet signals: a warm mark beside
 *           |  the models that have this thread cached right now, and one
 *           |  line saying what moving to a cold model re-reads.
 *  How      |  GET /threads/:id/cache-state (items for every model the
 *           |  thread used) and ?candidate= (one model it has not). Both
 *           |  are refetched when a turn finishes (lib/run.ts). A 404 or
 *           |  any failure means "no information": nothing is shown and
 *           |  nothing is reported. Demo mode uses a small fixture.
 *  Note     |  A price tag, never a gate. Times and prices are estimates;
 *           |  a provider that reports no cache figures is guessed.
 * ------------------------------------------------------------------
 */

import type { CacheCandidate, CacheState, CacheStateItem } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../lib/api';
import { useThread } from '../lib/data';
import type { ModelView } from '../lib/types';
import { money } from '../receipt/figures';
import { useUi } from '../state/ui';

/** A short thread shows nothing: below this a provider will not cache it anyway. */
export const MIN_PREFIX_TOKENS = 1024;
/** Under this a re-read costs too little to be worth a line. */
export const MIN_COST_USD = 0.001;
/** A mark is at full strength with this long left, and fades towards its end. */
export const FADE_WINDOW_MS = 5 * 60_000;

export const cacheKeys = {
  thread: (id: string) => ['cache-state', id] as const,
  candidate: (id: string, model: string) => ['cache-state', id, 'candidate', model] as const,
};

/** The fixture shown in demo mode: Sonnet has the thread cached for three more minutes. */
export function demoCacheState(now = Date.now()): CacheState {
  const base = { reported: true, prefix_tokens: 84_000 } as const;
  return {
    thread_tokens: 84_000,
    items: [
      {
        ...base,
        model_id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        warm_until: new Date(now + 3 * 60_000).toISOString(),
        cold_cost_usd: 0.25,
      },
      {
        ...base,
        model_id: 'anthropic/claude-opus-5-5',
        provider: 'anthropic',
        warm_until: null,
        cold_cost_usd: 1.26,
      },
      { ...base, model_id: 'openai/gpt-5.5', provider: 'openai', warm_until: null, cold_cost_usd: 0.42 },
      {
        ...base,
        model_id: 'ollama/qwen3:14b',
        provider: 'ollama',
        warm_until: null,
        cold_cost_usd: null,
        local: true,
      },
    ],
  };
}

/** The thread's cache state; null when unknown (offline, 404, demo off-fixture). */
export function useCacheState(threadId: string | undefined): CacheState | null {
  const demo = useUi((s) => s.demo);
  const q = useQuery({
    queryKey: cacheKeys.thread(threadId ?? 'none'),
    queryFn: () => api.get<CacheState>(`/threads/${threadId}/cache-state`).catch(() => null),
    enabled: !!threadId && !demo,
    staleTime: 20_000,
    retry: false,
  });
  if (demo) return threadId ? demoCacheState() : null;
  return q.data ?? null;
}

/** The item for a picker entry; an alias entry ("latest") matches the model it answers with now. */
export function findCacheItem(
  items: CacheStateItem[] | undefined,
  entry: { id: string; model?: Pick<ModelView, 'aliasOf'> | undefined },
): CacheStateItem | undefined {
  if (!items) return undefined;
  const id = entry.model?.aliasOf ?? entry.id;
  return items.find((i) => i.model_id === id) ?? items.find((i) => i.model_id === entry.id);
}

/** Minutes left on a warm cache, rounded up; 0 when cold or expired. */
export function warmLeftMs(item: CacheStateItem | undefined, now: number): number {
  if (!item?.warm_until) return 0;
  const t = Date.parse(item.warm_until);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

/** Full strength with FADE_WINDOW_MS or more left, fading linearly to a faint mark at the end. */
export function warmOpacity(leftMs: number): number {
  return Math.round((0.3 + 0.7 * Math.min(1, leftMs / FADE_WINDOW_MS)) * 100) / 100;
}

/** "Has this thread cached for about 3 more minutes", or "Probably has…" when it is a guess. */
export function warmWords(item: CacheStateItem, leftMs: number): string {
  const guess = !item.reported || !!item.ttl_assumed;
  const mins = Math.max(1, Math.ceil(leftMs / 60_000));
  const span = leftMs < 60_000 ? 'less than a minute' : `about ${mins} more minute${mins === 1 ? '' : 's'}`;
  const lead = guess ? 'Probably has' : 'Has';
  return `${lead} this thread cached for ${span}`;
}

/** "84k", "1.5k", "620". */
export function tokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(Math.round(n / 100) / 10).toString()}k`;
  return `${Math.round(n / 1000)}k`;
}

export type SwitchCost = Pick<CacheCandidate, 'prefix_tokens' | 'cold_cost_usd' | 'plan' | 'local' | 'warm'>;

/** The one line under a cold model, or null when it would be noise (short thread, tiny cost, warm). */
export function switchCostLine(c: SwitchCost | undefined | null): string | null {
  if (!c || c.warm || c.prefix_tokens < MIN_PREFIX_TOKENS) return null;
  const n = `Re-reads ${tokensShort(c.prefix_tokens)} tokens`;
  if (c.local) return `${n}, first reply slower`;
  if (c.plan) return `${n} on your plan, first reply slower`;
  if (c.cold_cost_usd === null || c.cold_cost_usd < MIN_COST_USD) return null;
  return `${n}: about ${c.cold_cost_usd >= 0.01 ? `$${c.cold_cost_usd.toFixed(2)}` : money(c.cold_cost_usd)}, first reply slower`;
}

/** Re-render on a clock while `on`, so marks fade without a fetch. */
export function useNow(intervalMs = 30_000, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, on]);
  return now;
}

/** What the next turn's model would cost to switch to, for this thread. Null when nothing is worth saying. */
export function useSwitchCost(
  threadId: string | undefined,
  candidateId: string | undefined,
  enabled = true,
): { candidate: CacheCandidate; line: string | null; guess: boolean } | null {
  const demo = useUi((s) => s.demo);
  const thread = useThread(threadId);
  const answered = !!thread.data?.messages.some((m) => m.role === 'assistant');
  const on = !!threadId && !!candidateId && answered && enabled;
  const q = useQuery({
    queryKey: cacheKeys.candidate(threadId ?? 'none', candidateId ?? 'none'),
    queryFn: () =>
      api
        .get<CacheState>(
          `/threads/${threadId}/cache-state?candidate=${encodeURIComponent(candidateId ?? '')}`,
        )
        .catch(() => null),
    enabled: on && !demo,
    staleTime: 20_000,
    retry: false,
  });
  if (!on) return null;
  const state = demo ? demoCacheState() : q.data;
  let candidate = state?.candidate;
  if (!candidate && demo) {
    const i = findCacheItem(state?.items, { id: candidateId ?? '' });
    if (i)
      candidate = {
        model_id: i.model_id,
        warm: !!i.warm_until,
        prefix_tokens: i.prefix_tokens,
        cold_cost_usd: i.cold_cost_usd,
        ...(i.plan && { plan: true }),
        ...(i.local && { local: true }),
      };
  }
  if (!candidate) return null;
  const item = findCacheItem(state?.items, { id: candidate.model_id });
  return { candidate, line: switchCostLine(candidate), guess: item ? !item.reported : false };
}

/** Switch-cost lines the person closed, per thread and model, for this visit. */
interface DismissState {
  closed: Record<string, true>;
  dismiss: (threadId: string, modelId: string) => void;
}
export const useSwitchCostDismissed = create<DismissState>()((set) => ({
  closed: {},
  dismiss: (threadId, modelId) => set((s) => ({ closed: { ...s.closed, [`${threadId}|${modelId}`]: true } })),
}));
