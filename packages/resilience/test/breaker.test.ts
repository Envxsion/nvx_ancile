import { describe, expect, it } from 'vitest';
import {
  admit,
  BreakerOpenError,
  type BreakerSnapshot,
  CircuitBreaker,
  ClassifiedError,
  DEFAULT_BREAKER,
  freshSnapshot,
  instantClock,
  record,
} from '../src';

const p = DEFAULT_BREAKER;
const fail = () => Promise.reject(new ClassifiedError('transient', 'down', { status: 503 }));
const ok = () => Promise.resolve('ok');

describe('breaker transitions (pure)', () => {
  it('opens after N consecutive failures', () => {
    let s = freshSnapshot(p);
    for (let i = 0; i < p.consecutive - 1; i++) s = record(s, false, i, p);
    expect(s.state).toBe('closed');
    s = record(s, false, 10, p);
    expect(s.state).toBe('open');
  });

  it('opens on failure rate only once min calls are reached', () => {
    let s = freshSnapshot(p);
    // alternate ok/fail: never 5 in a row, but 50% rate
    for (let i = 0; i < p.minCalls - 1; i++) s = record(s, i % 2 === 0, i, p);
    expect(s.state).toBe('closed');
    s = record(s, false, 100, p);
    expect(s.state).toBe('open');
  });

  it('forgets calls outside the rolling window', () => {
    let s = freshSnapshot(p);
    for (let i = 0; i < 4; i++) s = record(s, false, 0, p);
    s = record(s, true, 1, p); // break the streak
    s = record(s, false, p.windowMs + 10, p);
    expect(s.calls.length).toBe(1);
    expect(s.state).toBe('closed');
  });

  it('half-opens after the cooldown, admits one probe, and doubles the cooldown on failure', () => {
    let s: BreakerSnapshot = { ...freshSnapshot(p), state: 'open', openedAt: 0 };
    expect(admit(s, p.halfOpenAfterMs - 1, p).allowed).toBe(false);
    const a = admit(s, p.halfOpenAfterMs, p);
    expect(a.allowed).toBe(true);
    expect(a.snap.state).toBe('half_open');
    expect(admit(a.snap, p.halfOpenAfterMs, p).allowed).toBe(false); // only one probe
    s = record(a.snap, false, p.halfOpenAfterMs, p);
    expect(s.state).toBe('open');
    expect(s.cooldownMs).toBe(p.halfOpenAfterMs * 2);
  });

  it('caps the doubled cooldown', () => {
    const s = { ...freshSnapshot(p), state: 'half_open' as const, cooldownMs: p.maxHalfOpenAfterMs };
    expect(record(s, false, 0, p).cooldownMs).toBe(p.maxHalfOpenAfterMs);
  });

  it('closes on a successful probe', () => {
    const s = { ...freshSnapshot(p), state: 'half_open' as const, probesInFlight: 1 };
    expect(record(s, true, 0, p).state).toBe('closed');
  });
});

describe('CircuitBreaker', () => {
  it('fails fast while open and reports state changes', async () => {
    const clock = instantClock();
    const changes: string[] = [];
    const b = new CircuitBreaker({
      clock,
      policy: { consecutive: 2 },
      onStateChange: (_k, f, t) => changes.push(`${f}>${t}`),
    });
    await expect(b.run('x', fail)).rejects.toThrow('down');
    await expect(b.run('x', fail)).rejects.toThrow('down');
    await expect(b.run('x', ok)).rejects.toBeInstanceOf(BreakerOpenError);
    await clock.sleep(p.halfOpenAfterMs);
    await expect(b.run('x', ok)).resolves.toBe('ok');
    expect(changes).toEqual(['closed>open', 'open>half_open', 'half_open>closed']);
  });

  it('does not count refusals against the target', async () => {
    const b = new CircuitBreaker({ clock: instantClock(), policy: { consecutive: 1 } });
    await expect(b.run('y', () => Promise.reject(new ClassifiedError('refusal', 'no')))).rejects.toThrow(
      'no',
    );
    expect(await b.state('y')).toBe('closed');
  });

  it('keeps keys independent', async () => {
    const b = new CircuitBreaker({ clock: instantClock(), policy: { consecutive: 1 } });
    await expect(b.run('a', fail)).rejects.toThrow();
    expect(await b.state('a')).toBe('open');
    expect(await b.state('b')).toBe('closed');
  });
});
