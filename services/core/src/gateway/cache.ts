/**
 * ------------------------------------------------------------------
 *  Title    |  Per-provider cache settings
 *  Ref      |  ROADMAP.md CA5, CA12 · docs/prompt-caching.md · gateway/profiles.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Request bytes that start the same way only hit a
 *           |  provider's cache if the provider is told how: Anthropic
 *           |  needs markers, OpenAI and Mistral a cache key, xAI a
 *           |  conversation id, OpenRouter a served provider that does
 *           |  not move. This is where each provider's settings are
 *           |  worked out, as pure functions of the request, so the
 *           |  same request always carries the same bytes.
 *  How      |  `cacheKey` is a hash of thread, branch, epoch and shard
 *           |  (never random). `anthropicBreakpoints` picks at most four
 *           |  markers (tools and rules, end of the snapshot, the last
 *           |  two messages), skipping any whose prefix is under the
 *           |  model's minimum. `cacheExtras` gives the options and
 *           |  headers for every other provider. `PinBook` remembers the
 *           |  OpenRouter provider that served a warm call. `warmWindow`
 *           |  says how long a cache lasts, for the model picker.
 *  Note     |  Minimums and lifetimes come from providers' docs
 *           |  (research 16-17 Oct 2026). A figure marked assumed is a
 *           |  lower bound, not a published number. Kimi's TTL option
 *           |  costs extra on writes, so it waits for CA11.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import type { ModelConfig } from '@nvx/contracts';
import { profileFor } from './profiles';
import type { CacheScope } from './types';

/* ---- The key ------------------------------------------------------------ */

/**
 * The one id every provider's cache setting is made from: prompt_cache_key,
 * x-grok-conv-id, session_id. The same for every turn of a branch in an epoch;
 * different between branches, epochs and shards (Beam members, judges).
 */
export function cacheKey(s: CacheScope): string {
  const h = createHash('sha256')
    .update([s.threadId, s.branch, s.epochId, s.shard ?? ''].join('\n'))
    .digest('hex');
  return `nvx-${h.slice(0, 32)}`;
}

/* ---- Anthropic breakpoints ---------------------------------------------- */

/** Anthropic allows four markers on a request. */
export const MAX_BREAKPOINTS = 4;

/**
 * The shortest prefix Anthropic caches, by model (research 16 Oct 2026): a
 * marker on a shorter one is silently ignored and wastes one of the four.
 * A model not listed gets the strictest figure, 4096.
 */
export function anthropicMinTokens(providerModel: string): number {
  const id = providerModel.toLowerCase();
  if (/fable|mythos/.test(id)) return 512;
  if (/(opus|sonnet|haiku)-5-5/.test(id)) return 512;
  if (/opus-5(?![\d])/.test(id)) return 512;
  if (/opus-4-[56](?!\d)|haiku-4-5/.test(id)) return 4096;
  if (/opus-4-7|haiku-3-5/.test(id)) return 2048;
  if (/sonnet-5|sonnet-4|opus-4-8|opus-4-1|opus-4(?![\d-])/.test(id)) return 1024;
  return profileFor('anthropic').cache.minTokens ?? 4096;
}

export interface BreakpointInput {
  /** Tokens the tools take (0: none declared). */
  toolsTokens: number;
  /** Tokens of each system block: [rules, snapshot] when split, else [whole]. */
  system: number[];
  /** Tokens of each message, in order. */
  messages: number[];
  min: number;
}

export interface BreakpointPlan {
  /** The last tool carries a marker. */
  tools: boolean;
  /** Indexes of system blocks that carry one. */
  system: number[];
  /** Indexes of messages that carry one. */
  messages: number[];
}

/**
 * Where the markers go. After tools and rules, and at the end of the snapshot
 * (the two ends of what an epoch freezes); with no snapshot split, on the tools
 * and the system prompt. Then rolling on the last two messages, so the next turn
 * finds this turn's marker inside Anthropic's 20-block lookback. A marker whose
 * prefix is under the model's minimum is left out: it would cache nothing.
 */
export function anthropicBreakpoints(i: BreakpointInput): BreakpointPlan {
  const plan: BreakpointPlan = { tools: false, system: [], messages: [] };
  let cum = i.toolsTokens;
  const split = i.system.length > 1;
  if (!split && i.toolsTokens >= i.min) plan.tools = true;
  i.system.forEach((t, k) => {
    cum += t;
    if (cum >= i.min) plan.system.push(k);
  });
  // Cumulative tokens before each message.
  let before = cum;
  const prefix = i.messages.map((t) => {
    before += t;
    return before;
  });
  for (const k of [i.messages.length - 2, i.messages.length - 1]) {
    if (k >= 0 && (prefix[k] ?? 0) >= i.min) plan.messages.push(k);
  }
  // Never more than four, keeping the latest (the earliest are the cheapest to lose).
  let over = (plan.tools ? 1 : 0) + plan.system.length + plan.messages.length - MAX_BREAKPOINTS;
  if (over > 0 && plan.tools) {
    plan.tools = false;
    over -= 1;
  }
  while (over-- > 0) plan.system.shift();
  return plan;
}

