/**
 * ------------------------------------------------------------------
 *  Title    |  Bulkhead
 *  Ref      |  DESIGN.md §7.1
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Cap concurrent calls per target so one slow provider
 *           |  cannot drain the pool everyone else needs.
 *  How      |  A counting semaphore with a bounded FIFO queue. When the
 *           |  queue is full the call is rejected as `capacity`, which
 *           |  the fallback chain treats as "try the next target".
 * ------------------------------------------------------------------
 */

import { ClassifiedError } from './classify';
import { abortReason } from './clock';

export class BulkheadFullError extends ClassifiedError {
  constructor(readonly key: string) {
    super('capacity', `Too many concurrent calls to ${key}`);
    this.name = 'BulkheadFullError';
  }
}

export class Bulkhead {
  private active = 0;
  private queue: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(
    readonly key: string,
    readonly maxConcurrent: number,
    readonly maxQueue: number = 0,
  ) {
    if (maxConcurrent < 1) throw new RangeError('maxConcurrent must be ≥ 1');
  }

  get inFlight() {
    return this.active;
  }
  get queued() {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new BulkheadFullError(this.key));
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.queue.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(abortReason(signal));
          }
        },
        { once: true },
      );
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next)
      next.resolve(); // hand the slot over directly; active stays the same
    else this.active--;
  }
}
