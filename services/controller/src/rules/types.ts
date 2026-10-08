/**
 * ------------------------------------------------------------------
 *  Title    |  Rule evaluation types
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Rules are pure: (rule, world, clock) → outcome. The rule
 *           |  runner turns outcomes into operations (with reason
 *           |  "rule:<id>"), routing blocks and notifications, so every
 *           |  automatic action shows up in the same confirmation chain
 *           |  as a manual one.
 * ------------------------------------------------------------------
 */

import type { NodeAction, NodeState } from '@nvx/contracts/controller';

export interface NodeView {
  id: string;
  name: string;
  state: NodeState;
  lastActivityAt: Date | null;
  /** When the node last entered `running`; idle time counts from here if there was no traffic. */
  runningSince: Date | null;
  hasLiveOperation: boolean;
}

export interface ActionIntent {
  nodeId: string;
  action: NodeAction;
  reason: string;
}

export interface RuleNotice {
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
}

export interface RuleOutcome {
  actions: ActionIntent[];
  blockRouting: boolean;
  notices: RuleNotice[];
}

export const EMPTY: RuleOutcome = { actions: [], blockRouting: false, notices: [] };

export function appliesTo(nodeIds: string[] | '*', id: string): boolean {
  return nodeIds === '*' || nodeIds.includes(id);
}
