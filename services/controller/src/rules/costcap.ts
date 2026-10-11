/**
 * ------------------------------------------------------------------
 *  Title    |  Cost cap
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  A hard monthly ceiling. At 80% of the cap: a warning.
 *           |  At the cap: stop running nodes, block routing (Core
 *           |  receives 402 cost_cap and falls back to cloud models),
 *           |  or only notify, as the rule says.
 *           |  "stop_nodes" stops only the rule's chosen nodes (all of
 *           |  them when none are chosen); spend counts every node.
 *  Note     |  Warnings fire once per threshold per month; the runner
 *           |  passes in which thresholds have already been announced.
 * ------------------------------------------------------------------
 */

import type { CostSummary, Rule } from '@nvx/contracts/controller';
import { appliesTo, type NodeView, type RuleOutcome } from './types';

type CapRule = Extract<Rule, { kind: 'cost_cap' }>;
export const WARN_AT = 0.8;

export function evaluateCostCap(
  rule: CapRule,
  costs: Pick<CostSummary, 'total_to_date' | 'projected_total'>,
  nodes: NodeView[],
  announced: ReadonlySet<'warn' | 'reached'> = new Set(),
): RuleOutcome {
  const out: RuleOutcome = { actions: [], blockRouting: false, notices: [] };
  if (!rule.enabled) return out;
  const cap = rule.config.monthly_usd;
  const spent = costs.total_to_date;
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  if (spent >= cap) {
    if (rule.config.on_reach === 'block_routing') out.blockRouting = true;
    if (rule.config.on_reach === 'stop_nodes') {
      for (const n of nodes) {
        if (
          (n.state === 'running' || n.state === 'starting') &&
          !n.hasLiveOperation &&
          appliesTo(rule.config.node_ids ?? '*', n.id)
        ) {
          out.actions.push({
            nodeId: n.id,
            action: 'stop',
            reason: `rule:${rule.id} monthly cap ${fmt(cap)} reached`,
          });
        }
      }
    }
    if (!announced.has('reached')) {
      const consequence = {
        stop_nodes: 'Running nodes are being stopped.',
        block_routing: 'Requests for GPU models now go to cloud models instead.',
        notify_only: 'Nothing was stopped; this rule only notifies.',
      }[rule.config.on_reach];
      out.notices.push({
        level: 'error',
        title: 'Monthly GPU cost cap reached',
        body: `${fmt(spent)} of ${fmt(cap)} spent. ${consequence} Raise the cap in Admin → Compute → Rules to continue.`,
      });
    }
    return out;
  }

  if (spent >= cap * WARN_AT && !announced.has('warn')) {
    out.notices.push({
      level: 'warn',
      title: 'GPU spend is at 80% of the monthly cap',
      body: `${fmt(spent)} of ${fmt(cap)} spent; ${fmt(costs.projected_total)} projected for the month at the current rate.`,
    });
  }
  return out;
}
