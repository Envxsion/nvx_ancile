/**
 * ------------------------------------------------------------------
 *  Title    |  The permission decision
 *  Ref      |  DESIGN.md §5.3 (this file is that pseudocode, exactly)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Allow, deny, or ask, for one tool call, on its real
 *           |  arguments, at the moment it is about to run.
 *  How      |  normalise → policy forbid → tier (tool default, floors,
 *           |  policy escalation) → AUTO allows, CRITICAL always asks,
 *           |  GATED consults grants (most specific wins, deny beats
 *           |  allow on a tie) → otherwise ask.
 *  Note     |  Pure apart from the injected evaluator and grant store.
 *           |  Recording the decision is the caller's job (decisions
 *           |  table + span), so this stays trivially testable.
 * ------------------------------------------------------------------
 */

import type { Tier } from '@nvx/contracts';
import { matchAction, matchResource, specificity } from './glob';
import { type FsProbe, normalizeResource } from './normalize';
import { suggestPatterns } from './suggest';

export const TIER_RANK: Record<Tier, number> = { auto: 0, gated: 1, critical: 2 };
export const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

export interface DecisionRequest {
  principal: string;
  action: string;
  resource: string;
  /** The tool's declared default tier for this action. */
  toolTier: Tier;
  destructive?: boolean;
  scope: { threadId?: string | null; notebookId?: string | null; workspaceId: string };
}

export interface PolicyEvaluator {
  /** Admin-authored forbid policies (Cedar). */
  forbids(req: {
    principal: string;
    action: string;
    resource: string;
    outsideRoot: boolean;
  }): Promise<{ forbidden: boolean; policyId?: string }>;
  /**
   * The permission preset's one easing (Hands-off): a GATED, non-destructive
   * action it names may run without asking. Applied before the destructive
   * floor and before escalation, so nothing critical is ever eased.
   */
  relax?(req: {
    principal: string;
    action: string;
    resource: string;
    outsideRoot: boolean;
    toolTier: Tier;
    destructive: boolean;
  }): Tier | null;
  /** Policies may raise a tier (e.g. writes outside the workspace → critical), never lower it. */
  escalation(req: {
    principal: string;
    action: string;
    resource: string;
    outsideRoot: boolean;
  }): Promise<Tier | null>;
}

export interface GrantLike {
  id: string;
  principal: string;
  actionPattern: string;
  resourcePattern: string;
  effect: 'allow' | 'deny';
  scope: 'thread' | 'notebook' | 'workspace' | 'always';
  scopeRef: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface GrantSource {
  /** Active grants for the principal; filtering is done here, so a superset is fine. */
  forPrincipal(principal: string): Promise<GrantLike[]>;
}

export type DecisionResult =
  | { outcome: 'allow'; via: 'auto' | 'grant'; tier: Tier; resource: string; grantId?: string }
  | {
      outcome: 'deny';
      via: 'policy' | 'grant' | 'normalize';
      tier: Tier;
      resource: string;
      reason: string;
      grantId?: string;
      policyId?: string;
    }
  | { outcome: 'ask'; tier: Exclude<Tier, 'auto'>; resource: string; suggestions: string[] };

export interface DecideDeps {
  policy: PolicyEvaluator;
  grants: GrantSource;
  workspaceRoot: string;
  fs?: FsProbe;
  now?: () => number;
}

export function grantInScope(g: GrantLike, scope: DecisionRequest['scope']): boolean {
  switch (g.scope) {
    case 'always':
      return true;
    case 'workspace':
      return g.scopeRef === null || g.scopeRef === scope.workspaceId;
    case 'notebook':
      return !!scope.notebookId && g.scopeRef === scope.notebookId;
    case 'thread':
      return !!scope.threadId && g.scopeRef === scope.threadId;
  }
}

export function grantLive(g: GrantLike, now: number): boolean {
  return g.revokedAt === null && (g.expiresAt === null || Date.parse(g.expiresAt) > now);
}

/** The grant that decides, or undefined. Most specific wins; deny beats allow on a tie. */
export function pickGrant(
  grants: GrantLike[],
  req: { principal: string; action: string; resource: string; scope: DecisionRequest['scope'] },
  now: number,
): GrantLike | undefined {
  const matching = grants.filter(
    (g) =>
      g.principal === req.principal &&
      grantLive(g, now) &&
      grantInScope(g, req.scope) &&
      matchAction(g.actionPattern, req.action) &&
      matchResource(g.resourcePattern, req.resource),
  );
  matching.sort((a, b) => {
    const s =
      specificity(b.actionPattern) +
      specificity(b.resourcePattern) -
      (specificity(a.actionPattern) + specificity(a.resourcePattern));
    if (s !== 0) return s;
    if (a.effect !== b.effect) return a.effect === 'deny' ? -1 : 1;
    return 0;
  });
  return matching[0];
}

export async function decide(req: DecisionRequest, deps: DecideDeps): Promise<DecisionResult> {
  const now = deps.now?.() ?? Date.now();
  const norm = await normalizeResource(req.resource, {
    workspaceRoot: deps.workspaceRoot,
    ...(deps.fs && { fs: deps.fs }),
  });
  if (!norm.ok) {
    return {
      outcome: 'deny',
      via: 'normalize',
      tier: 'critical',
      resource: req.resource,
      reason: norm.detail,
    };
  }
  const r = norm.resource;
  const pq = { principal: req.principal, action: req.action, resource: r, outsideRoot: norm.outsideRoot };

  const forbid = await deps.policy.forbids(pq);
  if (forbid.forbidden) {
    return {
      outcome: 'deny',
      via: 'policy',
      tier: req.toolTier,
      resource: r,
      reason: 'A policy forbids this action',
      ...(!!forbid.policyId && { policyId: forbid.policyId }),
    };
  }

  let tier = req.toolTier;
  tier = deps.policy.relax?.({ ...pq, toolTier: tier, destructive: req.destructive === true }) ?? tier;
  if (req.destructive && tier === 'auto') tier = 'gated'; // floor: destructive is never AUTO
  const escalated = await deps.policy.escalation(pq);
  if (escalated) tier = maxTier(tier, escalated);

  if (tier === 'auto') return { outcome: 'allow', via: 'auto', tier, resource: r };
  if (tier === 'critical') return { outcome: 'ask', tier, resource: r, suggestions: [] };

  const g = pickGrant(await deps.grants.forPrincipal(req.principal), { ...req, resource: r }, now);
  if (g?.effect === 'deny') {
    return {
      outcome: 'deny',
      via: 'grant',
      tier,
      resource: r,
      reason: 'You chose to always deny this',
      grantId: g.id,
    };
  }
  if (g?.effect === 'allow') return { outcome: 'allow', via: 'grant', tier, resource: r, grantId: g.id };

  return {
    outcome: 'ask',
    tier,
    resource: r,
    suggestions: suggestPatterns(r, { workspaceRoot: deps.workspaceRoot }),
  };
}
