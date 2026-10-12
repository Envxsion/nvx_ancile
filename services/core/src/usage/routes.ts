/**
 * ------------------------------------------------------------------
 *  Title    |  Usage routes
 *  Ref      |  docs/api.md (Usage) · docs/claude-code.md (Usage)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What Settings → Usage reads: personal token and cost
 *           |  totals across every engine, and Claude Code's plan
 *           |  limits.
 *  How      |  GET /usage?range=day|week|month&tz=<IANA zone>
 *           |  (report.ts). GET /claude-code/plan-limits[?refresh=1]
 *           |  answers the latest figures; refresh asks Claude Code,
 *           |  no more than every 20 seconds (claudecode/plan-limits.ts).
 * ------------------------------------------------------------------
 */

import { UsageRange } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import type { PlanLimits } from '../claudecode/plan-limits';
import { badRequest } from '../obs/errors';
import { buildReport, type UsageSource, validZone, window } from './report';

export function usageRoutes(deps: {
  workspaceId: string;
  source: UsageSource;
  limits?: () => PlanLimits | null;
  now?: () => number;
}) {
  const r = new Hono<AppEnv>();
  const now = deps.now ?? Date.now;

  r.get('/usage', async (c) => {
    const range = UsageRange.safeParse(c.req.query('range') ?? 'day');
    if (!range.success) throw badRequest('range: day, week or month');
    const asked = c.req.query('tz');
    const tz = asked === undefined ? 'UTC' : validZone(asked);
    if (!tz) throw badRequest('tz: a time zone such as Europe/London');
    const w = window(range.data, tz, now());
    const rows = await deps.source.rows({
      workspaceId: deps.workspaceId,
      tz,
      bucket: w.bucket,
      from: w.from,
      to: w.to,
    });
    return c.json(buildReport(range.data, tz, w, rows));
  });

  r.get('/claude-code/plan-limits', async (c) => {
    const limits = deps.limits?.();
    if (!limits)
      return c.json({
        available: null,
        plan: null,
        windows: [],
        updated_at: null,
        source: null,
        can_refresh: false,
      });
    return c.json(await limits.get({ refresh: c.req.query('refresh') === '1' }));
  });

  return r;
}
