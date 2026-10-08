/**
 * ------------------------------------------------------------------
 *  Title    |  Composed call policy
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  The one-line way to call a target safely:
 *           |  bulkhead( breaker( retry( timeout( fn ) ) ) ).
 *  Note     |  Breaker sits outside retry so a retried-then-failed call
 *           |  counts once, not maxAttempts times.
 * ------------------------------------------------------------------
 */

import type { CircuitBreaker } from './breaker';
import type { Bulkhead } from './bulkhead';
import type { Clock } from './clock';
import { type Deadline, withTimeout } from './deadline';
import { type RetryOptions, retry } from './retry';

export interface CallPolicy {
  key: string;
  breaker?: CircuitBreaker;
  bulkhead?: Bulkhead;
  retry?: RetryOptions;
  timeoutMs?: number;
  deadline?: Deadline;
  clock?: Clock;
  signal?: AbortSignal;
}

export function guarded<T>(policy: CallPolicy, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timed = () =>
    withTimeout(fn, {
      ...(policy.timeoutMs !== undefined && { ms: policy.timeoutMs }),
      ...(policy.deadline && { deadline: policy.deadline }),
      ...(policy.signal && { signal: policy.signal }),
      ...(policy.clock && { clock: policy.clock }),
    });
  const retried = () =>
    retry(timed, {
      ...policy.retry,
      ...(policy.deadline && { deadline: policy.deadline }),
      ...(policy.signal && { signal: policy.signal }),
      ...(policy.clock && { clock: policy.clock }),
    });
  const broken = policy.breaker ? () => (policy.breaker as CircuitBreaker).run(policy.key, retried) : retried;
  return policy.bulkhead ? policy.bulkhead.run(broken, policy.signal) : broken();
}
