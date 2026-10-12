/**
 * ------------------------------------------------------------------
 *  Title    |  Waking from sleep
 *  Ref      |  ROADMAP.md track G (laptop sleep mid-run)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Notice when the computer slept, so what timed out while
 *           |  it did is picked up again at once: run leases renewed
 *           |  and runs resumed, the Claude bridge reconnected, the
 *           |  services checked.
 *  How      |  A heartbeat every 5 s. A beat that arrives much later
 *           |  than due (30 s past) means the process was suspended:
 *           |  each listener is called with how long the gap was. The
 *           |  clock and the timer are injectable, so tests drive it
 *           |  with a fake clock.
 *  Note     |  A long pause in the event loop looks the same; the
 *           |  listeners only reconnect and renew, so a false alarm
 *           |  costs nothing.
 * ------------------------------------------------------------------
 */

import { logFor } from '../obs/logger';

const log = logFor('wake');

export interface WakeOptions {
  everyMs?: number;
  /** How late a beat must be to count as a wake. */
  thresholdMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type WakeListener = (gapMs: number) => void | Promise<void>;

export class WakeWatch {
  private readonly everyMs: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<WakeListener>();
  private last: number | null = null;
  private timer: unknown = null;

  constructor(private readonly opts: WakeOptions = {}) {
    this.everyMs = opts.everyMs ?? 5_000;
    this.thresholdMs = opts.thresholdMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  onWake(fn: WakeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    const every = this.opts.setInterval ?? ((fn, ms) => setInterval(fn, ms).unref());
    this.timer = every(() => void this.beat(), this.everyMs);
  }

  stop(): void {
    if (!this.timer) return;
    (this.opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(this.timer);
    this.timer = null;
  }

  /** One heartbeat: the timer calls it, tests call it after moving a fake clock. Returns the gap on a wake. */
  async beat(): Promise<number | null> {
    const t = this.now();
    const last = this.last ?? t;
    this.last = t;
    const late = t - last - this.everyMs;
    if (late < this.thresholdMs) return null;
    const gap = t - last;
    log.info({ gap_ms: gap }, 'the computer was asleep: picking up where things left off');
    for (const fn of this.listeners) {
      try {
        await fn(gap);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'a wake listener failed');
      }
    }
    return gap;
  }
}
