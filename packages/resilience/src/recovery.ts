/**
 * ------------------------------------------------------------------
 *  Title    |  Recoveries: retries that worked
 *  Ref      |  roadmap WY1 (the answer's receipt)
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Let the caller learn that a call only succeeded after a
 *           |  retry, so an answer can say "the search timed out once
 *           |  and was retried" instead of hiding it.
 *  How      |  A caller wraps its work in `collectRecoveries(sink, fn)`.
 *           |  `retry` reports into the sink, if there is one, when a
 *           |  call succeeds after at least one retry. Nothing about
 *           |  retrying changes: no sink, no report.
 *  Note     |  Async-local, so concurrent turns never see each other's
 *           |  recoveries.
 * ------------------------------------------------------------------
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ErrorClass } from './classify';

export interface RecoveryInfo {
  /** Attempts in all, the successful one included. */
  attempts: number;
  /** Time spent waiting between attempts, in ms. */
  waitedMs: number;
  /** The class of the last failure that was retried. */
  errorClass: ErrorClass;
  /** The last failure that was retried. */
  error: unknown;
}

export type RecoverySink = (info: RecoveryInfo) => void;

const store = new AsyncLocalStorage<RecoverySink>();

/** Run `fn`; every retry inside it that ended well is reported to `sink`. */
export function collectRecoveries<T>(sink: RecoverySink, fn: () => T): T {
  return store.run(sink, fn);
}

/** Called by `retry` when a call succeeded after `attempts - 1` retries. */
export function reportRecovery(info: RecoveryInfo): void {
  const sink = store.getStore();
  if (!sink) return;
  try {
    sink(info);
  } catch {
    // A recorder must never break the call it watches.
  }
}
