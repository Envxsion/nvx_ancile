/**
 * ------------------------------------------------------------------
 *  Title    |  Idle timeout
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Stop (never terminate) a running node with no traffic
 *           |  for N minutes. The in-pod watchdog is only a backup for
 *           |  when the Controller itself is down (infra/node).
 *  How      |  Idle time counts from the later of the last request and
 *           |  the moment the node came up, so a freshly started node
 *           |  is never stopped for having had no traffic "yet".
 * ------------------------------------------------------------------
 */

import type { Rule } from '@nvx/contracts/controller';
import { appliesTo, type NodeView, type RuleOutcome } from './types';

type IdleRule = Extract<Rule, { kind: 'idle_timeout' }>;

export function evaluateIdle(rule: IdleRule, nodes: NodeView[], now: Date): RuleOutcome {
  const out: RuleOutcome = { actions: [], blockRouting: false, notices: [] };
  if (!rule.enabled) return out;
  const limitMs = rule.config.idle_minutes * 60_000;
  for (const node of nodes) {
    if (node.state !== 'running' || node.hasLiveOperation || !appliesTo(rule.config.node_ids, node.id))
      continue;
    const since = Math.max(node.lastActivityAt?.getTime() ?? 0, node.runningSince?.getTime() ?? 0);
    if (since === 0) continue; // no basis to judge; wait for the next observation
    const idleMs = now.getTime() - since;
    if (idleMs >= limitMs) {
      const minutes = Math.floor(idleMs / 60_000);
      out.actions.push({
        nodeId: node.id,
        action: 'stop',
        reason: `rule:${rule.id} idle for ${minutes} min`,
      });
      out.notices.push({
        level: 'info',
        title: `Stopping ${node.name}`,
        body: `No requests for ${minutes} minutes (limit ${rule.config.idle_minutes}). Storage is kept; start it again any time.`,
      });
    }
  }
  return out;
}
