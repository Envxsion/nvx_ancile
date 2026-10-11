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
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type Approval,
  ApprovalDecisionRequest,
  type GrantScope,
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
import { matchResource } from './glob';
import type { ApprovalRecord, PermissionStore } from './store';

export interface PermissionRouteDeps {
  store: PermissionStore;
  /** The permission preset (Settings → Permissions); setting it reloads the policies. */
  preset?: { get(): Promise<PermissionPreset>; set(next: PermissionPreset): Promise<void> };
  events: RunEventLog;
  bus?: EventBus;
  worker: Pick<RunWorker, 'resume'>;
  userId: string;
  /** Relay an answer elsewhere (the lab's engine is waiting on it). */
  onResolved?: (
    approval: ApprovalRecord,
    status: 'approved' | 'denied' | 'expired',
    reason: string | null,
  ) => Promise<unknown>;
  /** Scope refs for a remembered answer, read from the run's thread. */
  scopeRefs(
    approval: ApprovalRecord,
  ): Promise<{ threadId: string | null; notebookId: string | null; workspaceId: string }>;
}

const approvalOut = (a: ApprovalRecord): Approval => ({
  id: a.id,
  run_id: a.run_id,
  thread_id: a.thread_id,
  tool: a.tool,
  action: a.action,
  resource: a.resource,
  tier: a.tier,
  args_preview: a.args_preview,
  suggestions: a.suggestions,
  status: a.status,
  created_at: a.created_at,
  expires_at: a.expires_at,
});

const ExtendGrant = z.object({ ttl_seconds: z.number().int().positive().nullable() }).strict();

/** The literal start of a glob, up to its first wildcard. */
const literalPrefix = (pattern: string) => pattern.split('*')[0] ?? '';

/**
 * A remembered pattern may be any suggestion, or anything whose literal start
 * lies inside the broadest suggestion's (so fs:/workspace/papers/*.pdf is fine
 * under fs:/workspace/**, but ** or fs:/** is not).
 */
export function patternAllowed(
  pattern: string,
  a: Pick<ApprovalRecord, 'resource' | 'suggestions'>,
): boolean {
  if (pattern === a.resource || a.suggestions.includes(pattern)) return true;
  const start = literalPrefix(pattern);
  return [a.resource, ...a.suggestions].some((s) => {
    const bound = literalPrefix(s);
    return bound.length > 0 && start.startsWith(bound);
  });
}

export function permissionRoutes(deps: PermissionRouteDeps) {
  const r = new Hono<AppEnv>();
  const { store } = deps;

  r.get('/approvals', async (c) =>
    c.json({ items: (await store.pendingApprovals()).map(approvalOut), next_cursor: null }),
  );

  r.get('/approvals/:id', async (c) => {
    const a = await store.getApproval(c.req.param('id'));
    if (!a) throw notFound('That approval');
    return c.json(approvalOut(a));
  });

  r.get('/permissions/preset', async (c) => c.json({ preset: (await deps.preset?.get()) ?? 'balanced' }));

  r.put('/permissions/preset', async (c) => {
    const { preset } = await body(c, z.object({ preset: PermissionPreset }));
    if (!deps.preset) throw notFound('Permission presets');
    await deps.preset.set(preset);
    return c.json({ preset });
  });

  r.post('/approvals/:id', async (c) => {
    const a = await store.getApproval(c.req.param('id'));
    if (!a) throw notFound('That approval');
    const req = await body(c, ApprovalDecisionRequest);
    if (a.status !== 'pending') return c.json(approvalOut(a));

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
        actionPattern: a.action,
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
    if (!won) return c.json(approvalOut((await store.getApproval(a.id)) ?? a));
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
    await deps.events.append(a.run_id, { type: 'approval.resolved', approval_id: a.id, decision: status });
    await deps.bus?.publish({ type: 'approval.resolved', approval_id: a.id }).catch(() => undefined);
    await deps.onResolved?.(a, status, req.reason ?? null);
    await deps.worker.resume(a.run_id);
    return c.json({ ...approvalOut({ ...a, status }), grant_id: grantId });
  });

  r.get('/grants', async (c) => c.json({ items: await store.listGrants(), next_cursor: null }));

  r.patch('/grants/:id', async (c) => {
    const req = await body(c, ExtendGrant);
    const g = await store.extendGrant(
      c.req.param('id'),
      req.ttl_seconds === null ? null : new Date(Date.now() + req.ttl_seconds * 1000).toISOString(),
    );
    if (!g) throw notFound('That grant');
    return c.json(g);
  });

  r.delete('/grants/:id', async (c) => {
    if (!(await store.revokeGrant(c.req.param('id')))) throw notFound('That grant');
    return c.body(null, 204);
  });

  r.get('/decisions', async (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200) || 200));
    return c.json({ items: await store.listDecisions(limit), next_cursor: null });
  });

  return r;
}
