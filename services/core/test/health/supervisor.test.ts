import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPERVISOR,
  initialState,
  onProbe,
  type ProbeResult,
  type ServiceState,
  startSupervisor,
} from '../../src/health/supervisor';

const fail: ProbeResult = { ok: false, error: 'connection refused' };
const ok: ProbeResult = { ok: true, latencyMs: 20 };
const p = DEFAULT_SUPERVISOR;

function run(results: ProbeResult[], canRestart = true, start = initialState('knowledge'), stepMs = 15_000) {
  let s: ServiceState = start;
  const actions: string[] = [];
  results.forEach((r, i) => {
    const out = onProbe(s, r, i * stepMs, p, canRestart);
    s = out.state;
    actions.push(out.action);
  });
  return { s, actions };
}

describe('supervisor policy', () => {
  it('is red as soon as a check fails, and restarts on the Nth failure', () => {
    const first = run([fail]);
    expect(first.s.status).toBe('down');
    expect(first.actions).toEqual(['none']);
    const { s, actions } = run([fail, fail, fail]);
    expect(actions).toEqual(['none', 'none', 'restart']);
    expect(s.status).toBe('restarting');
    expect(s.consecutiveFailures).toBe(0);
  });

  it('reports recovery once the service answers again', () => {
    const { s, actions } = run([fail, fail, fail, ok]);
    expect(actions.at(-1)).toBe('recovered');
    expect(s.status).toBe('ok');
  });

  it('stops restarting after a storm and raises needs-attention once', () => {
    const { s, actions } = run(Array(15).fill(fail));
    expect(actions.filter((a) => a === 'restart')).toHaveLength(p.maxRestarts);
    expect(actions.filter((a) => a === 'needs_attention')).toHaveLength(1);
    expect(s.status).toBe('down');
    expect(s.lastError).toBe('connection refused');
  });

  it('forgets restarts outside the storm window', () => {
    // one probe every 4 minutes: restarts age out of the 10-minute window
    const { actions } = run(Array(30).fill(fail), true, initialState('k'), 4 * 60_000);
    expect(actions.filter((a) => a === 'needs_attention')).toHaveLength(0);
  });

  it('goes straight to needs-attention when it cannot restart', () => {
    const { s, actions } = run([fail, fail, fail], false);
    expect(actions).toEqual(['none', 'none', 'needs_attention']);
    expect(s.status).toBe('down');
  });

  it('keeps the latency of the last good check', () => {
    const { s } = run([{ ok: true, latencyMs: 42 }]);
    expect(s.latencyMs).toBe(42);
  });

  it('flags slow answers as degraded', () => {
    const out = onProbe(initialState('db'), { ok: true, latencyMs: p.degradedLatencyMs + 1 }, 0, p, true);
    expect(out.state.status).toBe('degraded');
  });
});

describe('supervisor loop', () => {
  const probe = (state: { ok: boolean }) => ({
    service: 'knowledge',
    remediation: 'Restart the Knowledge service.',
    check: async () => {
      if (!state.ok) throw new Error('connection refused');
    },
  });

  it('restarts through the adapter after the threshold, notifies, and recovers', async () => {
    const state = { ok: false };
    const restarted: string[] = [];
    const changes: string[] = [];
    const sup = startSupervisor([probe(state)], {
      intervalMs: 60_000,
      policy: { ...DEFAULT_SUPERVISOR, restartAfter: 2 },
      restart: {
        kind: 'process',
        canRestart: () => true,
        restart: async (s) => {
          restarted.push(s);
          state.ok = true;
        },
      },
      hooks: { onChange: (s, a) => void changes.push(`${s.status}:${a}`) },
    });
    try {
      await sup.checkNow();
      await sup.checkNow();
      expect(restarted).toEqual(['knowledge']);
      await sup.checkNow();
      expect(sup.snapshot()[0]?.status).toBe('ok');
      expect(changes).toContain('restarting:restart');
      expect(changes.at(-1)).toBe('ok:recovered');
    } finally {
      sup.stop();
    }
  });

  it('restarts on request and reports a restart that fails', async () => {
    const changes: string[] = [];
    const sup = startSupervisor([probe({ ok: true })], {
      intervalMs: 60_000,
      restart: {
        kind: 'process',
        canRestart: () => true,
        restart: async () => {
          throw new Error('the runner is gone');
        },
      },
      hooks: { onChange: (s, a) => void changes.push(`${s.status}:${a}`) },
    });
    try {
      const s = await sup.restartNow('knowledge');
      expect(s.status).toBe('down');
      expect(s.lastError).toContain('the runner is gone');
      expect(sup.remediation('knowledge')).toBe('Restart the Knowledge service.');
      await expect(sup.restartNow('nope')).rejects.toThrow();
    } finally {
      sup.stop();
    }
  });
});
