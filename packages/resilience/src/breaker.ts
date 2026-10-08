/**
 * ------------------------------------------------------------------
 *  Title    |  Circuit breaker
 *  Ref      |  DESIGN.md §7.1
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Stop hammering a target that is down, find out cheaply
 *           |  when it is back, and let the fallback chain move on in
 *           |  the meantime.
 *  How      |  closed → open when, over a rolling window, the failure
 *           |  rate passes a threshold with enough calls, or N calls
 *           |  in a row fail. open → half-open after a cooldown that
 *           |  doubles each time a probe fails (capped). half-open lets
 *           |  a limited number of probes through: success closes,
 *           |  failure reopens.
 *  Note     |  State sits behind BreakerStore so Core and Knowledge can
 *           |  share it through Postgres. MemoryBreakerStore is the
 *           |  single-process default.
 * ------------------------------------------------------------------
 */

import { classify, type ErrorClass } from './classify';
import { type Clock, systemClock } from './clock';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerPolicy {
  windowMs: number;
  failureRate: number;
  minCalls: number;
  consecutive: number;
  halfOpenAfterMs: number;
  maxHalfOpenAfterMs: number;
  halfOpenProbes: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = {
  windowMs: 60_000,
  failureRate: 0.5,
  minCalls: 8,
  consecutive: 5,
  halfOpenAfterMs: 30_000,
  maxHalfOpenAfterMs: 600_000,
  halfOpenProbes: 1,
};

export interface BreakerSnapshot {
  state: BreakerState;
  /** Outcome log inside the window: [timestampMs, ok] */
  calls: [number, boolean][];
  consecutiveFailures: number;
  openedAt: number | null;
  cooldownMs: number;
  probesInFlight: number;
}

export interface BreakerStore {
  get(key: string): Promise<BreakerSnapshot | undefined>;
  set(key: string, snap: BreakerSnapshot): Promise<void>;
}

export class MemoryBreakerStore implements BreakerStore {
  private m = new Map<string, BreakerSnapshot>();
  async get(key: string) {
    return this.m.get(key);
  }
  async set(key: string, snap: BreakerSnapshot) {
    this.m.set(key, snap);
  }
}

export class BreakerOpenError extends Error {
  readonly errorClass: ErrorClass = 'transient';
  constructor(
    readonly key: string,
    readonly retryInMs: number,
  ) {
    super(`Circuit for ${key} is open; next probe in ${Math.ceil(retryInMs / 1000)} s`);
    this.name = 'BreakerOpenError';
  }
}

export function freshSnapshot(policy: BreakerPolicy): BreakerSnapshot {
  return {
    state: 'closed',
    calls: [],
    consecutiveFailures: 0,
    openedAt: null,
    cooldownMs: policy.halfOpenAfterMs,
    probesInFlight: 0,
  };
}

/* ---- Pure transitions: tested directly ---------------------------------- */

/** May a call go through now? Returns the (possibly advanced) snapshot. */
export function admit(
  snap: BreakerSnapshot,
  now: number,
  p: BreakerPolicy,
): { allowed: boolean; snap: BreakerSnapshot; retryInMs: number } {
  if (snap.state === 'closed') return { allowed: true, snap, retryInMs: 0 };
  if (snap.state === 'open') {
    const elapsed = now - (snap.openedAt ?? now);
    if (elapsed < snap.cooldownMs) return { allowed: false, snap, retryInMs: snap.cooldownMs - elapsed };
    snap = { ...snap, state: 'half_open', probesInFlight: 0 };
  }
  // half-open
  if (snap.probesInFlight >= p.halfOpenProbes) return { allowed: false, snap, retryInMs: 1000 };
  return { allowed: true, snap: { ...snap, probesInFlight: snap.probesInFlight + 1 }, retryInMs: 0 };
}

export function record(snap: BreakerSnapshot, ok: boolean, now: number, p: BreakerPolicy): BreakerSnapshot {
  const calls = [...snap.calls.filter(([t]) => now - t < p.windowMs), [now, ok] as [number, boolean]];
  if (snap.state === 'half_open') {
    if (ok) return { ...freshSnapshot(p) };
    const cooldownMs = Math.min(p.maxHalfOpenAfterMs, snap.cooldownMs * 2);
    return {
      ...snap,
      state: 'open',
      openedAt: now,
      cooldownMs,
      probesInFlight: 0,
      calls,
      consecutiveFailures: snap.consecutiveFailures + 1,
    };
  }
  const consecutiveFailures = ok ? 0 : snap.consecutiveFailures + 1;
  const failures = calls.filter(([, k]) => !k).length;
  const rateTrips = calls.length >= p.minCalls && failures / calls.length >= p.failureRate;
  const streakTrips = consecutiveFailures >= p.consecutive;
  if (snap.state === 'closed' && !ok && (rateTrips || streakTrips)) {
    return {
      ...snap,
      state: 'open',
      openedAt: now,
      cooldownMs: p.halfOpenAfterMs,
      calls,
      consecutiveFailures,
      probesInFlight: 0,
    };
  }
  return { ...snap, calls, consecutiveFailures };
}

/* ---- The breaker --------------------------------------------------------- */

export interface BreakerOptions {
  policy?: Partial<BreakerPolicy>;
  store?: BreakerStore;
  clock?: Clock;
  /** Which failures count against the target. A refusal or a bad request is not the target being down. */
  countsAsFailure?: (err: unknown) => boolean;
  onStateChange?: (key: string, from: BreakerState, to: BreakerState) => void;
}

const defaultCounts = (err: unknown) => {
  const c = classify(err);
  return c === 'transient' || c === 'capacity' || c === 'bug';
};

export class CircuitBreaker {
  readonly policy: BreakerPolicy;
  private readonly store: BreakerStore;
  private readonly clock: Clock;
  private readonly counts: (err: unknown) => boolean;
  private readonly onChange: BreakerOptions['onStateChange'];

  constructor(opts: BreakerOptions = {}) {
    this.policy = { ...DEFAULT_BREAKER, ...opts.policy };
    this.store = opts.store ?? new MemoryBreakerStore();
    this.clock = opts.clock ?? systemClock;
    this.counts = opts.countsAsFailure ?? defaultCounts;
    this.onChange = opts.onStateChange;
  }

  async state(key: string): Promise<BreakerState> {
    return (await this.store.get(key))?.state ?? 'closed';
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = (await this.store.get(key)) ?? freshSnapshot(this.policy);
    const gate = admit(before, this.clock.now(), this.policy);
    await this.commit(key, before, gate.snap);
    if (!gate.allowed) throw new BreakerOpenError(key, gate.retryInMs);

    try {
      const out = await fn();
      await this.settle(key, true);
      return out;
    } catch (err) {
      if (this.counts(err)) await this.settle(key, false);
      else await this.settle(key, true, true);
      throw err;
    }
  }

  private async settle(key: string, ok: boolean, neutral = false) {
    const cur = (await this.store.get(key)) ?? freshSnapshot(this.policy);
    // A neutral outcome (e.g. a refusal) releases a half-open probe without judging the target.
    const next =
      neutral && cur.state === 'half_open'
        ? { ...cur, probesInFlight: Math.max(0, cur.probesInFlight - 1) }
        : record(cur, ok, this.clock.now(), this.policy);
    await this.commit(key, cur, next);
  }

  private async commit(key: string, from: BreakerSnapshot, to: BreakerSnapshot) {
    await this.store.set(key, to);
    if (from.state !== to.state) this.onChange?.(key, from.state, to.state);
  }
}
