/**
 * ------------------------------------------------------------------
 *  Title    |  The permission gate
 *  Ref      |  DESIGN.md §5.3, CLAUDE.md ("every tool call goes
 *           |  through permissions/decide, on the real arguments,
 *           |  at execution time")
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The one function every tool call passes before it runs.
 *           |  It asks decide() on the call's real resource, writes the
 *           |  outcome to the decision log, and counts grant use.
 *  How      |  Returns the decision unchanged; asking the person (an
 *           |  approval) is the caller's job, because only the caller
 *           |  knows how to pause and resume its run.
 * ------------------------------------------------------------------
 */

import type { Tier } from '@nvx/contracts';
import { type DecideDeps, type DecisionResult, decide } from './decide';
import type { PermissionStore } from './store';

export interface GateRequest {
  userId: string;
  principal: string;
  action: string;
  resource: string;
  toolTier: Tier;
  destructive: boolean;
  scope: { threadId?: string | null; notebookId?: string | null; workspaceId: string };
  runId: string | null;
  traceId: string;
  /** Raised by an unattended automation (base.cedar escalates it). */
  automation?: boolean;
}

export interface Gate {
  check(req: GateRequest): Promise<DecisionResult>;
}

export function createGate(deps: Omit<DecideDeps, 'grants'> & { store: PermissionStore }): Gate {
  return {
    async check(req) {
      const result = await decide(
        {
          principal: req.principal,
          action: req.action,
          resource: req.resource,
          toolTier: req.toolTier,
          destructive: req.destructive,
          scope: req.scope,
          ...(req.automation && { automation: true }),
        },
        { ...deps, grants: deps.store },
      );
      if (result.outcome !== 'ask') {
        await deps.store.recordDecision({
          userId: req.userId,
          principal: req.principal,
          action: req.action,
          resource: result.resource,
          tier: result.tier,
          outcome:
            result.outcome === 'allow'
              ? result.via === 'auto'
                ? 'auto'
                : 'grant'
              : result.via === 'policy'
                ? 'policy_deny'
                : 'denied',
          grantId: result.grantId ?? null,
          policyId: result.outcome === 'deny' ? (result.policyId ?? null) : null,
          runId: req.runId,
          traceId: req.traceId,
        });
        if (result.grantId) await deps.store.recordGrantUse(result.grantId);
      }
      return result;
    },
  };
}
