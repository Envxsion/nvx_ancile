/**
 * ------------------------------------------------------------------
 *  Title    |  Fallback chains
 *  Ref      |  DESIGN.md §7.2
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Try each target in order until one answers, and keep an
 *           |  honest record of every attempt for the "why" view.
 *  How      |  Each target runs through its own policy (the caller wraps
 *           |  retry + breaker + bulkhead inside `call`). The chain moves
 *           |  on only for classes in FALLBACKABLE; a context overflow
 *           |  or our own bug stops it, because another model will not
 *           |  fix either.
 * ------------------------------------------------------------------
 */

import type { Attempt } from '@nvx/contracts';
import { classify, type ErrorClass, FALLBACKABLE } from './classify';
import { abortReason, type Clock, systemClock } from './clock';

export class ChainExhaustedError extends Error {
  readonly errorClass: ErrorClass;
  constructor(
    readonly attempts: Attempt[],
    readonly lastError: unknown,
  ) {
    super(`All ${attempts.length} targets failed`, { cause: lastError });
    this.name = 'ChainExhaustedError';
    this.errorClass = attempts.at(-1)?.class ?? 'bug';
  }
}

export interface FallbackResult<T> {
  value: T;
  target: string;
  attempts: Attempt[];
}

export interface FallbackOptions {
  clock?: Clock;
  signal?: AbortSignal;
  /** Override which classes move on to the next target. */
  shouldFallback?: (cls: ErrorClass, err: unknown) => boolean;
  onFallback?: (info: { from: string; to: string; errorClass: ErrorClass; error: unknown }) => void;
  statusOf?: (err: unknown) => number | undefined;
}

const statusDefault = (err: unknown) => {
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
};

export async function runChain<T>(
  targets: readonly string[],
  call: (target: string, index: number) => Promise<T>,
  opts: FallbackOptions = {},
): Promise<FallbackResult<T>> {
  if (targets.length === 0) throw new RangeError('Fallback chain is empty');
  const clock = opts.clock ?? systemClock;
  const shouldFallback = opts.shouldFallback ?? ((cls: ErrorClass) => FALLBACKABLE.has(cls));
  const statusOf = opts.statusOf ?? statusDefault;
  const attempts: Attempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i] as string;
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    const started = clock.now();
    try {
      const value = await call(target, i);
      attempts.push({ target, ms: clock.now() - started });
      return { value, target, attempts };
    } catch (err) {
      lastError = err;
      const cls = classify(err);
      const status = statusOf(err);
      const attempt: Attempt = {
        target,
        class: cls,
        ms: clock.now() - started,
        note: err instanceof Error ? err.message : String(err),
      };
      if (status !== undefined) attempt.status = status;
      attempts.push(attempt);
      const next = targets[i + 1];
      if (next === undefined || !shouldFallback(cls, err)) break;
      opts.onFallback?.({ from: target, to: next, errorClass: cls, error: err });
    }
  }
  throw new ChainExhaustedError(attempts, lastError);
}
