/**
 * ------------------------------------------------------------------
 *  Title    |  What an answer records for its receipt
 *  Ref      |  roadmap WY1 · docs/models.md (prices)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Per-call usage, the rates and payer at the time of the
 *           |  answer, and the retries that worked, in the shapes of
 *           |  contracts Usage and Recovered.
 *  How      |  Pure functions. `noteCall` adds one finished model call
 *           |  to the turn's running usage; `usageOut` turns that into
 *           |  the message's Usage. List price always comes from
 *           |  priceOf (gateway/usage.ts); what the provider billed is
 *           |  kept apart, never added on top. The receipt total is
 *           |  `cost_usd`: billed where the provider said, else list.
 *  Note     |  `calls` keeps the first 50 calls; the totals count all.
 * ------------------------------------------------------------------
 */

import {
  MAX_RECOVERED,
  MAX_USAGE_CALLS,
  type ModelBilling,
  type ModelConfig,
  type Recovered,
  type Usage,
  type UsageCall,
  type UsageRates,
} from '@nvx/contracts';
import type { RecoveryInfo } from '@nvx/resilience';
import type { CallUsage } from '../gateway/usage';
import { priceOf } from '../gateway/usage';

/** The running totals a turn keeps (TurnCheckpoint.usage). */
export interface RunningUsage {
  input: number;
  output: number;
  cached: number;
  costUsd: number;
  written?: number;
  listUsd?: number;
  billedUsd?: number;
  cacheReported?: boolean;
  calls?: UsageCall[];
  served?: { provider: string | null; model: string | null; cut_off: boolean };
}

/** Why a model call ended, in the receipt's words; undefined when the provider said something else. */
export function stopOf(finishReason: string): UsageCall['stop'] | undefined {
  switch (finishReason) {
    case 'tool-calls':
    case 'tool_calls':
      return 'tool_calls';
    case 'stop':
    case 'end_turn':
      return 'end';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

/**
 * Add one finished model call. Returns the spend to count for it: what the
 * provider billed, else the list price (the one meaning the books use).
 */
export function noteCall(
  into: RunningUsage,
  call: {
    model: ModelConfig | undefined;
    modelId: string;
    usage: CallUsage;
    billedUsd?: number | undefined;
    startedMs: number;
    ms: number;
    stop?: UsageCall['stop'] | undefined;
    served?: { provider: string | null; model: string | null; cut_off?: boolean } | undefined;
  },
): number {
  const u = call.usage;
  const cached = Math.max(0, u.cachedTokens ?? 0);
  const written = Math.max(0, u.cacheWriteTokens ?? 0);
  const list = priceOf(call.model, u);
  const spent = call.billedUsd ?? list;
  into.input += u.inputTokens;
  into.output += u.outputTokens;
  into.cached += cached;
  into.written = (into.written ?? 0) + written;
  const before = into.costUsd;
  into.costUsd += spent;
  into.listUsd = (into.listUsd ?? 0) + list;
  if (call.billedUsd !== undefined) into.billedUsd = (into.billedUsd ?? before) + call.billedUsd;
  else if (into.billedUsd !== undefined) into.billedUsd += list;
  if (u.cacheReported) into.cacheReported = true;
  const calls = into.calls ?? [];
  if (calls.length < MAX_USAGE_CALLS)
    calls.push({
      model_id: call.modelId,
      started_ms: Math.max(0, Math.round(call.startedMs)),
      ms: Math.max(0, Math.round(call.ms)),
      input_tokens: u.inputTokens,
      cached_tokens: cached,
      cache_write_tokens: written,
      output_tokens: u.outputTokens,
      cost_usd: list,
      ...(call.billedUsd !== undefined && { billed_usd: call.billedUsd }),
      ...(call.served && {
        served: {
          provider: call.served.provider,
          model: call.served.model,
          cut_off: call.served.cut_off ?? false,
        },
      }),
      ...(call.stop && { stop: call.stop }),
    });
  into.calls = calls;
  return spent;
}

/** The model's prices per million tokens, as they are now: the receipt keeps them with the answer. */
export function ratesOf(m: ModelConfig | undefined): UsageRates | undefined {
  if (!m) return undefined;
  const p = m.price;
  return {
    input: p.input_per_mtok,
    cached: p.cached_per_mtok ?? p.input_per_mtok,
    cache_write: p.cache_write_per_mtok ?? p.input_per_mtok,
    output: p.output_per_mtok,
  };
}

/** The message's Usage from a turn's running totals. */
export function usageOut(
  u: RunningUsage,
  extra: { model: ModelConfig | undefined; billing: ModelBilling | null; ms: number | undefined },
): Usage {
  const rates = ratesOf(extra.model);
  return {
    input_tokens: u.input,
    output_tokens: u.output,
    cached_tokens: u.cached,
    cost_usd: u.costUsd,
    ...(u.served && { served: u.served }),
    // Calls were counted by this version, so the cache figures are known to be this answer's.
    ...(u.calls?.length && {
      cache_write_tokens: u.written ?? 0,
      cache_reported: u.cacheReported === true,
      ...(u.billedUsd !== undefined && { billed_usd: u.billedUsd }),
      ...(u.listUsd !== undefined && { list_usd: u.listUsd }),
      calls: u.calls,
    }),
    ...(extra.billing && { billing: extra.billing }),
    ...(rates && { rates }),
    ...(extra.ms !== undefined && { ms: Math.max(0, Math.round(extra.ms)) }),
  };
}

const SHORT_REASON = 40;

/** A short code for why a call needed retrying. */
export function reasonOf(info: Pick<RecoveryInfo, 'errorClass' | 'error'>): string {
  const e = info.error as { status?: unknown; name?: unknown; message?: unknown } | undefined;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const text = `${typeof e?.name === 'string' ? e.name : ''} ${typeof e?.message === 'string' ? e.message : ''}`;
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return 'rate_limited';
  if (/time.?out|timed out|deadline/i.test(text)) return 'timeout';
  if (status !== undefined && status >= 500) return 'server_error';
  return 'network';
}

/** A retry that worked, as the answer records it. */
export function recoveryOf(what: Recovered['what'], name: string, info: RecoveryInfo): Recovered {
  return {
    what,
    name: name.slice(0, 120),
    attempts: Math.max(2, info.attempts),
    waited_ms: Math.max(0, Math.round(info.waitedMs)),
    reason: reasonOf(info).slice(0, SHORT_REASON),
  };
}

/** Add a recovery to a turn's list, within the cap. */
export function noteRecovery(list: Recovered[] | undefined, r: Recovered): Recovered[] {
  const out = list ?? [];
  if (out.length < MAX_RECOVERED) out.push(r);
  return out;
}
