/**
 * An approval belongs to the call you saw. It is stored with a hash of the arguments it asked about
 * (or the ones the person edited), and a run that resumes under it runs the waiting call only if its
 * arguments hash the same; anything else asks again. Just before an approved call runs, the refusals
 * that can still apply are asked again on its real arguments. An approval from before hashes
 * (0047) vouches for nothing, so a call still waiting on one asks again.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, RunEvent, ThreadPath } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { approvedFor, hashArgs } from '../../src/permissions/argsHash';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import type { PolicyEvaluator } from '../../src/permissions/decide';
import { permissionRoutes } from '../../src/permissions/routes';
import { MemoryPermissionStore, type NewApproval } from '../../src/permissions/store';
import { MemoryRunEventLog } from '../../src/runs/events';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const of = <T extends RunEvent['type']>(evs: RunEvent[], type: T) =>
  evs.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

async function lastAssistant(threadId: string): Promise<Message> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  return path.messages.at(-1) as Message;
}

async function askToWrite(path: string, content = 'x') {
  const t = await h.newThread();
  const sent = await h.send(t, `/tool fs_write ${JSON.stringify({ path, content })}`);
  expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
  const ask = of(await h.eventsOf(sent.run_id), 'approval.required')[0];
  return { t, sent, approvalId: ask?.approval_id as string };
}

const on = (name: string) => existsSync(join(h.dir, name));

describe('what an approval is bound to', () => {
  it('stores the hash of what was asked, and of what was approved', async () => {
    h = await harness();
    const { approvalId } = await askToWrite('bound-a.md', 'one');
    const asked = h.perms.approvals.get(approvalId);
    const args = { path: 'bound-a.md', content: 'one' };
    expect(asked?.args_hash).toBe(hashArgs(args));
    expect(asked?.approved_args_hash).toBeNull();
    expect(
      (await h.call('POST', `/approvals/${approvalId}`, { decision: 'approve', scope: 'once' })).status,
    ).toBe(200);
    const done = h.perms.approvals.get(approvalId);
    expect(done?.approved_args_hash).toBe(hashArgs(args));
    expect(approvedFor(done as never, args)).toBe(true);
    expect(approvedFor(done as never, { ...args, content: 'two' })).toBe(false);
    // A denial approves nothing.
    const second = await askToWrite('bound-b.md');
    await h.call('POST', `/approvals/${second.approvalId}`, { decision: 'deny', scope: 'once' });
    expect(h.perms.approvals.get(second.approvalId)?.approved_args_hash).toBeNull();
  });

  it('hashes edited arguments, not the ones first asked about', async () => {
    const store = new MemoryPermissionStore();
    const app = new Hono<AppEnv>();
    app.route(
      '/',
      permissionRoutes({
        store,
        events: new MemoryRunEventLog(),
        worker: { resume: async () => undefined } as never,
        userId: 'usr_1',
        editable: () => true,
        recheck: async () => ({ outcome: 'allow', via: 'auto', tier: 'gated', resource: 'shell:ls' }),
        scopeRefs: async () => ({ threadId: null, notebookId: null, workspaceId: 'wsp_1' }),
      }),
    );
    const ask = (call: string): NewApproval => ({
      runId: 'run_1',
      stepSeq: 1,
      threadId: null,
      callId: call,
      principal: 'agent:claude-code',
      tool: 'Bash',
      action: 'shell.exec',
      resource: 'shell:ls',
      args: { command: 'ls' },
      argsPreview: { command: 'ls' },
      tier: 'gated',
      suggestions: [],
    });
    const created = await store.createApproval(ask('call_1'));
    const res = await app.request(`/approvals/${created.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scope: 'once', updated_args: { command: 'ls -la' } }),
    });
    expect(res.status).toBe(200);
    const after = await store.getApproval(created.id);
    expect(after?.args_hash).toBe(hashArgs({ command: 'ls' }));
    expect(after?.approved_args_hash).toBe(hashArgs({ command: 'ls -la' }));
    // The original arguments are not what was approved.
    expect(approvedFor(after as never, { command: 'ls' })).toBe(false);
    expect(approvedFor(after as never, { command: 'ls -la' })).toBe(true);
    // Asking the same call again with the original arguments is a new question, not the edited answer.
    const again = await store.createApproval(ask('call_1'));
    expect(again.id).not.toBe(created.id);
    expect(again.status).toBe('pending');
  });
});

describe('a call that is not the one approved does not run', () => {
  it('asks again when the approval was given for other arguments', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('bound-c.md');
    const first = h.perms.approvals.get(approvalId);
    // What a hostile caller would leave behind: an approval for other arguments, on this very call.
    if (first) {
      first.status = 'approved';
      first.approved_args_hash = hashArgs({ path: 'other.md', content: 'x' });
    }
    await h.worker.reconcileNow();
    expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
    expect(on('bound-c.md')).toBe(false);
    // A new question, for this call's own arguments.
    const pending = await h.perms.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).not.toBe(approvalId);
    expect(pending[0]?.args_hash).toBe(first?.args_hash);
    // Answering it runs the call, and only now.
    expect(
      (await h.call('POST', `/approvals/${pending[0]?.id}`, { decision: 'approve', scope: 'once' })).status,
    ).toBe(200);
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    expect(on('bound-c.md')).toBe(true);
  });

  it('asks again when the approval is one from before arguments were hashed', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('bound-d.md');
    const old = h.perms.approvals.get(approvalId);
    if (old) {
      // As a row from before migration 0047 reads: answered, with neither hash.
      old.status = 'approved';
      old.args_hash = null;
      old.approved_args_hash = null;
    }
    await h.worker.reconcileNow();
    expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
    expect(on('bound-d.md')).toBe(false);
    expect(await h.perms.pendingApprovals()).toHaveLength(1);
  });

  it('asks again when an answer given without a hash reaches a run', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('bound-e.md');
    await h.perms.resolveApproval(approvalId, { status: 'approved' });
    await h.worker.reconcileNow();
    expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
    expect(on('bound-e.md')).toBe(false);
  });

  it('still takes a declined answer without looking at arguments', async () => {
    h = await harness();
    const { t, sent, approvalId } = await askToWrite('bound-f.md');
    await h.perms.resolveApproval(approvalId, { status: 'denied', reason: 'No' });
    await h.worker.reconcileNow();
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    expect(on('bound-f.md')).toBe(false);
    expect((await lastAssistant(t)).parts.find((p) => p.type === 'tool_result')).toMatchObject({
      ok: false,
      declined_reason: 'No',
    });
  });
});

describe('the checks that can still say no are made again after an approval', () => {
  it('refuses an approved call that a policy has since forbidden', async () => {
    let forbid = false;
    const builtin = new BuiltinPolicy();
    const policy: PolicyEvaluator = {
      forbids: async (r) =>
        forbid ? { forbidden: true, policyId: 'test.now-forbidden' } : builtin.forbids(r),
      escalation: (r) => builtin.escalation(r),
    };
    h = await harness({ policy });
    const { t, sent, approvalId } = await askToWrite('bound-g.md');
    forbid = true;
    expect(
      (await h.call('POST', `/approvals/${approvalId}`, { decision: 'approve', scope: 'once' })).status,
    ).toBe(200);
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    expect(on('bound-g.md')).toBe(false);
    const result = (await lastAssistant(t)).parts.find((p) => p.type === 'tool_result');
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain('test.now-forbidden');
    // It is in the decision log as a policy denial.
    expect((await h.perms.listDecisions()).some((d) => d.outcome === 'policy_deny')).toBe(true);
  });

  it('refuses an approved call that a grant to deny it has since covered', async () => {
    h = await harness();
    const { t, sent, approvalId } = await askToWrite('bound-h.md');
    await h.perms.createGrant({
      userId: 'usr_1',
      principal: 'agent:default',
      actionPattern: 'fs.write',
      resourcePattern: 'fs:/workspace/bound-h.md',
      effect: 'deny',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
    await h.call('POST', `/approvals/${approvalId}`, { decision: 'approve', scope: 'once' });
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    expect(on('bound-h.md')).toBe(false);
    expect((await lastAssistant(t)).parts.find((p) => p.type === 'tool_result')).toMatchObject({ ok: false });
  });

  it('runs an approved call nothing has changed about', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('bound-i.md');
    await h.call('POST', `/approvals/${approvalId}`, { decision: 'approve', scope: 'once' });
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    expect(on('bound-i.md')).toBe(true);
  });
});

describe('the same call asked again', () => {
  it('is the same question with the same arguments, and a new one with other arguments', async () => {
    const store = new MemoryPermissionStore();
    const base = (args: unknown): NewApproval => ({
      runId: 'run_9',
      stepSeq: 1,
      threadId: null,
      callId: 'call_9',
      principal: 'agent:default',
      tool: 'fs_write',
      action: 'fs.write',
      resource: 'fs:/workspace/a.md',
      args,
      argsPreview: args,
      tier: 'gated',
      suggestions: [],
    });
    const first = await store.createApproval(base({ path: 'a.md', content: 'x' }));
    // Key order does not make it another question.
    expect((await store.createApproval(base({ content: 'x', path: 'a.md' }))).id).toBe(first.id);
    const other = await store.createApproval(base({ path: 'a.md', content: 'y' }));
    expect(other.id).not.toBe(first.id);
    expect(other.status).toBe('pending');
    // The old question was withdrawn, not left pending beside it.
    expect((await store.getApproval(first.id))?.status).toBe('cancelled');
    expect((await store.pendingApprovals()).map((a) => a.id)).toEqual([other.id]);
  });
});
