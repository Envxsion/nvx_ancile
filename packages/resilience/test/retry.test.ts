import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  ClassifiedError,
  DEFAULT_RETRY,
  Deadline,
  instantClock,
  parseRetryAfter,
  retry,
} from '../src';

const transient = () => new ClassifiedError('transient', 'boom', { status: 503 });

describe('backoffDelay', () => {
  it('stays within full-jitter bounds and respects the cap', () => {
    for (let a = 1; a <= 10; a++) {
      const max = Math.min(DEFAULT_RETRY.capMs, DEFAULT_RETRY.baseMs * 2 ** (a - 1));
      expect(backoffDelay(a, DEFAULT_RETRY, () => 0)).toBe(0);
      expect(backoffDelay(a, DEFAULT_RETRY, () => 0.999999)).toBeLessThan(max);
      expect(backoffDelay(a, DEFAULT_RETRY, () => 0.999999)).toBeGreaterThanOrEqual(max - 1);
    }
  });
});

describe('retry', () => {
  it('retries transient errors up to maxAttempts then throws', async () => {
    const clock = instantClock();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw transient();
        },
        { clock, random: () => 0.5 },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(4);
    expect(clock.sleeps).toEqual([125, 250, 500]);
  });

  it('does not retry permanent errors', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new ClassifiedError('permanent', 'bad key', { status: 401 });
        },
        { clock: instantClock() },
      ),
    ).rejects.toThrow('bad key');
    expect(calls).toBe(1);
  });

  it('honours Retry-After when it is longer than the computed delay', async () => {
    const clock = instantClock();
    let calls = 0;
    const out = await retry(
      async () => {
        if (++calls < 2) throw new ClassifiedError('transient', '429', { status: 429, retryAfterMs: 3000 });
        return 'ok';
      },
      { clock, random: () => 0 },
    );
    expect(out).toBe('ok');
    expect(clock.sleeps).toEqual([3000]);
  });

  it('gives up instead of sleeping past the deadline', async () => {
    const clock = instantClock();
    const deadline = Deadline.after(100, clock);
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new ClassifiedError('transient', 'slow', { retryAfterMs: 5000 });
        },
        { clock, deadline },
      ),
    ).rejects.toThrow('slow');
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('stops when the signal aborts', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('cancelled by user'));
    await expect(retry(async () => 'never', { signal: ctrl.signal })).rejects.toThrow('cancelled by user');
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('2', 0)).toBe(2000);
    const now = Date.parse('2026-10-07T00:00:00Z');
    expect(parseRetryAfter('Wed, 07 Oct 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('nonsense', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
