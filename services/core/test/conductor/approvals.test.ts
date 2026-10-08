/**
 * Approvals that arrive in an awkward order: two sends at once, two answers
 * at once, Stop while asking, an answer that missed its resume, a question
 * nobody answers, questions left behind by a run that ended, and a run the
 * sweeper gives up on.
 */
import type { Message, RunEvent, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewApproval } from '../../src/permissions/store';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const of = <T extends RunEvent['type']>(evs: RunEvent[], type: T) =>
  evs.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

async function lastAssistant(threadId: string): Promise<Message> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  return path.messages.at(-1) as Message;
}

async function askToWrite(path: string) {
  const t = await h.newThread();
  const sent = await h.send(t, `/tool fs_write {"path":"${path}","content":"x"}`);
  expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
  const ask = of(await h.eventsOf(sent.run_id), 'approval.required')[0];
  return { t, sent, approvalId: ask?.approval_id as string };
}

describe('one live run per thread', () => {
  it('lets only one of two simultaneous sends start, and leaves nothing behind for the other', async () => {
    h = await harness();
    const t = await h.newThread();
    // Both pass the quick check before either has created its run.
    const original = h.runs.activeForThread.bind(h.runs);
    h.runs.activeForThread = async () => [];
    const body = { parent_id: null, parts: [{ type: 'text', text: '/slow one two three four' }] };
    const [a, b] = await Promise.all([
      h.call<{ run_id?: string; error?: { code: string } }>('POST', `/threads/${t}/messages`, body),
      h.call<{ run_id?: string; error?: { code: string } }>('POST', `/threads/${t}/messages`, body),
    ]);
    h.runs.activeForThread = original;
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const lost = a.status === 409 ? a : b;
    expect(lost.body.error?.code).toBe('run.already_running');
    // The winner's user message and reply only.
    expect(await h.repo.messages(t)).toHaveLength(2);
    const won = (a.status === 202 ? a : b).body.run_id as string;
    await h.call('POST', `/runs/${won}/cancel`);
    await h.settle(won);
  });
});

describe('answering approvals', () => {
  it('creates at most one grant when two answers race', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('docs/race.md');
    const [a, b] = await Promise.all([
      h.call('POST', `/approvals/${approvalId}`, {
        decision: 'approve',
        scope: 'always',
        pattern: 'fs:/workspace/docs/**',
      }),
      h.call('POST', `/approvals/${approvalId}`, {
        decision: 'deny',
        scope: 'always',
        pattern: 'fs:/workspace/docs/**',
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await h.call<{ items: unknown[] }>('GET', '/grants')).body.items).toHaveLength(1);
    await h.settle(sent.run_id);
  });

  it('refuses to remember a pattern wider than the suggestions', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('docs/wide.md');
    for (const pattern of ['**', 'fs:/**', 'fs:/work*']) {
      const r = await h.call<{ error: { code: string } }>('POST', `/approvals/${approvalId}`, {
        decision: 'approve',
        scope: 'always',
        pattern,
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('permission.pattern_too_broad');
    }
    // A narrower pattern of the person's own is fine.
    const ok = await h.call('POST', `/approvals/${approvalId}`, {
      decision: 'approve',
      scope: 'thread',
      pattern: 'fs:/workspace/docs/*.md',
    });
    expect(ok.status).toBe(200);
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
  });

  it('withdraws the question when Stop lands while it is being asked', async () => {
    h = await harness();
    const original = h.perms.createApproval.bind(h.perms);
    h.perms.createApproval = async (a: NewApproval) => {
      const created = await original(a);
      await h.worker.cancel(a.runId);
      return created;
    };
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"stop.md","content":"x"}');
    expect((await h.settle(sent.run_id)).status).toBe('cancelled');
    expect(await h.perms.pendingApprovals()).toHaveLength(0);
    expect((await lastAssistant(t)).status).toBe('stopped');
  });

  it('resumes a paused run whose answer never reached it', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('missed.md');
    // Answered behind the worker's back: no resume was sent.
    await h.perms.resolveApproval(approvalId, { status: 'approved' });
    expect((await h.runs.get(sent.run_id))?.status).toBe('waiting_approval');
    await h.worker.reconcileNow();
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
  });

  it('expires a question nobody answers, and the model is told', async () => {
    h = await harness();
    const { t, sent, approvalId } = await askToWrite('late.md');
    const a = h.perms.approvals.get(approvalId);
    expect(a?.expires_at).not.toBeNull();
    if (a) a.expires_at = new Date(Date.now() - 1_000).toISOString();
    await h.worker.reconcileNow();
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    expect(h.perms.approvals.get(approvalId)?.status).toBe('expired');
    const result = (await lastAssistant(t)).parts.find((p) => p.type === 'tool_result');
    expect(result).toMatchObject({ ok: false, declined_reason: 'Nobody answered in time' });
    expect((await h.perms.listDecisions())[0]).toMatchObject({ outcome: 'expired', approval_id: approvalId });
  });

  it('withdraws questions when their run is cancelled, and clears stale ones on reconcile', async () => {
    h = await harness();
    const { sent, approvalId } = await askToWrite('gone.md');
    await h.call('POST', `/runs/${sent.run_id}/cancel`);
    expect(h.perms.approvals.get(approvalId)?.status).toBe('cancelled');

    // A pending question for a run that already ended (left by an older Core).
    const stale = await h.perms.createApproval({
      runId: sent.run_id,
      stepSeq: 9,
      threadId: null,
      callId: 'call_stale',
      principal: 'agent:default',
      tool: 'fs_write',
      action: 'fs.write',
      resource: 'fs:/workspace/x',
      args: {},
      argsPreview: {},
      tier: 'gated',
      suggestions: [],
    });
    await h.worker.reconcileNow();
    expect(h.perms.approvals.get(stale.id)?.status).toBe('cancelled');
  });

  it('reuses the approval when the same call asks twice (a retry after a crash)', async () => {
    h = await harness();
    const ask: NewApproval = {
      runId: 'run_1',
      stepSeq: 1,
      threadId: null,
      callId: 'call_1',
      principal: 'agent:default',
      tool: 'fs_write',
      action: 'fs.write',
      resource: 'fs:/workspace/a',
      args: {},
      argsPreview: {},
      tier: 'gated',
      suggestions: [],
    };
    const first = await h.perms.createApproval(ask);
    const again = await h.perms.createApproval({ ...ask, stepSeq: 2 });
    expect(again.id).toBe(first.id);
    expect(await h.perms.pendingApprovals()).toHaveLength(1);
  });

  it('marks the reply as failed when the sweeper gives up on its run', async () => {
    h = await harness();
    const { t, sent } = await askToWrite('sweep.md');
    // Pretend it has been running on a dead worker four times already.
    const r = h.runs.runs.get(sent.run_id);
    if (r) Object.assign(r, { status: 'running', attempt: 4, leaseOwner: 'dead', leaseUntil: 0 });
    await h.restart();
    expect((await h.runs.get(sent.run_id))?.status).toBe('failed');
    const m = await lastAssistant(t);
    expect(m.status).toBe('error');
    expect((m.provenance as { error?: { code: string } }).error?.code).toBe('run.crashed');
    expect(of(await h.eventsOf(sent.run_id), 'done')).toHaveLength(1);
    expect(await h.perms.pendingApprovals()).toHaveLength(0);
  });
});
