/**
 * ------------------------------------------------------------------
 *  Title    |  Cache state of a thread
 *  Ref      |  ROADMAP.md CA12 · docs/prompt-caching.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Which models have this thread's start cached right now,
 *           |  and what moving to another model would cost, so the model
 *           |  picker can say so before a person switches.
 *  How      |  GET /threads/:id/cache-state, built from the per-call
 *           |  usage each answer stores and each provider's cache
 *           |  lifetime. ?candidate=<model id> adds the answer for one
 *           |  model the thread has not used.
 *  Note     |  Estimates: a cache can go cold early, and a provider that
 *           |  reports no cache figures is guessed from the last call
 *           |  (`reported: false`).
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const CacheStateItem = z.object({
  /** The concrete model id (never an alias). */
  model_id: z.string(),
  provider: z.string(),
  /** When this thread's start stops being cached on this model (ISO), or null when it is cold now. */
  warm_until: z.string().nullable(),
  /** Tokens the next call would read from cache if warm. */
  prefix_tokens: z.number().int().nonnegative(),
  /** What reading prefix_tokens again at the fresh input rate costs on this model now (off-peak prices at now). Null on a plan, or when the model is gone. */
  cold_cost_usd: z.number().nonnegative().nullable(),
  /** False when the provider reports no cache figures: warm and prefix_tokens are then guessed from the last call. */
  reported: z.boolean(),
  /** The model is billed to a plan (no per-token cost). */
  plan: z.boolean().optional(),
  /** The model runs on your own machine or network: no cost, only time. */
  local: z.boolean().optional(),
  /** The cache lifetime used is a guess, not a published figure. */
  ttl_assumed: z.boolean().optional(),
});
export type CacheStateItem = z.infer<typeof CacheStateItem>;

export const CacheCandidate = z.object({
  model_id: z.string(),
  /** This thread's start is cached on the model now. */
  warm: z.boolean(),
  /** Tokens the model would read: warm, from cache; cold, all fresh. */
  prefix_tokens: z.number().int().nonnegative(),
  /** What reading the whole prefix fresh would cost (null on a plan). */
  cold_cost_usd: z.number().nonnegative().nullable(),
  plan: z.boolean().optional(),
  local: z.boolean().optional(),
});
export type CacheCandidate = z.infer<typeof CacheCandidate>;

export const CacheState = z.object({
  items: z.array(CacheStateItem),
  /** An estimate of the thread's current start, in tokens. */
  thread_tokens: z.number().int().nonnegative(),
  candidate: CacheCandidate.optional(),
});
export type CacheState = z.infer<typeof CacheState>;

export const CacheStateQuery = z.object({
  candidate: z.string().min(1).max(200).optional(),
});
