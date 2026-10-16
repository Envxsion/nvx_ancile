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

import type { ModelConfig } from '@nvx/contracts';

export interface CallUsage {
  /** Every prompt token, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens read from the provider's cache. */
  cachedTokens?: number;
  /** Prompt tokens written to the provider's cache (Anthropic, some OpenRouter routes). */
  cacheWriteTokens?: number;
}

/** List-price cost in USD. Cache writes cost the input price unless the model says otherwise. */
export function priceOf(m: ModelConfig | undefined, u: CallUsage): number {
  if (!m) return 0;
  const p = m.price;
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

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Cache hits and writes from an OpenAI-style raw `usage` object, under any of
 * the names providers use: prompt_tokens_details.cached_tokens (OpenAI,
 * OpenRouter), prompt_cache_hit_tokens (DeepSeek), cache_write_tokens and
 * cache_creation_input_tokens (OpenRouter passing Anthropic through).
 */
export function cacheFromRaw(usage: unknown): { hit?: number; write?: number } {
  if (!usage || typeof usage !== 'object') return {};
  const u = usage as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const hit = num(details.cached_tokens) ?? num(u.prompt_cache_hit_tokens) ?? num(u.cache_read_input_tokens);
  const write =
    num(details.cache_write_tokens) ?? num(u.cache_write_tokens) ?? num(u.cache_creation_input_tokens);
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
