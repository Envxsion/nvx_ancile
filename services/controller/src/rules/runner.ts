/**
 * ------------------------------------------------------------------
 *  Title    |  Rule runner
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Every CONTROLLER_RULES_INTERVAL_S: evaluate each rule
 *           |  against the current world and act. Actions go through
 *           |  the same control-plane path as a person's click, with
 *           |  reason "rule:<id> …", so they are confirmed and logged
 *           |  the same way.
 *  Note     |  A schedule's last firing is kept in the store, so a
 *           |  restart never fires the same slot twice. Cap notices are
 *           |  announced once per month per process. Leader election
 *           |  is needed only if the Controller is ever run with
 *           |  replicas.
 * ------------------------------------------------------------------
 */

import type { Rule } from '@nvx/contracts/controller';
import { computeCosts, monthOf } from '../costs/compute';
import type { NodeRecord, Store } from '../store';
import { evaluateCostCap } from './costcap';
import { evaluateIdle } from './idle';
import { evaluateSchedule } from './schedule';
import type { NodeView, RuleOutcome } from './types';

export interface RunnerState {
  lastFired: Map<string, Date>;
  announced: Map<string, Set<'warn' | 'reached'>>; // key: `${ruleId}:${month}`
  routingBlocked: boolean;
}

export function newRunnerState(): RunnerState {
  return { lastFired: new Map(), announced: new Map(), routingBlocked: false };
}

export async function evaluateAll(
  store: Store,
  state: RunnerState,
  now: Date,
  defaultCap: number,
): Promise<RuleOutcome> {
  const records = await store.listNodes();
  const views: NodeView[] = await Promise.all(
    records.map(async (n) => toView(n, Boolean(await store.liveOperationFor(n.id)))),
  );
  const rules = await store.listRules();
  const month = monthOf(now);
  const outcome: RuleOutcome = { actions: [], blockRouting: false, notices: [] };
  let costs: ReturnType<typeof computeCosts> | null = null;

  for (const rule of rules) {
    let r: RuleOutcome;
    switch (rule.kind) {
      case 'idle_timeout':
        r = evaluateIdle(rule, views, now);
        break;
      case 'schedule': {
        const last = state.lastFired.get(rule.id) ?? (await store.ruleFiredAt(rule.id));
        const s = evaluateSchedule(rule, views, last, now);
        if (s.firedAt) {
          state.lastFired.set(rule.id, s.firedAt);
          await store.markRuleFired(rule.id, s.firedAt);
        }
        r = s;
        break;
      }
      case 'cost_cap': {
        costs ??= costsFor(records, await store.intervals(), now, month, rule.config.monthly_usd);
        const key = `${rule.id}:${month}`;
        const announced = state.announced.get(key) ?? new Set();
        r = evaluateCostCap(rule, costs, views, announced);
        for (const n of r.notices) announced.add(n.level === 'error' ? 'reached' : 'warn');
        state.announced.set(key, announced);
        break;
      }
    }
    merge(outcome, r);
  }
  if (defaultCap > 0 && !rules.some((r: Rule) => r.kind === 'cost_cap')) {
    // A cap set at deployment (CONTROLLER_COST_CAP_USD) applies when you have no cap rule.
    costs ??= costsFor(records, await store.intervals(), now, month, defaultCap);
    if (costs.total_to_date >= defaultCap) outcome.blockRouting = true;
  }
  state.routingBlocked = outcome.blockRouting;
  // De-duplicate: one action per node per tick, first rule wins.
  const seen = new Set<string>();
  outcome.actions = outcome.actions.filter((a) => {
    if (seen.has(a.nodeId)) return false;
    seen.add(a.nodeId);
    return true;
  });
  return outcome;
}

function merge(into: RuleOutcome, r: RuleOutcome) {
  into.actions.push(...r.actions);
  into.notices.push(...r.notices);
  into.blockRouting ||= r.blockRouting;
}

function toView(n: NodeRecord, live: boolean): NodeView {
  return {
    id: n.id,
    name: n.name,
    state: n.observed_state,
    lastActivityAt: n.last_activity_at ? new Date(n.last_activity_at) : null,
    runningSince: n.runningSince,
    hasLiveOperation: live,
  };
}

function costsFor(
  records: NodeRecord[],
  intervals: Awaited<ReturnType<Store['intervals']>>,
  now: Date,
  month: string,
  cap: number,
) {
  return computeCosts({
    month,
    now,
    cap,
    intervals,
    nodes: records.map((n) => ({
      nodeId: n.id,
      hourlyRate: n.hourly_rate,
      storageRateMonth: n.storage_rate_month,
      createdAt: n.createdAt,
      terminatedAt: n.terminatedAt,
      runningNow: n.observed_state === 'running',
    })),
  });
}