/** The marker itself: byte-for-byte the same every time, five-minute lifetime. */
export const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

/* ---- Every other provider ----------------------------------------------- */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface CacheExtras {
  /** Merged into the call's providerOptions, by provider name. */
  options: Record<string, Record<string, Json>>;
  headers: Record<string, string>;
}

/**
 * The cache settings of a call that is not Anthropic's. OpenAI and Mistral get a
 * prompt_cache_key; providers with a routing header (xAI's x-grok-conv-id,
 * x-session-affinity) get it; OpenRouter gets a session_id, middle-out
 * transforms off, and (for Anthropic models) automatic cache control. Nothing
 * is sent without a scope.
 */
export function cacheExtras(
  m: Pick<ModelConfig, 'provider' | 'via' | 'provider_model'>,
  scope: CacheScope | undefined,
): CacheExtras {
  const out: CacheExtras = { options: {}, headers: {} };
  if (!scope || m.via === 'controller') return out;
  const key = cacheKey(scope);
  const profile = profileFor(m.provider);
  if (m.provider === 'openai') out.options.openai = { promptCacheKey: key };
  else if (m.provider === 'mistral') out.options.mistral = { prompt_cache_key: key };
  else if (m.provider === 'openrouter') {
    out.options.openrouter = {
      session_id: key,
      // Middle-out squeezing rewrites the prompt when it is long, so no two calls start alike.
      transforms: [],
      // Top-level cache_control is OpenRouter's automatic caching for Claude (openrouter.ai/docs/features/prompt-caching).
      ...(m.provider_model.startsWith('anthropic/') && { cache_control: { type: 'ephemeral' } }),
    };
  }
  if (profile.cache.routingHeader) out.headers[profile.cache.routingHeader] = key;
  return out;
}

/* ---- OpenRouter: the provider that served a warm call -------------------- */

export interface Pin {
  /** The upstream that served the last cached call. */
  provider: string;
  /** The routing chosen when it warmed, reused as it was so the choice is not recomputed per call. */
  routing: { provider: Record<string, unknown>; max_tokens: number | null } | null;
  at: number;
}

/**
 * OpenRouter caches per upstream. Once a call has written or read the cache, the
 * next ones go to the same upstream with fallbacks off, with the routing that
 * warmed it. The entry lapses with the cache.
 */
export class PinBook {
  private readonly pins = new Map<string, Pin>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 10 * 60_000,
  ) {}

  get(key: string): Pin | undefined {
    const p = this.pins.get(key);
    if (!p) return undefined;
    if (this.now() - p.at > this.windowMs) {
      this.pins.delete(key);
      return undefined;
    }
    return p;
  }

  set(key: string, pin: Omit<Pin, 'at'>): void {
    this.pins.set(key, { ...pin, at: this.now() });
    // Bounded: a long-running Core forgets threads it has not heard from.
    if (this.pins.size > 500) {
      const oldest = [...this.pins.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.pins.delete(oldest[0]);
    }
  }

  drop(key: string): void {
    this.pins.delete(key);
  }
}

/** The provider object of a pinned call: the routing that warmed it, narrowed to the one upstream. */
export function pinnedProvider(base: Record<string, unknown> | undefined, upstream: string) {
  return { ...(base ?? {}), order: [upstream], only: [upstream], allow_fallbacks: false };
}

/* ---- How long a cache lasts ---------------------------------------------- */

export interface WarmWindow {
  ms: number;
  /** A lower bound, not a published lifetime. */
  assumed: boolean;
}

const MINUTE = 60_000;

/** Lifetimes the profiles do not carry. DeepSeek: "within a few hours to a few days"; one hour is the safe side. */
const WARM_OVERRIDES: Record<string, WarmWindow> = {
  deepseek: { ms: 60 * MINUTE, assumed: true },
};

function ttlMs(t: string): number | null {
  if (t === 'in_memory') return 5 * MINUTE;
  const m = /^(\d+)\s*(m|h)$/.exec(t);
  return m ? Number(m[1]) * (m[2] === 'h' ? 60 * MINUTE : MINUTE) : null;
}

/**
 * How long a call keeps this thread's start cached on a provider: the shortest
 * lifetime its profile lists (Anthropic five minutes, which is what is asked
 * for; OpenAI's in-memory cache is 5 to 10 minutes of quiet, so five). A
 * provider that lists none gets five minutes, marked assumed.
 */
export function warmWindow(provider: string): WarmWindow {
  const over = WARM_OVERRIDES[provider];
  if (over) return over;
  const profile = profileFor(provider);
  const all = profile.cache.ttl.map(ttlMs).filter((n): n is number => n !== null);
  if (all.length) return { ms: Math.min(...all), assumed: !profile.cache.confirmed };
  return { ms: 5 * MINUTE, assumed: true };
}
