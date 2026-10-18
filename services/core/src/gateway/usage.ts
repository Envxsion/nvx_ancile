/**
 * ------------------------------------------------------------------
 *  Title    |  Usage and price, the same for every provider
 *  Ref      |  docs/models.md (prices) · plan CA0
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One meaning for a call's token counts, whoever served
 *           |  it, and one price function for every cost Ancile shows.
 *  How      |  `inputTokens` is every prompt token, cache reads and
 *           |  cache writes included; `cachedTokens` and
 *           |  `cacheWriteTokens` say how many of them were which.
 *           |  Providers disagree: Anthropic's input_tokens leaves both
 *           |  out, OpenAI-style APIs count them in, and DeepSeek names
 *           |  its hits prompt_cache_hit_tokens, which the AI SDK's
 *           |  OpenAI-compatible provider does not read. Each adapter
 *           |  converts to this meaning before a cost is worked out.
 *  Note     |  Claude Code's own records (claudecode/live.ts, map.ts)
 *           |  still count cache reads apart from input; they bill a
 *           |  plan, not a key. TODO(phase-0.1.1): CA2 brings them in.
 * ------------------------------------------------------------------
 */

import type { ModelConfig, PriceWindow } from '@nvx/contracts';
import { ALL_HIT_FIELDS, ALL_WRITE_FIELDS, firstNumber } from './profiles';

export interface CallUsage {
  /** Every prompt token, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens read from the provider's cache. */
  cachedTokens?: number;
  /** Prompt tokens written to the provider's cache (Anthropic, some OpenRouter routes). */
  cacheWriteTokens?: number;
  /**
   * The provider sent cache figures (even zeros). False or absent: the cache
   * counts are unknown, and the receipt says "not reported" instead of 0.
   */
  cacheReported?: boolean;
}

/** The rates of one model at one moment, per million tokens. */
export type Rates = Pick<
  ModelConfig['price'],
  'input_per_mtok' | 'output_per_mtok' | 'cached_per_mtok' | 'cache_write_per_mtok'
>;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/**
 * Is this moment inside one of the windows? Weekday and clock are read in UTC
 * (no daylight saving). A window runs from its start up to, not including, its end.
 */
export function inWindows(windows: readonly PriceWindow[], at: Date | number): boolean {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return false;
  const day = DAYS[d.getUTCDay()];
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return windows.some(
    (w) =>
      w.days.includes(day as PriceWindow['days'][number]) &&
      minute >= minutesOf(w.from) &&
      minute < minutesOf(w.to),
  );
}

/**
 * The rates in force at `at`: the model's off-peak rates inside its off-peak
 * windows (a field the off-peak rate leaves out keeps the normal one), else its
 * normal price.
 */
export function ratesAt(price: ModelConfig['price'], at: Date | number = Date.now()): Rates {
  const off = price.off_peak;
  if (!off || !inWindows(off.windows, at)) {
    const { off_peak: _unused, ...normal } = price;
    return normal;
  }
  const cached = off.cached_per_mtok ?? price.cached_per_mtok;
  const written = off.cache_write_per_mtok ?? price.cache_write_per_mtok;
  return {
    input_per_mtok: off.input_per_mtok,
    output_per_mtok: off.output_per_mtok,
    ...(cached !== undefined && { cached_per_mtok: cached }),
    ...(written !== undefined && { cache_write_per_mtok: written }),
  };
}

/**
 * List-price cost in USD at the time of the call (now unless said). Cache
 * writes cost the input price unless the model says otherwise.
 */
export function priceOf(m: ModelConfig | undefined, u: CallUsage, at: Date | number = Date.now()): number {
  if (!m) return 0;
  const p = ratesAt(m.price, at);
  const cached = Math.max(0, u.cachedTokens ?? 0);
  const written = Math.max(0, u.cacheWriteTokens ?? 0);
  const fresh = Math.max(0, u.inputTokens - cached - written);
  return (
    (fresh * p.input_per_mtok +
      cached * (p.cached_per_mtok ?? p.input_per_mtok) +
      written * (p.cache_write_per_mtok ?? p.input_per_mtok) +
      u.outputTokens * p.output_per_mtok) /
    1_000_000
  );
}

/**
 * Cache hits and writes from a raw `usage` object. With a provider's profile,
 * from the names that provider uses; without one, from every name any provider
 * is known to use (prompt_tokens_details.cached_tokens, prompt_cache_hit_tokens,
 * cache_read_input_tokens, a top-level cached_tokens, cache_write_tokens,
 * cache_creation_input_tokens...). A figure is absent when no name carried one.
 */
export function cacheFromRaw(
  usage: unknown,
  fields: { hit: readonly string[]; write: readonly string[] } = {
    hit: ALL_HIT_FIELDS,
    write: ALL_WRITE_FIELDS,
  },
): { hit?: number; write?: number } {
  if (!usage || typeof usage !== 'object') return {};
  const hit = firstNumber(usage, fields.hit);
  const write = firstNumber(usage, fields.write);
  return { ...(hit !== undefined && { hit }), ...(write !== undefined && { write }) };
}

/** Only the numbers of a raw usage object, flattened (`prompt_tokens_details.cached_tokens`), for one log line. */
export function usageNumbers(usage: unknown, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  if (!usage || typeof usage !== 'object') return out;
  for (const [k, v] of Object.entries(usage as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, usageNumbers(v, key));
  }
  return out;
}
