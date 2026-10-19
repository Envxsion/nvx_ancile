/**
 * ------------------------------------------------------------------
 *  Title    |  Which models have this thread cached
 *  Ref      |  ROADMAP.md CA12 · docs/prompt-caching.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Switching model mid-thread can mean paying full price to
 *           |  read the whole conversation again. The model picker asks
 *           |  here which models still have this thread's start cached,
 *           |  and what a model without it would cost to catch up.
 *  How      |  Pure over the thread's messages: the last call each model
 *           |  made (Usage.calls: when it began, how long it took, what
 *           |  it read from and wrote to the cache) and that provider's
 *           |  cache lifetime (gateway/cache.ts warmWindow). A model is
 *           |  warm while the last cache-touching call plus the lifetime
 *           |  is still ahead. Cost is the prefix at the model's fresh
 *           |  input rate now (off-peak prices apply at `now`); a plan
 *           |  has none, a local model costs nothing but time.
 *  Note     |  A provider that reports no cache figures is guessed from
 *           |  its last call and marked `reported: false`. Answers
 *           |  stored before per-call usage have no calls and are left
 *           |  out.
 * ------------------------------------------------------------------
 */

import type { CacheCandidate, CacheState, CacheStateItem, ModelBilling, ModelConfig } from '@nvx/contracts';
import { warmWindow } from '../gateway/cache';
import { ratesAt } from '../gateway/usage';
import type { MessageRecord } from './repo';

/** The most models listed: the ones used most recently. */
const MAX_ITEMS = 12;

export interface CacheStateDeps {
  /** The model with exactly this id, or undefined. */
  exact(id: string): ModelConfig | undefined;
  /** The model an id (or a line alias) answers to. */
  get(id: string): ModelConfig | undefined;
  billingFor(id: string): ModelBilling | null;
}

interface LastCall {
  modelId: string;
  /** Epoch ms when the call ended. */
  end: number;
  input: number;
  output: number;
  cached: number;
  written: number;
  reported: boolean;
}

/** Each model's latest call on the thread, newest model first. */
function lastCalls(messages: Pick<MessageRecord, 'created_at' | 'usage' | 'status'>[]): LastCall[] {
  const latest = new Map<string, LastCall>();
  for (const m of messages) {
    const u = m.usage;
    if (!u?.calls?.length) continue;
    const base = Date.parse(m.created_at);
    if (Number.isNaN(base)) continue;
    for (const c of u.calls) {
      const end = base + c.started_ms + c.ms;
      const have = latest.get(c.model_id);
      if (have && have.end >= end) continue;
      latest.set(c.model_id, {
        modelId: c.model_id,
        end,
        input: c.input_tokens,
        output: c.output_tokens,
        cached: c.cached_tokens,
        written: c.cache_write_tokens,
        // Figures of zero from a provider that reports are still a report; the answer says which.
        reported: u.cache_reported === true || c.cached_tokens + c.cache_write_tokens > 0,
      });
    }
  }
  return [...latest.values()].sort((a, b) => b.end - a.end);
}

/** What a model costs to catch up: per-token price, none on a plan, nothing but time when local. */
function costOf(
  m: ModelConfig | undefined,
  billing: ModelBilling | null,
  tokens: number,
  now: number,
): { cost: number | null; plan?: true; local?: true } {
  if (billing?.kind === 'plan') return { cost: null, plan: true };
  if (billing?.kind === 'local') return { cost: 0, local: true };
  if (!m) return { cost: null };
  return { cost: (tokens * ratesAt(m.price, now).input_per_mtok) / 1_000_000 };
}

export function cacheState(
  messages: Pick<MessageRecord, 'created_at' | 'usage' | 'status'>[],
  deps: CacheStateDeps,
  now: number,
  candidate?: string,
): CacheState {
  const calls = lastCalls(messages);
  // The thread's start now: the latest call's whole prompt, plus the answer it wrote.
  const newest = calls[0];
  const threadTokens = newest ? newest.input + newest.output : 0;

  const items: CacheStateItem[] = [];
  const warmOn = new Set<string>();
  for (const c of calls) {
    const m = deps.exact(c.modelId);
    if (!m) continue;
    const window = warmWindow(m.provider);
    const touched = c.cached + c.written > 0;
    // A provider that reports figures is warm only if the last call touched the cache.
    const warm = (c.reported ? touched : true) && now < c.end + window.ms;
    if (warm) warmOn.add(c.modelId);
    const prefix = touched ? c.cached + c.written : c.input;
    const { cost, plan, local } = costOf(m, deps.billingFor(c.modelId), prefix, now);
    items.push({
      model_id: c.modelId,
      provider: m.provider,
      warm_until: warm ? new Date(c.end + window.ms).toISOString() : null,
      prefix_tokens: prefix,
      cold_cost_usd: cost,
      reported: c.reported,
      ...(plan && { plan }),
      ...(local && { local }),
      ...(window.assumed && { ttl_assumed: true }),
    });
    if (items.length >= MAX_ITEMS) break;
  }

  const out: CacheState = { items, thread_tokens: threadTokens };
  if (candidate !== undefined) {
    const m = deps.get(candidate);
    if (m) {
      const { cost, plan, local } = costOf(m, deps.billingFor(m.id), threadTokens, now);
      const c: CacheCandidate = {
        model_id: m.id,
        warm: warmOn.has(m.id),
        prefix_tokens: threadTokens,
        cold_cost_usd: cost,
        ...(plan && { plan }),
        ...(local && { local }),
      };
      out.candidate = c;
    }
  }
  return out;
}
