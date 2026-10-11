/**
 * Grants, approvals and decisions (DESIGN.md §5): the same rules from the
 * in-memory store and the Postgres one.
 */
import { beforeEach, expect, it } from 'vitest';
import {
  MemoryPermissionStore,
  type NewApproval,
  type PermissionStore,
  PgPermissionStore,
} from '../../src/permissions/store';
import type { RunStore } from '../../src/runs/engine';
import { MemoryRunStore, PgRunStore } from '../../src/runs/store';
import { eachBackend, uid } from '../support/stores';

eachBackend('permission store', (backend) => {
  let perms: PermissionStore;
  let runs: RunStore;
  let user: string;

  beforeEach(() => {
    const b = backend();
    user = b.owner.userId;
    perms = b.sql ? new PgPermissionStore(b.sql) : new MemoryPermissionStore();
    runs = b.sql ? new PgRunStore(b.sql) : new MemoryRunStore();
  });

  const run = async () =>
    (
      await runs.create({
        id: uid('run'),
        kind: 'chat_turn',
        traceId: '3'.repeat(32),
        threadId: null,
        messageId: null,
        checkpoint: {},
      })
    ).id;

  const approval = (runId: string, callId = uid('call')): NewApproval => ({
    runId,
    stepSeq: 1,
    threadId: null,
    callId,
    principal: 'agent:chat',
    tool: 'fs_write',
    action: 'fs.write',
    resource: 'file:/workspace/notes.md',
    args: { path: 'notes.md', content: 'hi' },
    argsPreview: { path: 'notes.md' },
    tier: 'gated',
    suggestions: ['this file', 'this folder'],
  });

  it('keeps grants: create, find by principal, extend, use and revoke', async () => {
    const principal = uid('agent');
    const g = await perms.createGrant({
      userId: user,
      principal,
      actionPattern: 'fs.write',
      resourcePattern: 'file:/workspace/**',
      effect: 'allow',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
    expect(g).toMatchObject({ principal, action_pattern: 'fs.write', effect: 'allow' });
    expect((await perms.forPrincipal(principal)).map((x) => x.id)).toEqual([g.id]);
    expect((await perms.listGrants()).some((x) => x.id === g.id)).toBe(true);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await perms.extendGrant(g.id, until))?.expires_at).toBeTruthy();
    await perms.recordGrantUse(g.id);
    expect(await perms.revokeGrant(g.id)).toBe(true);
    expect(await perms.forPrincipal(principal)).toEqual([]);
    expect(await perms.revokeGrant(g.id)).toBe(false);
  });

  it('edits a grant in place and takes a revocation back only within the window', async () => {
    const g = await perms.createGrant({
      userId: user,
      principal: uid('agent'),
      actionPattern: 'fs.write',
      resourcePattern: 'file:/workspace/**',
      effect: 'allow',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
    const edited = await perms.updateGrant(g.id, {
      resourcePattern: 'file:/workspace/notes/**',
      scope: 'thread',
      scopeRef: 'thr_x',
    });
    expect(edited).toMatchObject({
      resource_pattern: 'file:/workspace/notes/**',
      scope: 'thread',
      scope_ref: 'thr_x',
      expires_at: null,
    });
    const until = new Date(Date.now() + 60_000).toISOString();
    expect((await perms.updateGrant(g.id, { expiresAt: until }))?.scope_ref).toBe('thr_x');
    expect((await perms.updateGrant(g.id, { expiresAt: null }))?.expires_at).toBeNull();

    expect(await perms.revokeGrant(g.id)).toBe(true);
    expect(await perms.updateGrant(g.id, { scope: 'always' })).toBeUndefined();
    expect((await perms.restoreGrant(g.id, 60_000))?.revoked_at).toBeNull();
    expect(await perms.restoreGrant(g.id, 60_000)).toBeUndefined(); // not revoked any more
    expect(await perms.revokeGrant(g.id)).toBe(true);
    expect(await perms.restoreGrant(g.id, -1_000)).toBeUndefined(); // the window has passed
  });

  it('asks once per call, resolves once, and lists what is pending', async () => {
    const runId = await run();
    const first = await perms.createApproval(approval(runId, 'call_same'));
    const again = await perms.createApproval(approval(runId, 'call_same'));
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: 'pending', tool: 'fs_write', tier: 'gated' });
    expect((await perms.pendingApprovals()).map((a) => a.id)).toContain(first.id);
    expect((await perms.approvalsForRun(runId)).map((a) => a.id)).toEqual([first.id]);

    expect(
      await perms.resolveApproval(first.id, {
        status: 'approved',
        decidedBy: user,
        scope: 'this file',
        reason: 'fine',
      }),
    ).toBe(true);
    expect(await perms.resolveApproval(first.id, { status: 'denied' })).toBe(false);
    const decided = await perms.getApproval(first.id);
    expect(decided).toMatchObject({ status: 'approved', decision_scope: 'this file', reason: 'fine' });
    expect((await perms.pendingApprovals()).map((a) => a.id)).not.toContain(first.id);
  });

  it('expires approvals that ran out of time, and cancels a run’s pending ones', async () => {
    const runId = await run();
    const old = await perms.createApproval({
      ...approval(runId),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const live = await perms.createApproval(approval(runId));
    expect((await perms.expireDue(new Date())).map((a) => a.id)).toContain(old.id);
    expect((await perms.getApproval(old.id))?.status).toBe('expired');
    expect(await perms.cancelApprovalsForRun(runId)).toEqual([live.id]);
    expect((await perms.getApproval(live.id))?.status).toBe('cancelled');
  });

  it('records decisions, newest first overall and oldest first per run', async () => {
    const runId = await run();
    const base = {
      userId: user,
      principal: 'agent:chat',
      resource: 'file:/workspace/a.md',
      traceId: '4'.repeat(32),
      runId,
    };
    await perms.recordDecision({ ...base, action: 'fs.read', tier: 'auto', outcome: 'auto' });
    await perms.recordDecision({ ...base, action: 'fs.write', tier: 'gated', outcome: 'approved' });
    const forRun = await perms.decisionsForRun(runId);
    expect(forRun.map((d) => d.action)).toEqual(['fs.read', 'fs.write']);
    const recent = await perms.listDecisions(500);
    expect(recent.findIndex((d) => d.id === forRun[1]?.id)).toBeLessThan(
      recent.findIndex((d) => d.id === forRun[0]?.id),
    );
  });
});
