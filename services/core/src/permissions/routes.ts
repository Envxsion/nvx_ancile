/**
 * ------------------------------------------------------------------
 *  Title    |  Approvals, grants and decisions
 *  Ref      |  DESIGN.md §5.4–§5.6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Answer the question a paused run is asking, and manage
 *           |  what "remember this" left behind.
 *  How      |  Answering an approval, in order:
 *           |    1. it must still be pending (a second click is a no-op)
 *           |    2. CRITICAL never creates a grant: any scope other
 *           |       than "once" is refused, whatever the client sends
 *           |    3. a remembered answer's pattern must cover the
 *           |       resource asked about, and be no wider than the
 *           |       broadest suggestion (never a bare ** or /**)
 *           |    4. the approval is resolved (compare-and-set); only the
 *           |       answer that wins creates its grant, so two clicks at
 *           |       once can never leave an allow and a deny behind
 *           |    5. the decision is logged, the run's stream and every
 *           |       tab hear about it, and the run is queued to resume
 *           |    6. a remembered answer settles the other waiting
 *           |       requests it covers, each decided again by the gate
 *           |       on its real arguments (decideAgain), never by the
 *           |       pattern alone
 *           |  A site rule (web:*, web:example.com, …) covers searches
 *           |  and fetches, so its grant's action is web.*.
 *           |  Approving once with changed arguments (updated_args) is
 *           |  for an approval that says args_editable (a live Claude
 *           |  Code session's tool call): the permission is decided
 *           |  again on the new arguments first, a deny refuses it, and
 *           |  the waiting tool runs with them.
 *           |  Editing a grant may narrow its pattern (never widen it),
 *           |  change its scope (Careful never widens past a thread)
 *           |  or its expiry. A revocation can be taken back for ten
 *           |  minutes (the Undo on the toast), and not after.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type Approval,
  ApprovalDecisionRequest,
  BatchDecisionRequest,
  type BatchDecisionResult,
  type GrantScope,
  PatchGrantRequest,
  PermissionPreset,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { currentContext, newTraceId } from '../context';
import type { EventBus } from '../events/bus';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import type { RunEventLog } from '../runs/events';
import type { RunWorker } from '../runs/worker';
import { type DecisionResult, grantInScope } from './decide';
import { grantActionFor, isWebPattern, matchAction, matchResource, webPatternNarrows } from './glob';
import type { ApprovalRecord, GrantPatch, PermissionStore } from './store';

export interface PermissionRouteDeps {
  store: PermissionStore;
  /** The permission preset (Settings → Permissions); setting it reloads the policies. */
  preset?: { get(): Promise<PermissionPreset>; set(next: PermissionPreset): Promise<void> };
  events: RunEventLog;
  bus?: EventBus;
  worker: Pick<RunWorker, 'resume'>;
  userId: string;
  /** Relay an answer elsewhere (the lab's engine or a Claude Code session is waiting on it). */
  onResolved?: (
    approval: ApprovalRecord,
    status: 'approved' | 'denied' | 'expired',
    reason: string | null,
    updatedArgs?: unknown,
  ) => Promise<unknown>;
  /** Does the tool waiting on this approval take changed arguments? */
  editable?: (approval: ApprovalRecord) => boolean;
  /** Decide again on changed arguments (the gate, on the real tool's mapping). */
  recheck?: (approval: ApprovalRecord, args: unknown) => Promise<DecisionResult>;
  /**
   * Decide a still-pending approval again, on its real arguments, now (the
   * gate). Used after a remembered answer is saved: the other requests it
   * now covers are settled by what this says, never by the pattern alone.
   */
  decideAgain?: (approval: ApprovalRecord) => Promise<DecisionResult | null>;
  /** Scope refs for a remembered answer, read from the run's thread. */
  scopeRefs(
    approval: ApprovalRecord,
  ): Promise<{ threadId: string | null; notebookId: string | null; workspaceId: string }>;
}

const approvalOut = (a: ApprovalRecord, editable = false): Approval => ({
  id: a.id,
  run_id: a.run_id,
  thread_id: a.thread_id,
  tool: a.tool,
  action: a.action,
  resource: a.resource,
  tier: a.tier,
  args_preview: a.args_preview,
  ...(editable && { args: a.args, args_editable: true }),
  suggestions: a.suggestions,
  status: a.status,
  created_at: a.created_at,
  expires_at: a.expires_at,
});

/** How long a revoked grant can be put back (the toast's Undo). */
export const GRANT_RESTORE_WINDOW_MS = 10 * 60_000;

const SCOPE_RANK: Record<GrantScope, number> = { thread: 0, notebook: 1, workspace: 2, always: 3 };

/**
 * An edited pattern may only narrow: everything it matches, the granted one
 * matched too. It must read as a resource the old glob covers, and it may not
 * bring in a `**` the old one did not have (fs:/a/* would match the text
 * fs:/a/**, but the second reaches any depth).
 */
