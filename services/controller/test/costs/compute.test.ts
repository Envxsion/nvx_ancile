import { describe, expect, it } from 'vitest';
import { computeCosts, monthBounds, monthOf } from '../../src/costs/compute';

const d = (s: string) => new Date(s);
// October 2026 has 31 days = 744 hours.

describe('monthBounds', () => {
  it('is the UTC calendar month', () => {
    const { start, end } = monthBounds('2026-12');
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(monthOf(d('2026-10-07T23:59:00Z'))).toBe('2026-10');
    expect(() => monthBounds('2026-13')).toThrow();
  });
});

describe('computeCosts', () => {
  const node = {
    nodeId: 'n1',
    hourlyRate: 2,
    storageRateMonth: 31,
    createdAt: d('2026-09-01T00:00:00Z'),
    terminatedAt: null,
    runningNow: false,
  };

  it('sums hours inside the month, clipping intervals that cross its edges', () => {
    const s = computeCosts({
      month: '2026-10',
      now: d('2026-10-11T00:00:00Z'),
      cap: 100,
      nodes: [node],
      intervals: [
        {
          nodeId: 'n1',
          startedAt: d('2026-09-30T22:00:00Z'),
          endedAt: d('2026-10-01T02:00:00Z'),
          hourlyRate: 2,
        }, // 2h in Oct
        {
          nodeId: 'n1',
          startedAt: d('2026-10-05T10:00:00Z'),
          endedAt: d('2026-10-05T13:30:00Z'),
          hourlyRate: 3,
        }, // 3.5h @3
      ],
    });
    const n = s.nodes[0];
    expect(n?.hours_this_month).toBe(5.5);
    expect(n?.compute_cost).toBe(14.5);
    // 10 days of a 31-day month at $31/month storage = $10
    expect(n?.storage_cost).toBe(10);
    expect(s.total_to_date).toBe(24.5);
    expect(s.cap).toBe(100);
  });

  it('counts an open interval up to now and projects the current burn', () => {
    const s = computeCosts({
      month: '2026-10',
      now: d('2026-10-31T00:00:00Z'), // 24h left in the month
      cap: null,
      nodes: [{ ...node, runningNow: true, storageRateMonth: 0 }],
      intervals: [{ nodeId: 'n1', startedAt: d('2026-10-30T00:00:00Z'), endedAt: null, hourlyRate: 2 }],
    });
    expect(s.nodes[0]?.hours_this_month).toBe(24);
    expect(s.nodes[0]?.compute_cost).toBe(48);
    expect(s.nodes[0]?.projected_month_cost).toBe(96);
  });

  it('stops storage accruing at termination and projects nothing after it', () => {
    const s = computeCosts({
      month: '2026-10',
      now: d('2026-10-21T00:00:00Z'),
      cap: null,
      nodes: [{ ...node, createdAt: d('2026-10-01T00:00:00Z'), terminatedAt: d('2026-10-11T00:00:00Z') }],
      intervals: [],
    });
    expect(s.nodes[0]?.storage_cost).toBe(10);
    expect(s.nodes[0]?.projected_month_cost).toBe(10);
  });

  it('treats a past month as complete', () => {
    const s = computeCosts({
      month: '2026-09',
      now: d('2026-10-15T00:00:00Z'),
      cap: null,
      nodes: [{ ...node, storageRateMonth: 30 }],
      intervals: [],
    });
    expect(s.nodes[0]?.storage_cost).toBe(30);
    expect(s.nodes[0]?.projected_month_cost).toBe(30);
  });

  it('ignores other nodes intervals', () => {
    const s = computeCosts({
      month: '2026-10',
      now: d('2026-10-11T00:00:00Z'),
      cap: null,
      nodes: [{ ...node, storageRateMonth: 0 }],
      intervals: [
        {
          nodeId: 'other',
          startedAt: d('2026-10-02T00:00:00Z'),
          endedAt: d('2026-10-03T00:00:00Z'),
          hourlyRate: 9,
        },
      ],
    });
    expect(s.total_to_date).toBe(0);
  });
});
