import { describe, expect, it } from 'vitest';
import { evaluateCostCap } from '../../src/rules/costcap';
import { evaluateIdle } from '../../src/rules/idle';
import { cronMatches, evaluateSchedule, lastMatch, parseCron } from '../../src/rules/schedule';
import type { NodeView } from '../../src/rules/types';

const now = new Date('2026-10-07T10:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const node = (over: Partial<NodeView> = {}): NodeView => ({
  id: 'n1',
  name: 'A100 box',
  state: 'running',
  lastActivityAt: ago(5),
  runningSince: ago(120),
  hasLiveOperation: false,
  ...over,
});

describe('idle timeout', () => {
  const rule = {
    id: 'r1',
    kind: 'idle_timeout' as const,
    enabled: true,
    config: { node_ids: '*' as const, idle_minutes: 30 },
  };

  it('stops a node idle past the limit, never terminates', () => {
    const out = evaluateIdle(rule, [node({ lastActivityAt: ago(45) })], now);
    expect(out.actions).toEqual([{ nodeId: 'n1', action: 'stop', reason: 'rule:r1 idle for 45 min' }]);
    expect(out.notices[0]?.body).toMatch(/Storage is kept/);
  });

  it('counts from start-up when there has been no traffic yet', () => {
    expect(
      evaluateIdle(rule, [node({ lastActivityAt: null, runningSince: ago(10) })], now).actions,
    ).toHaveLength(0);
    expect(
      evaluateIdle(rule, [node({ lastActivityAt: null, runningSince: ago(31) })], now).actions,
    ).toHaveLength(1);
  });

  it('skips busy, non-running, out-of-scope and disabled', () => {
    const idle = ago(90);
    expect(
      evaluateIdle(rule, [node({ lastActivityAt: idle, hasLiveOperation: true })], now).actions,
    ).toHaveLength(0);
    expect(evaluateIdle(rule, [node({ lastActivityAt: idle, state: 'stopped' })], now).actions).toHaveLength(
      0,
    );
    expect(
      evaluateIdle(
        { ...rule, config: { ...rule.config, node_ids: ['other'] } },
        [node({ lastActivityAt: idle })],
        now,
      ).actions,
    ).toHaveLength(0);
    expect(
      evaluateIdle({ ...rule, enabled: false }, [node({ lastActivityAt: idle })], now).actions,
    ).toHaveLength(0);
  });
});

describe('cron', () => {
  it('parses lists, ranges and steps', () => {
    const c = parseCron('*/15 9-17 * * 1-5');
    expect([...c.minute.values]).toEqual([0, 15, 30, 45]);
    expect(c.hour.values.has(17)).toBe(true);
    expect(c.dow.values.has(6)).toBe(false);
    expect(parseCron('0 0 * * 7').dow.values.has(0)).toBe(true);
  });

  it('rejects malformed expressions with a readable message', () => {
    expect(() => parseCron('* * *')).toThrow(/five fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/minute/);
    expect(() => parseCron('a * * * *')).toThrow(/cannot read/);
  });

  it('evaluates in the rule time zone', () => {
    // 2026-10-07 08:00 UTC = 19:00 in Melbourne (AEDT, UTC+11)
    const c = parseCron('0 19 * * 1-5');
    expect(cronMatches(c, new Date('2026-10-07T08:00:00Z'), 'Australia/Melbourne')).toBe(true);
    expect(cronMatches(c, new Date('2026-10-07T08:00:00Z'), 'UTC')).toBe(false);
  });

  it('uses OR semantics when both day fields are restricted', () => {
    const c = parseCron('0 0 1 * 1'); // the 1st, or any Monday
    expect(cronMatches(c, new Date('2026-10-05T00:00:00Z'), 'UTC')).toBe(true); // Monday 5th
    expect(cronMatches(c, new Date('2026-10-01T00:00:00Z'), 'UTC')).toBe(true); // Thursday 1st
    expect(cronMatches(c, new Date('2026-10-06T00:00:00Z'), 'UTC')).toBe(false);
  });

  it('finds the last match since the previous fire, capped at 24h', () => {
    const c = parseCron('30 9 * * *');
    expect(lastMatch(c, 'UTC', new Date('2026-10-07T09:00:00Z'), now)?.toISOString()).toBe(
      '2026-10-07T09:30:00.000Z',
    );
    expect(lastMatch(c, 'UTC', new Date('2026-10-07T09:30:00Z'), now)).toBeNull();
    expect(lastMatch(c, 'UTC', new Date('2026-09-01T00:00:00Z'), now)?.toISOString()).toBe(
      '2026-10-07T09:30:00.000Z',
    );
  });
});

