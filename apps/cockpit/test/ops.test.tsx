/**
 * Phase 5 admin screens: the small pure helpers, and the self-check ring.
 */
import { describe, expect, it } from 'vitest';
import { duration, until } from '../src/ops/common';
import { formatKey } from '../src/ops/LicenceScreen';

describe('ops helpers', () => {
  it('says durations the way a person would', () => {
    expect(duration(null)).toBe('—');
    expect(duration(0.4)).toBe('<1 ms');
    expect(duration(340)).toBe('340 ms');
    expect(duration(4_200)).toBe('4.2 s');
    expect(duration(42_000)).toBe('42 s');
    expect(duration(190_000)).toBe('3 min 10 s');
    expect(duration(120_000)).toBe('2 min');
  });

  it('counts down to the next run', () => {
    const now = Date.parse('2026-10-08T10:00:00');
    expect(until(null, now)).toBe('Not scheduled');
    expect(until('2026-10-08T09:59:00', now)).toBe('Due now');
    expect(until(new Date(now + 30_000).toISOString(), now)).toBe('In 30 s');
    expect(until(new Date(now + 4 * 60_000).toISOString(), now)).toBe('In 4 min');
    expect(until(new Date('2026-10-08T15:30:00').toISOString(), now)).toBe('Today at 15:30');
    expect(until(new Date('2026-10-09T03:00:00').toISOString(), now)).toBe('Tomorrow at 03:00');
  });

  it('formats a licence key as you type and leaves tokens alone', () => {
    expect(formatKey('nvxabcd')).toBe('NVX-ABCD');
    expect(formatKey('nvx-abcd-efgh-jk23-extra')).toBe('NVX-ABCD-EFGH-JK23');
    expect(formatKey('abcdefgh')).toBe('NVX-ABCD-EFGH');
    const token = `${'a'.repeat(50)}.${'b'.repeat(60)}`;
    expect(formatKey(token)).toBe(token);
  });
});
