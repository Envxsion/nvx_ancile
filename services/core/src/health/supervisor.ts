/**
 * ------------------------------------------------------------------
 *  Title    |  Supervisor
 *  Ref      |  DESIGN.md §7.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Probe every dependency on an interval, restart what has
 *           |  failed N times in a row, and stop restarting something
 *           |  that keeps falling over: a restart storm is reported as
 *           |  "needs attention" with the last error and the fix.
 *  How      |  onProbe() is the whole policy, pure and tested. The loop
 *           |  just feeds it probe results and carries out the action.
 *           |  A service that stops answering is red at once; while
 *           |  anything is unwell the loop checks every 5 s, not every
 *           |  15, so a recovery shows quickly too.
 * ------------------------------------------------------------------
 */

import { logFor } from '../obs/logger';
import type { RestartAdapter } from './restart';

export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'restarting';

export interface ServiceState {
  service: string;
  status: ServiceStatus;
  consecutiveFailures: number;
  /** Restart timestamps (ms) inside the storm window. */
  restarts: number[];
  lastOkAt: number | null;
  lastError: string | null;
  /** True once "needs attention" was raised, so it is raised once. */
  attention: boolean;
  /** How long the last good check took. */
  latencyMs: number | null;
}

export interface SupervisorPolicy {
  restartAfter: number;
  maxRestarts: number;
  stormWindowMs: number;
  degradedLatencyMs: number;
}

export const DEFAULT_SUPERVISOR: SupervisorPolicy = {
  restartAfter: 3,
  maxRestarts: 3,
  stormWindowMs: 10 * 60_000,
  degradedLatencyMs: 2_000,
};

export type ProbeResult = { ok: true; latencyMs: number } | { ok: false; error: string };

export type SupervisorAction = 'none' | 'restart' | 'recovered' | 'needs_attention';

export function initialState(service: string): ServiceState {
  return {
    service,
    status: 'ok',
    consecutiveFailures: 0,
    restarts: [],
    lastOkAt: null,
    lastError: null,
    attention: false,
    latencyMs: null,
  };
}

export function onProbe(
  prev: ServiceState,
  result: ProbeResult,
  now: number,
  policy: SupervisorPolicy,
  canRestart: boolean,
): { state: ServiceState; action: SupervisorAction } {
  const restarts = prev.restarts.filter((t) => now - t < policy.stormWindowMs);

  if (result.ok) {
    const status: ServiceStatus = result.latencyMs > policy.degradedLatencyMs ? 'degraded' : 'ok';
    const wasBad = prev.status === 'down' || prev.status === 'restarting' || prev.consecutiveFailures > 0;
    return {
      state: {
        ...prev,
        status,
        consecutiveFailures: 0,
        restarts,
        lastOkAt: now,
        attention: false,
        latencyMs: result.latencyMs,
      },
      action: wasBad ? 'recovered' : 'none',
    };
  }

  const consecutiveFailures = prev.consecutiveFailures + 1;
  const base = { ...prev, consecutiveFailures, restarts, lastError: result.error };

  if (consecutiveFailures < policy.restartAfter) {
    return {
      // Not answering is red straight away; a restart in progress keeps its own state.
      state: { ...base, status: prev.status === 'restarting' ? 'restarting' : 'down' },
      action: 'none',
    };
  }
  if (canRestart && restarts.length < policy.maxRestarts) {
    // Give the restarted service a fresh count before judging it again.
    return {
      state: { ...base, status: 'restarting', consecutiveFailures: 0, restarts: [...restarts, now] },
      action: 'restart',
    };
  }
  const first = !prev.attention;
  return { state: { ...base, status: 'down', attention: true }, action: first ? 'needs_attention' : 'none' };
}

export interface Probe {
  service: string;
  check(signal: AbortSignal): Promise<void>;
  /** Plain-language fix shown when the service needs attention. */
  remediation: string;
}

export interface SupervisorHooks {
  onChange(state: ServiceState, action: SupervisorAction, remediation: string): void | Promise<void>;
}

export interface Supervisor {
  stop: () => void;
  snapshot: () => ServiceState[];
  /** "Check now" in the health dashboard: probe immediately, in the caller's trace. */
  checkNow: () => Promise<void>;
  /** Restart on request (the health page's Restart). */
  restartNow: (service: string) => Promise<ServiceState>;
  remediation: (service: string) => string | null;
  canRestart: (service: string) => boolean;
  readonly adapter: RestartAdapter['kind'];
}

/** While anything is unwell, check this often instead of the normal interval. */
export const FAST_RECHECK_MS = 5_000;

/** The loop. */
export function startSupervisor(
  probes: Probe[],
  opts: {
    intervalMs: number;
    policy?: SupervisorPolicy;
    restart: RestartAdapter;
    hooks: SupervisorHooks;
    timeoutMs?: number;
  },
): Supervisor {
  const log = logFor('supervisor');
  const policy = opts.policy ?? DEFAULT_SUPERVISOR;
  const states = new Map(probes.map((p) => [p.service, initialState(p.service)] as const));
  const byName = new Map(probes.map((p) => [p.service, p] as const));
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const doRestart = async (p: Probe, state: ServiceState) => {
    log.warn({ target: p.service, error: state.lastError }, 'restarting');
    try {
      await opts.restart.restart(p.service);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, target: p.service }, 'restart failed');
      const failed: ServiceState = { ...state, status: 'down', lastError: `Restart failed: ${message}` };
      states.set(p.service, failed);
      await opts.hooks.onChange(failed, 'none', p.remediation);
    }
  };

  const tick = async () => {
    await Promise.all(
      probes.map(async (p) => {
        const started = Date.now();
        let result: ProbeResult;
        try {
          await p.check(AbortSignal.timeout(opts.timeoutMs ?? 5_000));
          result = { ok: true, latencyMs: Date.now() - started };
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const prev = states.get(p.service) ?? initialState(p.service);
        const { state, action } = onProbe(
          prev,
          result,
          Date.now(),
          policy,
          opts.restart.canRestart(p.service),
        );
        states.set(p.service, state);
        if (action !== 'none' || state.status !== prev.status)
          await opts.hooks.onChange(state, action, p.remediation);
        if (action === 'restart') await doRestart(p, state);
      }),
    );
  };

  const loop = async () => {
    if (stopped) return;
    await tick().catch((err: unknown) => log.error({ err }, 'a health check round failed'));
    if (stopped) return;
    const unwell = [...states.values()].some((s) => s.status !== 'ok');
    timer = setTimeout(
      () => void loop(),
      unwell ? Math.min(FAST_RECHECK_MS, opts.intervalMs) : opts.intervalMs,
    );
  };
  void loop();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    snapshot: () => [...states.values()],
    checkNow: tick,
    restartNow: async (service) => {
      const p = byName.get(service);
      if (!p) throw new Error(`There is no service called ${service}.`);
      const prev = states.get(service) ?? initialState(service);
      const state: ServiceState = {
        ...prev,
        status: 'restarting',
        consecutiveFailures: 0,
        attention: false,
        restarts: [...prev.restarts, Date.now()],
      };
      states.set(service, state);
      await opts.hooks.onChange(state, 'restart', p.remediation);
      await doRestart(p, state);
      return states.get(service) ?? state;
    },
    remediation: (service) => byName.get(service)?.remediation ?? null,
    canRestart: (service) => byName.has(service) && opts.restart.canRestart(service),
    adapter: opts.restart.kind,
  };
}
