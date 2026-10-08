/**
 * ------------------------------------------------------------------
 *  Title    |  Deadlines and timeouts
 *  Ref      |  DESIGN.md §7.1
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Every external call has a budget, and child calls get
 *           |  what is left of the parent's, so retries can never run
 *           |  past the deadline the user is waiting on.
 * ------------------------------------------------------------------
 */

import { type Clock, systemClock } from './clock';

export class DeadlineExceededError extends Error {
  readonly errorClass = 'transient' as const;
  constructor(readonly budgetMs: number) {
    super(`Deadline of ${budgetMs} ms exceeded`);
    this.name = 'DeadlineExceededError';
  }
}

export class Deadline {
  readonly at: number;
  private readonly clock: Clock;

  private constructor(at: number, clock: Clock) {
    this.at = at;
    this.clock = clock;
  }

  static after(ms: number, clock: Clock = systemClock): Deadline {
    return new Deadline(clock.now() + ms, clock);
  }

  static never(clock: Clock = systemClock): Deadline {
    return new Deadline(Number.POSITIVE_INFINITY, clock);
  }

  remaining(): number {
    return Math.max(0, this.at - this.clock.now());
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  /** A child deadline: the sooner of the parent's and `ms` from now. */
  child(ms?: number): Deadline {
    if (ms === undefined) return new Deadline(this.at, this.clock);
    return new Deadline(Math.min(this.at, this.clock.now() + ms), this.clock);
  }
}

/**
 * Run `fn` with an AbortSignal that fires at the deadline (or `ms`, if
 * sooner). Rejects with DeadlineExceededError on expiry. An outer signal
 * is honoured too.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { ms?: number; deadline?: Deadline; signal?: AbortSignal; clock?: Clock } = {},
): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const deadline = (opts.deadline ?? Deadline.never(clock)).child(opts.ms);
  const budget = deadline.remaining();
  if (budget <= 0) throw new DeadlineExceededError(0);

  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onOuter, { once: true });

  const timer = Number.isFinite(budget)
    ? clock.sleep(budget, ctrl.signal).then(
        () => {
          const err = new DeadlineExceededError(budget);
          ctrl.abort(err);
          throw err;
        },
        () => new Promise<never>(() => {}),
      )
    : new Promise<never>(() => {});

  try {
    return await Promise.race([fn(ctrl.signal), timer]);
  } catch (err) {
    // If fn rejected because we aborted it at the deadline, report the deadline.
    if (ctrl.signal.reason instanceof DeadlineExceededError) throw ctrl.signal.reason;
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onOuter);
    if (!ctrl.signal.aborted) ctrl.abort(new DOMException('settled', 'AbortError'));
  }
}