export function patternNarrows(granted: string, next: string): boolean {
  if (next === granted) return true;
  if (isWebPattern(granted) || isWebPattern(next)) return webPatternNarrows(granted, next);
  if (!matchResource(granted, next)) return false;
  return !next.includes('**') || granted.includes('**');
}

/** The literal start of a glob, up to its first wildcard. */
const literalPrefix = (pattern: string) => pattern.split('*')[0] ?? '';

/**
 * A remembered pattern may be any suggestion, or anything whose literal start
 * lies inside the broadest suggestion's (so fs:/workspace/papers/*.pdf is fine
 * under fs:/workspace/**, but ** or fs:/** is not).
 */
export function patternAllowed(
  pattern: string,
  a: Pick<ApprovalRecord, 'resource' | 'suggestions'> & { action?: string },
): boolean {
  if (pattern === a.resource || a.suggestions.includes(pattern)) return true;
  // A site rule is for searches and fetches only, and may be as wide as web:*.
  if (isWebPattern(pattern)) return !!a.action?.startsWith('web.');
  const start = literalPrefix(pattern);
  return [a.resource, ...a.suggestions].some((s) => {
    const bound = literalPrefix(s);
    return bound.length > 0 && start.startsWith(bound);
  });
}

export function permissionRoutes(deps: PermissionRouteDeps) {
  const r = new Hono<AppEnv>();
  const { store } = deps;
  const out = (a: ApprovalRecord) => approvalOut(a, a.status === 'pending' && !!deps.editable?.(a));

  r.get('/approvals', async (c) =>
    c.json({ items: (await store.pendingApprovals()).map(out), next_cursor: null }),
  );

  r.get('/approvals/:id', async (c) => {
    const a = await store.getApproval(c.req.param('id'));
    if (!a) throw notFound('That approval');
    return c.json(out(a));
  });

  r.get('/permissions/preset', async (c) => c.json({ preset: (await deps.preset?.get()) ?? 'balanced' }));

  r.put('/permissions/preset', async (c) => {
    const { preset } = await body(c, z.object({ preset: PermissionPreset }));
    if (!deps.preset) throw notFound('Permission presets');
    await deps.preset.set(preset);
    return c.json({ preset });
  });

  /** Answer one approval (the single route and the batch route share it). */
  const answer = async (
    a: ApprovalRecord,
    req: z.infer<typeof ApprovalDecisionRequest>,
  ): Promise<Approval & { grant_id?: string | null }> => {
    if (a.status !== 'pending') return approvalOut(a);

    // Approve once with changed arguments: only where the waiting tool takes them, and decided again.
    if (req.updated_args !== undefined) {
      if (req.decision !== 'approve' || req.scope !== 'once')
        throw new AncileError({
          code: 'permission.edit_needs_once',
          title: 'Changed arguments can only be approved once',
          hint: 'Choose "Just this once" to run it with your changes, or approve the original.',
          status: 422,
          errorClass: 'permanent',
        });
      if (!deps.editable?.(a) || !deps.recheck)
        throw new AncileError({
          code: 'permission.args_not_editable',
          title: "This tool's arguments can't be changed",
          hint: 'Approve or deny it as it is.',
          status: 422,
          errorClass: 'permanent',
        });
      const again = await deps.recheck(a, req.updated_args);
      if (again.outcome === 'deny')
        throw new AncileError({
          code: 'permission.edited_args_denied',
          title: 'Your changes are not allowed',
          hint:
            again.via === 'policy'
              ? `A policy blocks the changed call (${again.policyId ?? 'policy'}). Undo the change, or deny it.`
              : `${again.reason}. Undo the change, or deny it.`,
          status: 422,
          errorClass: 'permanent',
        });
    }

    // Careful remembers an answer for the thread at most.
    if (req.scope !== 'once' && req.scope !== 'thread' && (await deps.preset?.get()) === 'careful') {
      throw new AncileError({
        code: 'permission.scope_too_wide',
        title: 'Careful remembers answers for this thread only',
        hint: 'Choose "In this thread" or "Just this once", or switch to Balanced in Admin → Permissions.',
        status: 422,
        errorClass: 'permanent',
      });
    }

    if (a.tier === 'critical' && req.scope !== 'once') {
      throw new AncileError({
        code: 'permission.critical_not_rememberable',
        title: "Critical actions can't be remembered",
        hint: 'Approve this once instead.',
        status: 422,
        errorClass: 'permanent',
      });
    }

    const pattern = req.pattern ?? a.resource;
    let grant: Parameters<PermissionStore['createGrant']>[0] | null = null;
    if (req.scope !== 'once') {
      if (!matchResource(pattern, a.resource)) {
        throw new AncileError({
          code: 'permission.pattern_too_broad',
          title: "That pattern doesn't cover what was asked",
          hint: `Choose a pattern that matches ${a.resource}.`,
          status: 422,
          errorClass: 'permanent',
        });
      }
      if (!patternAllowed(pattern, a)) {
        throw new AncileError({
          code: 'permission.pattern_too_broad',
          title: 'That pattern is wider than this tool allows',
          hint: `Choose one of the suggested patterns, or a narrower one${a.suggestions.length ? ` (the widest is ${a.suggestions.at(-1)})` : ''}.`,
          status: 422,
          errorClass: 'permanent',
        });
      }
      const refs = await deps.scopeRefs(a);
      const scope = req.scope as GrantScope;
      const scopeRef =
        scope === 'thread'
          ? refs.threadId
          : scope === 'notebook'
            ? refs.notebookId
            : scope === 'workspace'
              ? refs.workspaceId
              : null;
      if ((scope === 'thread' || scope === 'notebook') && !scopeRef) {
        throw new AncileError({
          code: 'request.invalid',
          title: scope === 'notebook' ? 'This thread is not in a notebook' : 'This run has no thread',
          hint: 'Choose a wider scope, or approve this once.',
          status: 422,
          errorClass: 'permanent',
        });
      }
      grant = {
        userId: deps.userId,
        principal: a.principal,
        actionPattern: grantActionFor(pattern, a.action),
        resourcePattern: pattern,
        effect: req.decision === 'approve' ? 'allow' : 'deny',
        scope,
        scopeRef,
        expiresAt: req.ttl_seconds ? new Date(Date.now() + req.ttl_seconds * 1000).toISOString() : null,
        fromApprovalId: a.id,
      };
    }

    // Resolve first: only the answer that wins leaves a grant behind.
    const status = req.decision === 'approve' ? 'approved' : 'denied';
    const won = await store.resolveApproval(a.id, {
      status,
      decidedBy: deps.userId,
      scope: req.scope,
      pattern: req.scope === 'once' ? null : pattern,
      reason: req.reason ?? null,
    });
    if (!won) return approvalOut((await store.getApproval(a.id)) ?? a);
    const grantId = grant ? (await store.createGrant(grant)).id : null;

    await store.recordDecision({
      userId: deps.userId,
      principal: a.principal,
      action: a.action,
      resource: a.resource,
      tier: a.tier,
      outcome: status,
      grantId,
      approvalId: a.id,
      runId: a.run_id,
      traceId: currentContext()?.traceId ?? newTraceId(),
    });
    await announce(a, status, req.reason ?? null, req.updated_args);
    if (grant && grantId) await settleCovered(a, grant);
    return { ...approvalOut({ ...a, status }), grant_id: grantId };
  };

  /** Tell the run, every tab and whoever is waiting, then let the run go on. */
  const announce = async (
    a: ApprovalRecord,
    status: 'approved' | 'denied',
    reason: string | null,
    updatedArgs?: unknown,
  ) => {
    await deps.events.append(a.run_id, { type: 'approval.resolved', approval_id: a.id, decision: status });
    await deps.bus?.publish({ type: 'approval.resolved', approval_id: a.id }).catch(() => undefined);
    await deps.onResolved?.(a, status, reason, updatedArgs);
    await deps.worker.resume(a.run_id);
  };

  /**
   * A remembered answer was just saved: every other request still waiting
   * that it covers (same agent, action and resource, in its scope) is
   * decided again through the gate, on its real arguments, and settled by
   * that decision. One the gate still asks about (critical, escalated, a
   * floor) stays waiting.
   */
  const settleCovered = async (
    from: ApprovalRecord,
    g: NonNullable<Parameters<PermissionStore['createGrant']>[0]>,
  ): Promise<void> => {
    if (!deps.decideAgain) return;
    for (const p of await store.pendingApprovals()) {
      if (p.id === from.id || p.status !== 'pending' || p.tier === 'critical') continue;
      if (p.principal !== g.principal) continue;
      if (!matchAction(g.actionPattern, p.action) || !matchResource(g.resourcePattern, p.resource)) continue;
      const refs = await deps.scopeRefs(p);
      const like = {
        id: '',
        principal: g.principal,
        actionPattern: g.actionPattern,
        resourcePattern: g.resourcePattern,
        effect: g.effect,
        scope: g.scope,
        scopeRef: g.scopeRef,
        expiresAt: g.expiresAt,
        revokedAt: null,
      };
      if (!grantInScope(like, refs)) continue;
      const d = await deps.decideAgain(p).catch(() => null);
      if (!d || d.outcome === 'ask') continue;
      const status = d.outcome === 'allow' ? 'approved' : 'denied';
      const reason = d.outcome === 'deny' ? d.reason : null;
      const won = await store.resolveApproval(p.id, {
        status,
        decidedBy: deps.userId,
        scope: 'once',
        pattern: null,
        reason,
      });
      if (won) await announce(p, status, reason);
    }
  };

  /**
   * Auto mode groups its asks: answer several at once, each "just this once".
   * One that is gone or already answered is reported, never an error.
   */
  r.post('/approvals/batch', async (c) => {
    const req = await body(c, BatchDecisionRequest);
    const items: BatchDecisionResult['items'] = [];
    for (const id of [...new Set(req.approval_ids)]) {
      const a = await store.getApproval(id);
      if (!a) {
        items.push({ approval_id: id, status: 'missing' });
        continue;
      }
      const out = await answer(a, {
        decision: req.decision,
        scope: 'once',
        ...(req.reason !== undefined && { reason: req.reason }),
      });
      items.push({ approval_id: id, status: out.status });
    }
    return c.json({ items });
  });

  // After /approvals/batch, so "batch" is never read as an id.
  r.post('/approvals/:id', async (c) => {
    const a = await store.getApproval(c.req.param('id'));
    if (!a) throw notFound('That approval');
    const req = await body(c, ApprovalDecisionRequest);
    return c.json(await answer(a, req));
  });

  r.get('/grants', async (c) => c.json({ items: await store.listGrants(), next_cursor: null }));

  r.patch('/grants/:id', async (c) => {
    const id = c.req.param('id');
    const req = await body(c, PatchGrantRequest);
    const g = (await store.listGrants()).find((x) => x.id === id);
    if (!g) throw notFound('That grant');
    const patch: GrantPatch = {};
    if (req.ttl_seconds !== undefined)
      patch.expiresAt =
        req.ttl_seconds === null ? null : new Date(Date.now() + req.ttl_seconds * 1000).toISOString();
    if (req.resource_pattern !== undefined && req.resource_pattern !== g.resource_pattern) {
      if (!patternNarrows(g.resource_pattern, req.resource_pattern)) {
        throw new AncileError({
          code: 'permission.pattern_too_broad',
          title: 'That pattern is wider than the one you granted',
          hint: `An edit can only narrow a grant. Choose a pattern inside ${g.resource_pattern}, or revoke this one and answer the next request afresh.`,
          status: 422,
          errorClass: 'permanent',
        });
      }
      patch.resourcePattern = req.resource_pattern;
    }
    if (req.scope !== undefined && req.scope !== g.scope) {
      const wider = SCOPE_RANK[req.scope] > SCOPE_RANK[g.scope];
      if (wider && req.scope !== 'thread' && (await deps.preset?.get()) === 'careful') {
        throw new AncileError({
          code: 'permission.scope_too_wide',
          title: 'Careful remembers answers for this thread only',
          hint: 'Keep the scope it has or narrow it, or switch to Balanced in Admin → Permissions.',
          status: 422,
          errorClass: 'permanent',
        });
      }
      let scopeRef: string | null = null;
      if (req.scope !== 'always') {
        const a = g.created_from_approval_id
          ? await store.getApproval(g.created_from_approval_id)
          : undefined;
        const refs = a ? await deps.scopeRefs(a) : null;
        scopeRef =
          req.scope === 'thread'
            ? (refs?.threadId ?? null)
            : req.scope === 'notebook'
              ? (refs?.notebookId ?? null)
              : (refs?.workspaceId ?? null);
        if (!scopeRef) {
          throw new AncileError({
            code: 'request.invalid',
            title:
              req.scope === 'notebook'
                ? 'The thread this came from is not in a notebook'
                : 'NVX Ancile no longer knows where this grant came from',
            hint: 'Choose another scope, or revoke this grant and answer the next request afresh.',
            status: 422,
            errorClass: 'permanent',
          });
        }
      }
      patch.scope = req.scope;
      patch.scopeRef = scopeRef;
    }
    if (!Object.keys(patch).length) return c.json(g);
    const out = await store.updateGrant(id, patch);
    if (!out) throw notFound('That grant');
    return c.json(out);
  });

  r.delete('/grants/:id', async (c) => {
    if (!(await store.revokeGrant(c.req.param('id')))) throw notFound('That grant');
    return c.body(null, 204);
  });

  /** Undo a revocation, within GRANT_RESTORE_WINDOW_MS. */
  r.post('/grants/:id/restore', async (c) => {
    const g = await store.restoreGrant(c.req.param('id'), GRANT_RESTORE_WINDOW_MS);
    if (!g) {
      throw new AncileError({
        code: 'permission.restore_expired',
        title: 'Too late to undo that revocation',
        hint: 'The agent will ask again next time; remember the answer then.',
        status: 410,
        errorClass: 'permanent',
      });
    }
    return c.json(g);
  });

  r.get('/decisions', async (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200) || 200));
    return c.json({ items: await store.listDecisions(limit), next_cursor: null });
  });

  return r;
}