describe('schedule rule', () => {
  const rule = {
    id: 'r2',
    kind: 'schedule' as const,
    enabled: true,
    config: { node_ids: '*' as const, cron: '0 10 * * *', action: 'stop' as const, tz: 'UTC' },
  };

  it('fires once for nodes where the action makes sense', () => {
    const out = evaluateSchedule(rule, [node(), node({ id: 'n2', state: 'stopped' })], ago(5), now);
    expect(out.firedAt?.toISOString()).toBe(now.toISOString());
    expect(out.actions.map((a) => a.nodeId)).toEqual(['n1']);
    const again = evaluateSchedule(rule, [node()], out.firedAt, new Date(now.getTime() + 30_000));
    expect(again.firedAt).toBeNull();
  });

  // 2026-10-07 is a Wednesday.
  it('fires only on the chosen weekdays, in the rule time zone', () => {
    const on = { ...rule, config: { ...rule.config, weekdays: ['mon', 'wed'] as ('mon' | 'wed')[] } };
    expect(evaluateSchedule(on, [node()], ago(5), now).actions).toHaveLength(1);
    const off = { ...rule, config: { ...rule.config, weekdays: ['thu' as const] } };
    const out = evaluateSchedule(off, [node()], ago(5), now);
    expect(out.firedAt).toBeNull();
    expect(out.actions).toHaveLength(0);
    // The day is read in the rule's zone, not UTC.
    const mel = {
      ...rule,
      config: { ...rule.config, cron: '30 23 * * *', tz: 'Australia/Melbourne', weekdays: ['wed' as const] },
    };
    const wedNightMel = new Date('2026-10-07T12:30:00Z'); // 23:30 Wed in Melbourne (AEDT, +11)
    expect(
      evaluateSchedule(mel, [node()], new Date(wedNightMel.getTime() - 60_000), wedNightMel).firedAt,
    ).not.toBeNull();
    const thuNightMel = new Date('2026-10-08T12:30:00Z');
    expect(
      evaluateSchedule(mel, [node()], new Date(thuNightMel.getTime() - 60_000), thuNightMel).firedAt,
    ).toBeNull();
  });

  it('with no weekdays, fires every day the cron allows', () => {
    const thursday = new Date('2026-10-08T10:00:00Z');
    expect(
      evaluateSchedule(rule, [node()], new Date(thursday.getTime() - 60_000), thursday).firedAt,
    ).not.toBeNull();
  });

  it('acts only on the chosen nodes', () => {
    const chosen = { ...rule, config: { ...rule.config, node_ids: ['n2'] } };
    const out = evaluateSchedule(chosen, [node(), node({ id: 'n2' })], ago(5), now);
    expect(out.actions.map((a) => a.nodeId)).toEqual(['n2']);
  });
});

describe('cost cap', () => {
  const rule = (on_reach: 'stop_nodes' | 'block_routing' | 'notify_only') => ({
    id: 'r3',
    kind: 'cost_cap' as const,
    enabled: true,
    config: { monthly_usd: 100, on_reach },
  });

  it('warns at 80% once', () => {
    const out = evaluateCostCap(rule('notify_only'), { total_to_date: 85, projected_total: 140 }, [node()]);
    expect(out.notices[0]?.level).toBe('warn');
    expect(
      evaluateCostCap(
        rule('notify_only'),
        { total_to_date: 85, projected_total: 140 },
        [node()],
        new Set(['warn']),
      ).notices,
    ).toHaveLength(0);
  });

  it('stops running nodes, blocks routing, or only notifies at the cap', () => {
    const costs = { total_to_date: 100.01, projected_total: 150 };
    const stop = evaluateCostCap(rule('stop_nodes'), costs, [node(), node({ id: 'n2', state: 'stopped' })]);
    expect(stop.actions.map((a) => a.nodeId)).toEqual(['n1']);
    expect(stop.blockRouting).toBe(false);
    expect(evaluateCostCap(rule('block_routing'), costs, [node()]).blockRouting).toBe(true);
    const notify = evaluateCostCap(rule('notify_only'), costs, [node()]);
    expect(notify.actions).toHaveLength(0);
    expect(notify.notices[0]?.body).toMatch(/only notifies/);
  });

  it('stops only the chosen nodes when the rule names some', () => {
    const costs = { total_to_date: 120, projected_total: 150 };
    const r = rule('stop_nodes');
    const chosen = { ...r, config: { ...r.config, node_ids: ['n2'] } };
    const out = evaluateCostCap(chosen, costs, [node(), node({ id: 'n2' })]);
    expect(out.actions.map((a) => a.nodeId)).toEqual(['n2']);
  });
});
