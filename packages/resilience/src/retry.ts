/**
 * ------------------------------------------------------------------
 *  Title    |  Retry with backoff
 *  Ref      |  DESIGN.md §7.1
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Retry only what is worth retrying, as politely as the
 *           |  other side asks, and never past the caller's deadline.
 *  How      |  Exponential backoff with full jitter (AWS architecture
 *           |  blog formula): sleep = random(0, min(cap, base·factor^n)).
 *           |  A Retry-After on the error wins over the computed delay.
 * ------------------------------------------------------------------
 */

import { classify, type ErrorClass, RETRYABLE, retryAfterOf } from './classify';
import { abortReason, type Clock, systemClock } from './clock';
import { Deadline } from './deadline';

export interface RetryPolicy {
  baseMs: number;
  factor: number;
  capMs: number;
  /** Total attempts including the first. */
  maxAttempts: number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 250, factor: 2, capMs: 8000, maxAttempts: 4 };

export interface RetryOptions extends Partial<RetryPolicy> {
  clock?: Clock;
  /** Random source in [0,1). Injected for deterministic tests. */
  random?: () => number;
  deadline?: Deadline;
  signal?: AbortSignal;
  /** Override which errors are retried. Defaults to class ∈ RETRYABLE. */
  shouldRetry?: (err: unknown, cls: ErrorClass, attempt: number) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; errorClass: ErrorClass }) => void;
}

/** The delay before retry number `attempt` (1-based: the first retry is 1). */
export function backoffDelay(attempt: number, p: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(p.capMs, p.baseMs * p.factor ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export async function retry<T>(
  fn: (attempt: number, signal?: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const policy: RetryPolicy = {
    baseMs: opts.baseMs ?? DEFAULT_RETRY.baseMs,
    factor: opts.factor ?? DEFAULT_RETRY.factor,
    capMs: opts.capMs ?? DEFAULT_RETRY.capMs,
    maxAttempts: opts.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
  };
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? Math.random;
  const deadline = opts.deadline ?? Deadline.never(clock);

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    try {
      return await fn(attempt, opts.signal);
    } catch (err) {
      const cls = classify(err);
      const wanted = opts.shouldRetry ? opts.shouldRetry(err, cls, attempt) : RETRYABLE.has(cls);
      if (!wanted || attempt >= policy.maxAttempts || opts.signal?.aborted) throw err;

      const computed = backoffDelay(attempt, policy, random);
      const asked = retryAfterOf(err);
      const delayMs = asked !== undefined ? Math.max(asked, computed) : computed;
      // Sleeping past the deadline only to fail is worse than failing now.
      if (delayMs >= deadline.remaining()) throw err;

      opts.onRetry?.({ attempt, delayMs, error: err, errorClass: cls });
      await clock.sleep(delayMs, opts.signal);
    }
  }
}
