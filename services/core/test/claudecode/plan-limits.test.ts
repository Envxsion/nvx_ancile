/**
 * Claude Code plan limits: rate_limit_event figures are kept per window
 * and survive a restart; the experimental usage report is asked at most
 * every few minutes and, when missing, the event figures stand.
 */
import { describe, expect, it } from 'vitest';
import type { LiveBridge, LiveControlOp } from '../../src/claudecode/bridge-protocol';
import {
  PLAN_LIMITS_KEY,
  PlanLimits,
  USAGE_MIN_INTERVAL_MS,
  windowFromEvent,
} from '../../src/claudecode/plan-limits';
import { MemoryEventBus } from '../../src/events/bus';
import { MemorySettings } from '../../src/settings';

function fakeBridge(usage: () => unknown) {
  const calls: string[] = [];
  const bridge = {
    async open() {
      calls.push('open');
      return { handle: 'h_own' };
    },
    async close(h: string) {
      calls.push(`close:${h}`);
    },
    async control(h: string, op: LiveControlOp) {
      calls.push(`${op}@${h}`);
      const u = usage();
      if (u instanceof Error) throw u;
      return u;
    },
  } as unknown as LiveBridge;
  return { bridge, calls };
}

const event = (info: Record<string, unknown>) => ({
  type: 'rate_limit_event',
  rate_limit_info: info,
  uuid: 'u',
  session_id: 's',
});

function make(
  o: { usage?: () => unknown; now?: () => number; settings?: MemorySettings; cli?: boolean } = {},
) {
  const fb = fakeBridge(o.usage ?? (() => new Error('This Claude Code does not report plan usage')));
  const settings = o.settings ?? new MemorySettings();
  const bus = new MemoryEventBus();
  const limits = new PlanLimits({
    settings,
    bridge: fb.bridge,
    cli: async () => {
      if (o.cli === false) throw new Error('not installed');
      return { path: '/bin/claude' };
    },
    env: async () => ({}),
    openHandle: () => null,
    bus,
    ...(o.now && { now: o.now }),
  });
  return { limits, settings, calls: fb.calls, bus };
}

describe('plan limits', () => {
  it('reads a rate_limit_event window, its share as a percent and its reset time', () => {
    expect(
      windowFromEvent(
        { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1_791_000_000 },
        '2026-10-12T10:00:00.000Z',
      ),
    ).toEqual({
      id: 'five_hour',
      kind: 'session',
      label: null,
      percent: 42,
      resets_at: new Date(1_791_000_000_000).toISOString(),
      status: 'allowed_warning',
      updated_at: '2026-10-12T10:00:00.000Z',
    });
    expect(windowFromEvent({ status: 'rejected', rateLimitType: 'seven_day_opus' }, 'x')).toMatchObject({
      kind: 'week_model',
      label: 'Opus',
      percent: 100,
    });
    expect(windowFromEvent({ status: 'allowed' }, 'x')).toBeNull();
    expect(windowFromEvent('nonsense', 'x')).toBeNull();
  });

  it('keeps the latest figure per window, and keeps it across a restart', async () => {
    let t = Date.parse('2026-10-12T10:00:00Z');
    const a = make({ now: () => t });
    await a.limits.observe(event({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.18 }));
    await a.limits.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3 }));
    t += 60_000;
    await a.limits.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.35 }));
    await a.limits.observe({ type: 'assistant' });
    const saved = await a.settings.get<{ windows: { id: string; percent: number }[] }>(PLAN_LIMITS_KEY);
    expect(saved?.windows.map((w) => [w.id, w.percent])).toEqual([
      ['five_hour', 35],
      ['seven_day', 18],
    ]);
    // A new Core reads them back.
    const b = make({ settings: a.settings, now: () => t });
    const got = await b.limits.get();
    expect(got).toMatchObject({ available: true, source: 'event', can_refresh: true });
    expect(got.windows.map((w) => w.kind)).toEqual(['session', 'week']);
  });

  it('asks the usage report on refresh, in a session that sends nothing, and closes it', async () => {
    const t = Date.parse('2026-10-12T10:00:00Z');
    const a = make({
      now: () => t,
      usage: () => ({
        rate_limits_available: true,
        subscription_type: 'max',
        windows: {
          five_hour: { utilization: 42, resets_at: '2026-10-12T14:40:00.000Z' },
          seven_day: { utilization: 18, resets_at: '2026-10-19T08:00:00.000Z' },
        },
        model_scoped: [{ label: 'Opus', utilization: 7, resets_at: null }],
      }),
    });
    const got = await a.limits.get({ refresh: true });
    expect(a.calls).toEqual(['open', 'usage@h_own', 'close:h_own']);
    expect(got).toMatchObject({ available: true, plan: 'max', source: 'usage' });
    expect(got.windows.map((w) => [w.kind, w.label, w.percent])).toEqual([
      ['session', null, 42],
      ['week', null, 18],
      ['week_model', 'Opus', 7],
    ]);
    // Asked again at once: the figures are not fetched twice.
    await a.limits.get({ refresh: true });
    expect(a.calls).toHaveLength(3);
  });

  it('keeps the event figures when the experimental report is missing', async () => {
    const t = Date.parse('2026-10-12T10:00:00Z');
    const a = make({ now: () => t });
    await a.limits.observe(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }));
    const got = await a.limits.get({ refresh: true });
    expect(got.windows[0]?.percent).toBe(50);
    expect(got.source).toBe('event');
    expect(got.can_refresh).toBe(true);
  });

  it('says when limits do not apply (an API key sign-in)', async () => {
    const a = make({
      usage: () => ({ rate_limits_available: false, subscription_type: null, windows: {}, model_scoped: [] }),
    });
    const got = await a.limits.get({ refresh: true });
    expect(got).toMatchObject({ available: false, windows: [] });
  });

  it('asks after a turn on the open handle only when the last report is old', async () => {
    let t = Date.parse('2026-10-12T10:00:00Z');
    const a = make({
      now: () => t,
      usage: () => ({ rate_limits_available: true, windows: {}, model_scoped: [] }),
    });
    a.limits.afterTurn('h_live');
    await new Promise((r) => setTimeout(r, 0));
    a.limits.afterTurn('h_live');
    await new Promise((r) => setTimeout(r, 0));
    expect(a.calls).toEqual(['usage@h_live']);
    t += USAGE_MIN_INTERVAL_MS;
    a.limits.afterTurn('h_live');
    await new Promise((r) => setTimeout(r, 0));
    expect(a.calls).toEqual(['usage@h_live', 'usage@h_live']);
  });

  it('cannot refresh without a verified Claude Code', async () => {
    const a = make({ cli: false });
    expect(await a.limits.get({ refresh: true })).toMatchObject({ available: null, can_refresh: false });
    expect(a.calls).toEqual([]);
  });
});
