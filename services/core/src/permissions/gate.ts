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
 *  How      |  Core's own API and key file (selfguard.ts: a call that
 *           |  reaches the API or names the install key is refused,
 *           |  in every preset) → the block floors that hold in every
 *           |  preset (auto/floors.ts blockFloors: a disk formatted, the
 *           |  machine powered off, a fork bomb, the root or home wiped,
 *           |  a protected file written; Auto mode runs the same rules in
 *           |  its own floors) → scope (a floor, in every preset) →
 *           |  the MCP rug-pull guard (a tool added or changed since
 *           |  its server was approved is refused, in every preset) →
 *           |  Auto mode floors → decide() → Auto mode's plan, cache
 *           |  and reviewer for a GATED ask, with floors and scope
 *           |  checked again after.
 *           |  Returns the decision; asking the person (an approval) is
 *           |  the caller's job, because only the caller knows how to
 *           |  pause and resume its run.
 *           |  recheck() is for a call a person has just approved and
 *           |  that is about to run: everything above that can say no
 *           |  (Core's API and key, scope, the MCP guard, a block floor,
 *           |  a policy forbid, a denying grant) is asked again on the
 *           |  call's real arguments, so a scope narrowed or a rule added
 *           |  while it waited still applies. It never asks again and
 *           |  never calls a reviewer: the person has answered.
 *  Note     |  A scope or floor refusal is logged as policy_deny with
 *           |  the rule as its policy id (scope.network, floor.…), so
 *           |  the Why view can say which rule it was.
 * ------------------------------------------------------------------
 */

import type { EffectiveScope, Tier } from '@nvx/contracts';
import type { McpToolCheck } from '../mcp/guard';
import { checkToolCall, leavingAllowed, type ScopeResolver } from '../scopes';
import type { AutoReview } from './auto';
import { blockFloors } from './auto/floors';
import { type DecideDeps, type DecisionResult, decide } from './decide';
import { normalizeResource } from './normalize';
import { currentSelfTargets, type SelfTargets, selfFloor } from './selfguard';
import type { PermissionStore } from './store';

/** The one caller whose web lookups may be eased (claim text only, factcheck/web.ts). */
export const FACTCHECK_WEB_TOOL = 'factcheck.web';

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
  /**
   * A gated call that needs nobody's yes: if decide() would only ask, it is allowed. A forbid, a
   * denying grant, the scope and the Auto floors all still apply, and a critical ask still asks.
   * Only fact-check web lookups of claim text use this (factcheck/web.ts).
   */
  eased?: boolean;
  /**
   * The person allowed this for a private notebook in Settings → Private notebooks: the private
   * notebook's "nothing leaves this machine" floor is not applied to this one call. Network off,
   * denied tools and tool presets still are.
   */
  leaveOk?: boolean;
}

type Denied = Extract<DecisionResult, { outcome: 'deny' }>;

export interface Gate {
  check(req: GateRequest): Promise<DecisionResult>;
  /**
   * A call the person has approved, about to run: the refusals that can still apply, decided again on
   * its real arguments. A deny means do not run it; null means it may (it never says "ask": the answer is in).
   */
  recheck(req: GateRequest): Promise<Denied | null>;
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
    /** MCP tool lists you approved (mcp/guard.ts): new and changed tools are refused. */
    mcpTools?: { check(principal: string, action: string): Promise<McpToolCheck> };
    /** Where Core and the Cockpit listen (selfguard.ts). Absent: what main.ts configured at start. */
    self?: SelfTargets;
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
          : result.via === 'policy' ||
              result.via === 'scope' ||
              result.via === 'floor' ||
              result.via === 'mcp_changed'
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

  const normalise = (req: GateRequest) =>
    normalizeResource(req.resource, {
      workspaceRoot: deps.workspaceRoot,
      ...(deps.fs && { fs: deps.fs }),
    });

  // eased and leaveOk are honoured for fact-check claim lookups only, whoever sets them:
  // the gate is the boundary, so a future caller can't widen its own access with a flag.
  const easeable = (req: GateRequest) => req.action === 'web.search' && req.tool === FACTCHECK_WEB_TOOL;
  const scopeOf = async (req: GateRequest) => {
    const found = await effective(req);
    return found && req.leaveOk && easeable(req) && found.private ? leavingAllowed(found) : found;
  };

