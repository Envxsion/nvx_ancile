/**
 * ------------------------------------------------------------------
 *  Title    |  Health routes and record
 *  Ref      |  DESIGN.md §7.4 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the health page reads and does: every service with
 *           |  its state, last error, restarts and fix; Restart on any
 *           |  service the adapter can bring back. Each change is also
 *           |  written to core.service_health, so "what happened while
 *           |  I was away" survives a Core restart.
 * ------------------------------------------------------------------
 */

import { AncileError, type SystemHealth } from '@nvx/contracts';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../app';
import { notFound } from '../obs/errors';
import type { ServiceState, Supervisor } from './supervisor';

export function systemHealthOf(
  sup: Pick<Supervisor, 'snapshot' | 'remediation' | 'canRestart' | 'adapter'>,
  opts: { intervalS: number; restartAfter: number },
): SystemHealth {
  return {
    services: sup.snapshot().map((s) => ({
      service: s.service,
      status: s.status,
      consecutive_failures: s.consecutiveFailures,
      last_ok_at: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null,
      last_error: s.lastError,
      needs_attention: s.attention,
      remediation: s.status === 'ok' ? null : sup.remediation(s.service),
      restarts: s.restarts.map((t) => new Date(t).toISOString()),
      latency_ms: s.latencyMs,
      restartable: sup.canRestart(s.service),
    })),
    restart_adapter: sup.adapter,
    interval_s: opts.intervalS,
    restart_after: opts.restartAfter,
  };
}

export function healthRoutes(deps: { supervisor: () => Supervisor | null }) {
  const r = new Hono<AppEnv>();
  r.post('/system/services/:name/restart', async (c) => {
    const sup = deps.supervisor();
    const name = c.req.param('name');
    if (!sup?.snapshot().some((s) => s.service === name)) throw notFound('That service');
    if (!sup.canRestart(name))
      throw new AncileError({
        code: 'health.cannot_restart',
        title: `${name} can't be restarted from here`,
        hint:
          sup.adapter === 'none'
            ? 'Automatic restart is off. Start NVX Ancile with `pnpm start`, or set ANCILE_RESTART_ADAPTER.'
            : `${sup.remediation(name) ?? 'Restart it yourself.'}`,
        status: 422,
        errorClass: 'permanent',
      });
    const state = await sup.restartNow(name);
    return c.json({ service: name, status: state.status, last_error: state.lastError });
  });
  return r;
}

/** core.service_health: the last known state of each service. */
export async function recordHealth(sql: Sql, s: ServiceState, remediation: string | null): Promise<void> {
  await sql`
    insert into core.service_health (service, status, consecutive_failures, last_ok_at, last_error, restarts,
                                     needs_attention, remediation, updated_at)
    values (${s.service}, ${s.status}, ${s.consecutiveFailures},
            ${s.lastOkAt ? new Date(s.lastOkAt) : null},
            ${s.lastError ? sql.json({ message: s.lastError }) : null},
            ${sql.json(s.restarts.map((t) => new Date(t).toISOString()))},
            ${s.attention}, ${remediation}, now())
    on conflict (service) do update set
      status = excluded.status, consecutive_failures = excluded.consecutive_failures,
      last_ok_at = coalesce(excluded.last_ok_at, core.service_health.last_ok_at),
      last_error = coalesce(excluded.last_error, core.service_health.last_error),
      restarts = excluded.restarts, needs_attention = excluded.needs_attention,
      remediation = excluded.remediation, updated_at = now()`;
}
