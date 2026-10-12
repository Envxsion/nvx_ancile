/**
 * ------------------------------------------------------------------
 *  Title    |  The permission gate
 *  Ref      |  DESIGN.md §5.3, CLAUDE.md ("every tool call goes
 *           |  through permissions/decide, on the real arguments,
 *           |  at execution time") · docs/scopes.md · docs/auto-mode.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The one function every tool call passes before it runs.
 *           |  It checks the scope, asks decide() on the call's real
 *           |  resource, lets Auto mode settle what decide() would ask
 *           |  about, writes the outcome to the decision log, and
 *           |  counts grant use.
 *  How      |  scope (a floor, in every preset) → Auto mode floors →
 *           |  decide() → Auto mode's plan, cache and reviewer for a
 *           |  GATED ask, with floors and scope checked again after.
 *           |  Returns the decision; asking the person (an approval) is
 *           |  the caller's job, because only the caller knows how to
 *           |  pause and resume its run.
 *  Note     |  A scope or floor refusal is logged as policy_deny with
 *           |  the rule as its policy id (scope.network, floor.…), so
 *           |  the Why view can say which rule it was.
 * ------------------------------------------------------------------
 */

import type { EffectiveScope, Tier } from '@nvx/contracts';
import { checkToolCall, type ScopeResolver } from '../scopes';
import type { AutoReview } from './auto';
import { type DecideDeps, type DecisionResult, decide } from './decide';
import { normalizeResource } from './normalize';
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
  /** The tool's own name and real arguments: Auto mode's floors and reviewer read them as data. */
  tool?: string;
  args?: unknown;
  /** The call this decides, for Auto mode's run events. */
  callId?: string;
}

export interface Gate {
  check(req: GateRequest): Promise<DecisionResult>;
}

export interface GateAuto {
  review: AutoReview;
  /** Is the Auto preset on right now? Read per call. */
  enabled(): boolean;
}

export function createGate(
  deps: Omit<DecideDeps, 'grants'> & {
    store: PermissionStore;
    /** Scopes (docs/scopes.md): checked on every call, in every preset. */
    scopes?: ScopeResolver;
    /** Auto mode (docs/auto-mode.md). */
    auto?: GateAuto;
  },
): Gate {
  const record = async (req: GateRequest, result: DecisionResult) => {
    if (result.outcome === 'ask') return;
    await deps.store.recordDecision({
      userId: req.userId,
      principal: req.principal,
      action: req.action,
      resource: result.resource,
      tier: result.tier,
      outcome:
        result.outcome === 'allow'
          ? result.via === 'grant'
            ? 'grant'
            : 'auto'
          : result.via === 'policy' || result.via === 'scope' || result.via === 'floor'
            ? 'policy_deny'
            : 'denied',
      grantId: result.grantId ?? null,
      policyId: result.outcome === 'deny' ? (result.policyId ?? null) : null,
      runId: req.runId,
      traceId: req.traceId,
    });
    if (result.grantId) await deps.store.recordGrantUse(result.grantId);
  };

  const effective = (req: GateRequest): Promise<EffectiveScope | null> =>
    deps.scopes
      ? deps.scopes.effective({
          threadId: req.scope.threadId ?? null,
          notebookId: req.scope.notebookId ?? null,
        })
      : Promise.resolve(null);

  return {
    async check(req) {
      const norm = await normalizeResource(req.resource, {
        workspaceRoot: deps.workspaceRoot,
        ...(deps.fs && { fs: deps.fs }),
      });
      const resource = norm.ok ? norm.resource : req.resource;

      // ---- scope: a floor in every preset ----
      const scope = await effective(req);
      if (scope && norm.ok) {
        const s = checkToolCall(scope, { action: req.action, resource });
        if (!s.ok) {
          const result: DecisionResult = {
            outcome: 'deny',
            via: 'scope',
            tier: req.toolTier,
            resource,
            reason: s.reason,
            policyId: `scope.${s.field}`,
            code: s.code,
          };
          await record(req, result);
          return result;
        }
      }

      // ---- Auto mode: floors before anything else ----
      const auto = deps.auto?.enabled() ? deps.auto.review : null;
      const ctx = auto
        ? {
            call: {
              principal: req.principal,
              action: req.action,
              resource,
              outsideRoot: norm.ok ? norm.outsideRoot : true,
              destructive: req.destructive,
              ...(req.tool && { tool: req.tool }),
              ...(req.args !== undefined && { args: req.args }),
            },
            scope,
            threadId: req.scope.threadId ?? null,
            notebookId: req.scope.notebookId ?? null,
            runId: req.runId,
            traceId: req.traceId,
            root: deps.workspaceRoot,
            ...(req.callId && { callId: req.callId }),
          }
        : null;
      if (auto && ctx && norm.ok) {
        const hit = auto.floors(ctx);
        if (hit) {
          const out = await auto.floored(ctx, hit);
          if (hit.verdict === 'block') {
            const result: DecisionResult = {
              outcome: 'deny',
              via: 'floor',
              tier: req.toolTier,
              resource,
              reason: hit.reason,
              policyId: hit.rule,
              code: hit.rule,
            };
            await record(req, result);
            return result;
          }
          // A floor that asks: never remembered, never eased.
          return {
            outcome: 'ask',
            tier: 'critical',
            resource,
            suggestions: [],
            reason: hit.reason,
            ...(out.batch_id && { batchId: out.batch_id }),
          };
        }
      }

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

      // ---- Auto mode: settle what decide() would ask about (GATED only; CRITICAL always asks) ----
      if (auto && ctx && result.outcome === 'ask' && result.tier === 'gated' && !req.automation) {
        const out = await auto.settle(ctx, () => effective(req));
        if (out.verdict === 'allow') {
          const allowed: DecisionResult = {
            outcome: 'allow',
            via: 'review',
            tier: 'gated',
            resource: result.resource,
          };
          await record(req, allowed);
          return allowed;
        }
        if (out.verdict === 'block') {
          const denied: DecisionResult = {
            outcome: 'deny',
            via: 'floor',
            tier: result.tier,
            resource: result.resource,
            reason: out.reason,
            policyId: out.rule ?? 'floor',
            code: out.rule ?? 'floor',
          };
          await record(req, denied);
          return denied;
        }
        return { ...result, reason: out.reason, ...(out.batch_id && { batchId: out.batch_id }) };
      }
      if (auto && ctx && result.outcome === 'ask') {
        // CRITICAL still asks in Auto mode; it joins the run's group like any other ask.
        const out = await auto.floored(ctx, {
          verdict: 'ask',
          rule: 'tier.critical',
          reason: 'It is a critical action, which always asks',
        });
        return { ...result, reason: out.reason, ...(out.batch_id && { batchId: out.batch_id }) };
      }
      await record(req, result);
      return result;
    },
  };
}