  /**
   * What refuses a call in every preset, in this order: Core's own API and key (selfguard.ts), the
   * scope, and an MCP tool its server added or changed after you approved it. Null when none does.
   */
  const refusal = async (
    req: GateRequest,
    resource: string,
    scope: EffectiveScope | null,
    resolved: boolean,
  ): Promise<Denied | null> => {
    const own = selfFloor(
      { action: req.action, resource, args: req.args },
      deps.self ?? currentSelfTargets(),
    );
    if (own)
      return {
        outcome: 'deny',
        via: 'floor',
        tier: req.toolTier,
        resource,
        reason: own.reason,
        policyId: own.rule,
        code: own.rule,
      };
    // The floors that only ever refuse hold in every preset. With Auto mode on, its own floors (the same
    // rules, plus the ones that ask) run below, with their record; with it off, they run here.
    if (!deps.auto?.enabled()) {
      const hit = blockFloors({
        action: req.action,
        resource,
        ...(req.tool && { tool: req.tool }),
        ...(req.args !== undefined && { args: req.args }),
      });
      if (hit)
        return {
          outcome: 'deny',
          via: 'floor',
          tier: req.toolTier,
          resource,
          reason: hit.reason,
          policyId: hit.rule,
          code: hit.rule,
        };
    }
    if (scope && resolved) {
      const s = checkToolCall(scope, { action: req.action, resource });
      if (!s.ok)
        return {
          outcome: 'deny',
          via: 'scope',
          tier: req.toolTier,
          resource,
          reason: s.reason,
          policyId: `scope.${s.field}`,
          code: s.code,
        };
    }
    if (deps.mcpTools && req.action.startsWith('mcp.')) {
      const m = await deps.mcpTools.check(req.principal, req.action).catch(
        (): McpToolCheck => ({
          ok: false,
          code: 'mcp.tools_changed',
          reason: 'NVX Ancile could not check this MCP tool against the list you approved',
        }),
      );
      if (!m.ok)
        return {
          outcome: 'deny',
          via: 'mcp_changed',
          tier: req.toolTier,
          resource,
          reason: m.reason,
          policyId: m.code,
          code: m.code,
        };
    }
    return null;
  };

  return {
    async recheck(req) {
      const norm = await normalise(req);
      const resource = norm.ok ? norm.resource : req.resource;
      const scope = await scopeOf(req);
      const refused = await refusal(req, resource, scope, norm.ok);
      if (refused) {
        await record(req, refused);
        return refused;
      }
      // Auto mode's block floors still hold; the ones that only ask were answered by the person.
      const auto = deps.auto?.enabled() ? deps.auto.review : null;
      if (auto && norm.ok) {
        const hit = auto.floors({
          call: {
            principal: req.principal,
            action: req.action,
            resource,
            outsideRoot: norm.outsideRoot,
            destructive: req.destructive,
            ...(req.tool && { tool: req.tool }),
            ...(req.args !== undefined && { args: req.args }),
          },
          scope,
        });
        if (hit?.verdict === 'block') {
          const denied: Denied = {
            outcome: 'deny',
            via: 'floor',
            tier: req.toolTier,
            resource,
            reason: hit.reason,
            policyId: hit.rule,
            code: hit.rule,
          };
          await record(req, denied);
          return denied;
        }
      }
      // A policy that now forbids it, or a grant that now says never: decide() on the same arguments.
      const again = await decide(
        {
          principal: req.principal,
          action: req.action,
          resource: req.resource,
          toolTier: req.toolTier,
          destructive: req.destructive,
          scope: req.scope,
          ...(req.automation && { automation: true }),
          ...(req.args !== undefined && { args: req.args }),
        },
        { ...deps, grants: deps.store },
      );
      if (again.outcome === 'deny') {
        await record(req, again);
        return again;
      }
      return null;
    },

    async check(req) {
      const norm = await normalise(req);
      const resource = norm.ok ? norm.resource : req.resource;

      // ---- Core's own API and key, the scope, the MCP rug-pull guard: floors in every preset ----
      const scope = await scopeOf(req);
      const refused = await refusal(req, resource, scope, norm.ok);
      if (refused) {
        await record(req, refused);
        return refused;
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
          // The real arguments: an MCP or plugin tool's resource names only the tool (decide.ts).
          ...(req.args !== undefined && { args: req.args }),
        },
        { ...deps, grants: deps.store },
      );

      // ---- an eased call: a gated ask needs nobody's yes (never a critical one) ----
      if (req.eased && easeable(req) && result.outcome === 'ask' && result.tier === 'gated') {
        const allowed: DecisionResult = {
          outcome: 'allow',
          via: 'auto',
          tier: 'gated',
          resource: result.resource,
        };
        await record(req, allowed);
        return allowed;
      }

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
          await auto.noteStep(ctx);
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
      // Allowed by your scope or a grant: still a step of the plan done.
      if (auto && ctx && norm.ok && result.outcome === 'allow') await auto.noteStep(ctx);
      return result;
    },
  };
}
