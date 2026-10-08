/**
 * ------------------------------------------------------------------
 *  Title    |  Clock
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Time and sleep behind an interface, so every policy in
 *           |  this package can be tested deterministically.
 *  How      |  systemClock for production; ManualClock in tests, where
 *           |  sleep() resolves when advance() passes its deadline.
 * ------------------------------------------------------------------
 */

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal));
      const t = setTimeout(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      const onAbort = () => {
        clearTimeout(t);
        reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  private t: number;
  private waiters: { at: number; resolve: () => void }[] = [];
  /** Every sleep duration requested, in order. Handy for asserting backoff. */
  readonly sleeps: number[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const w = { at: this.t + Math.max(0, ms), resolve };
      this.waiters.push(w);
      signal?.addEventListener(
        'abort',
        () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(abortReason(signal));
        },
        { once: true },
      );
    });
  }

  /** Move time forward and wake every sleeper whose deadline has passed. */
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.waiters.filter((w) => w.at <= this.t);
    this.waiters = this.waiters.filter((w) => w.at > this.t);
    for (const w of due) w.resolve();
    // Let continuations run.
    await Promise.resolve();
  }
}

/** A sleep that never waits. For tests that only care about the decisions made. */
export function instantClock(start = 0): Clock & { sleeps: number[] } {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}
