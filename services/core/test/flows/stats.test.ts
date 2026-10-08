/**
 * Node stats for the flow editor's badges: typical and slow times and
 * the mean cost, from the steps recorded on a flow's recent answers.
 */
import { describe, expect, it } from 'vitest';
import { statsFromSteps } from '../../src/flows/store';

describe('flow node stats', () => {
  it('counts real runs only, and reports median, 95th percentile and mean cost', () => {
    const answers = [
      [
        { node_id: 'router', status: 'done', ms: 400, cost_usd: 0.001 },
        { node_id: 'coder', status: 'done', ms: 2_000, cost_usd: 0.01 },
      ],
      [
        { node_id: 'router', status: 'done', ms: 600, cost_usd: 0.001 },
        { node_id: 'coder', status: 'pinned', ms: 0, cost_usd: 0 },
      ],
      [
        { node_id: 'router', status: 'done', ms: 500, cost_usd: 0.001 },
        { node_id: 'coder', status: 'failed', ms: 9_000, cost_usd: 0.002 },
      ],
    ];
    const s = statsFromSteps(answers);
    expect(s.router).toEqual({ runs: 3, p50_ms: 500, p95_ms: 600, avg_cost_usd: 0.001 });
    expect(s.coder?.runs).toBe(2);
    expect(s.coder?.p95_ms).toBe(9_000);
    expect(s.coder?.avg_cost_usd).toBeCloseTo(0.006);
  });

  it('is empty for a flow that has not answered yet', () => {
    expect(statsFromSteps([])).toEqual({});
  });
});
