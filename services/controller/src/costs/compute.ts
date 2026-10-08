/**
 * ------------------------------------------------------------------
 *  Title    |  Cost tracking
 *  Ref      |  DESIGN.md §3.3 (usage_intervals), contracts CostSummary
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Hourly rate, hours used this month, compute cost,
 *           |  storage cost and a projected month total, per node and
 *           |  overall, computed from usage intervals.
 *  How      |  Pure functions over intervals and a clock. Months are
 *           |  UTC calendar months. An open interval (node running now)
 *           |  counts up to `now`. Storage accrues for every day the
 *           |  node exists this month, running or stopped, because
 *           |  providers bill volumes while a pod is stopped.
 *           |  Projection = to-date + current burn × hours remaining,
 *           |  where burn is the rate of nodes running right now: the
 *           |  honest answer to "what if I leave things as they are".
 * ------------------------------------------------------------------
 */

import type { CostSummary } from '@nvx/contracts/controller';

export interface UsageInterval {
  nodeId: string;
  startedAt: Date;
  endedAt: Date | null;
  hourlyRate: number;
}

export interface NodeCostInput {
  nodeId: string;
  hourlyRate: number;
  storageRateMonth: number;
  createdAt: Date;
  terminatedAt: Date | null;
  runningNow: boolean;
}

const HOUR = 3_600_000;

export function monthBounds(month: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`month must be YYYY-MM, got ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) throw new Error(`invalid month ${month}`);
  return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
}

export function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function computeCosts(input: {
  month: string;
  now: Date;
  nodes: NodeCostInput[];
  intervals: UsageInterval[];
  cap: number | null;
}): CostSummary {
  const { start, end } = monthBounds(input.month);
  const now = input.now.getTime();
  // Everything "to date" is clipped to now; a past month is complete.
  const windowEnd = Math.min(end.getTime(), now);
  const windowStart = start.getTime();
  const monthMs = end.getTime() - windowStart;
  const remainingHours = Math.max(0, end.getTime() - Math.max(now, windowStart)) / HOUR;

  const nodes = input.nodes.map((node) => {
    let computeMs = 0;
    let computeCost = 0;
    for (const iv of input.intervals) {
      if (iv.nodeId !== node.nodeId) continue;
      const ivEnd = iv.endedAt ? iv.endedAt.getTime() : now;
      const ms = overlapMs(iv.startedAt.getTime(), ivEnd, windowStart, windowEnd);
      computeMs += ms;
      computeCost += (ms / HOUR) * iv.hourlyRate;
    }
    const existsFrom = Math.max(node.createdAt.getTime(), windowStart);
    const existsTo = Math.min(
      node.terminatedAt ? node.terminatedAt.getTime() : Number.POSITIVE_INFINITY,
      windowEnd,
    );
    const storageCost = (Math.max(0, existsTo - existsFrom) / monthMs) * node.storageRateMonth;

    const alive = !node.terminatedAt || node.terminatedAt.getTime() > now;
    const futureStorageMs = alive ? Math.max(0, end.getTime() - Math.max(now, existsFrom)) : 0;
    const projected =
      computeCost +
      (node.runningNow && alive ? node.hourlyRate * remainingHours : 0) +
      storageCost +
      (futureStorageMs / monthMs) * node.storageRateMonth;

    return {
      node_id: node.nodeId,
      hourly_rate: node.hourlyRate,
      hours_this_month: round3(computeMs / HOUR),
      compute_cost: round2(computeCost),
      storage_cost: round2(storageCost),
      projected_month_cost: round2(projected),
    };
  });

  const total = nodes.reduce((s, n) => s + n.compute_cost + n.storage_cost, 0);
  const projectedTotal = nodes.reduce((s, n) => s + n.projected_month_cost, 0);
  return {
    month: input.month,
    nodes,
    total_to_date: round2(total),
    projected_total: round2(projectedTotal),
    cap: input.cap,
  };
}
