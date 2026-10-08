/**
 * The lab bridge: engine events become run events and parts, and every
 * engine permission request is answered by Core's gate, never "always".
 */
import { describe, expect, it } from 'vitest';
import type { Engine, EngineEvent, EngineMessage } from '../../src/lab/engine-client';
import { LabMirror } from '../../src/lab/event-mirror';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { MemoryRunEventLog } from '../../src/runs/events';

const place = { realDir: '/srv/ws/labs/thr_1', virtualDir: '/workspace/labs/thr_1' };

function setup() {
  let push: (e: EngineEvent) => void = () => undefined;
  const replies: { id: string; reply: string; message?: string }[] = [];
  // What the engine says about its sessions when Core asks (check()).
  const state = { statuses: {} as Record<string, { type: string }>, messages: [] as EngineMessage[] };
  const engine: Engine = {
    createSession: async () => ({ id: 'ses_1', directory: place.realDir }),
    prompt: async () => undefined,
    abort: async () => undefined,
    reply: async (id, _directory, reply, message) => {
      replies.push({ id, reply, ...(message && { message }) });
    },
    pendingPermissions: async () => [],
    diff: async () => [],
    revert: async () => undefined,
    statuses: async () => state.statuses,
    messages: async () => state.messages,
    follow: async (on) => {
      push = on;
    },
  };
  const events = new MemoryRunEventLog();
  const perms = new MemoryPermissionStore();
  const gate = createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: '/workspace' });
  const mirror = new LabMirror({ engine, events, gate, permissions: perms, userId: 'usr_1' });
  mirror.start();
  const send = async (type: string, properties: Record<string, unknown>) => {
    push({ type, properties });
    await new Promise((r) => setTimeout(r, 5));
  };
  const attach = () =>
    mirror.attach({
      runId: 'run_1',
      traceId: 't'.repeat(32),
      threadId: 'thr_1',
      workspaceId: 'wsp_1',
      messageId: 'msg_a',
      sessionId: 'ses_1',
      place,
    });
  return { mirror, events, perms, replies, send, attach, state };
}

const ask = (id: string, permission: string, metadata: Record<string, unknown>, patterns: string[] = []) => ({
  id,
  sessionID: 'ses_1',
  permission,
  patterns,
  metadata,
});

describe('lab permission bridge', () => {
  it('lets reads inside the lab through, once, and logs the decision', async () => {
    const t = setup();
    await t.attach();
    await t.send('permission.asked', ask('per_1', 'read', { filepath: '/srv/ws/labs/thr_1/src/a.ts' }));
    expect(t.replies).toEqual([{ id: 'per_1', reply: 'once' }]);
    expect((await t.perms.listDecisions())[0]).toMatchObject({
      action: 'fs.read',
      resource: 'fs:/workspace/labs/thr_1/src/a.ts',
      outcome: 'auto',
    });
  });

  it('asks a person before a shell command, and relays the answer as once', async () => {
    const t = setup();
    await t.attach();
    await t.send('permission.asked', ask('per_2', 'bash', { command: 'npm test' }, ['npm test']));
    expect(t.replies).toEqual([]);
    const [approval] = await t.perms.pendingApprovals();
    expect(approval).toMatchObject({
      tier: 'critical',
      action: 'shell.exec',
      resource: 'shell:npm test',
      suggestions: [],
    });
    const evs = await t.events.since('run_1', 0);
    expect(evs.some((e) => e.type === 'approval.required')).toBe(true);
    if (!approval) throw new Error('no approval');
    expect(await t.mirror.resolved(approval, 'approved')).toBe(true);
    expect(t.replies).toEqual([{ id: 'per_2', reply: 'once' }]);
  });

  it('turns a decline into a reject with the reason, which the engine gives the model', async () => {
    const t = setup();
    await t.attach();
    await t.send('permission.asked', ask('per_3', 'edit', { filepath: '/srv/ws/labs/thr_1/a.md' }));
    const [approval] = await t.perms.pendingApprovals();
    if (!approval) throw new Error('no approval');
    await t.mirror.resolved(approval, 'denied', 'not that file');
    expect(t.replies).toEqual([{ id: 'per_3', reply: 'reject', message: 'not that file' }]);
  });

  it('answers from a remembered grant without asking', async () => {
    const t = setup();
    await t.perms.createGrant({
      userId: 'usr_1',
      principal: 'agent:lab',
      actionPattern: 'fs.write',
      resourcePattern: 'fs:/workspace/labs/**',
      effect: 'allow',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
    await t.attach();
    await t.send('permission.asked', ask('per_4', 'edit', { filepath: '/srv/ws/labs/thr_1/b.md' }));
    expect(t.replies).toEqual([{ id: 'per_4', reply: 'once' }]);
  });

  it('never approves requests from sessions no run is following', async () => {
    const t = setup();
    await t.send('permission.asked', { ...ask('per_5', 'bash', { command: 'ls' }), sessionID: 'ses_other' });
    expect(t.replies).toEqual([]);
    expect(await t.perms.pendingApprovals()).toEqual([]);
  });
});

describe('lab event mirror', () => {
  it('streams assistant text and tool steps, skips the prompt, and finishes on idle', async () => {
    const t = setup();
    await t.attach();
    t.mirror.markStarted('ses_1');
    const done = t.mirror.wait('ses_1');
    await t.send('message.updated', { sessionID: 'ses_1', info: { id: 'm_user', role: 'user' } });
    await t.send('message.part.updated', {
      part: { id: 'p0', messageID: 'm_user', sessionID: 'ses_1', type: 'text', text: 'fix the bug' },
    });
    await t.send('message.updated', {
      sessionID: 'ses_1',
      info: { id: 'm_ai', role: 'assistant', tokens: { input: 50, output: 20 }, cost: 0.01 },
    });
    await t.send('message.part.delta', {
      sessionID: 'ses_1',
      messageID: 'm_ai',
      partID: 'p1',
      field: 'text',
      delta: 'Looking ',
    });
    await t.send('message.part.delta', {
      sessionID: 'ses_1',
      messageID: 'm_ai',
      partID: 'p1',
      field: 'text',
      delta: 'now.',
    });
    await t.send('message.part.updated', {
      part: {
        id: 'p2',
        messageID: 'm_ai',
        sessionID: 'ses_1',
        type: 'tool',
        tool: 'read',
        callID: 'c1',
        state: { status: 'running', input: { filePath: 'a.ts' } },
      },
    });
    await t.send('message.part.updated', {
      part: {
        id: 'p2',
        messageID: 'm_ai',
        sessionID: 'ses_1',
        type: 'tool',
        tool: 'read',
        callID: 'c1',
        state: { status: 'completed', input: { filePath: 'a.ts' }, output: 'const a = 1' },
      },
    });
    await t.send('session.idle', { sessionID: 'ses_1' });
    const out = await done;
    expect(out.status).toBe('complete');
    expect(out.promptMessageId).toBe('m_user');
    expect(out.usage).toEqual({ input: 50, output: 20, costUsd: 0.01 });
    expect(out.parts).toEqual([
      { type: 'text', text: 'Looking now.' },
      { type: 'tool_call', call_id: 'c1', tool: 'read', args: { filePath: 'a.ts' } },
      { type: 'tool_result', call_id: 'c1', ok: true, result: 'const a = 1' },
    ]);
    const types = (await t.events.since('run_1', 0)).map((e) => e.type);
    expect(types).toEqual(['text.delta', 'text.delta', 'tool.call', 'tool.result']);
  });

  it('reports an engine error in plain words', async () => {
    const t = setup();
    await t.attach();
    t.mirror.markStarted('ses_1');
    const done = t.mirror.wait('ses_1');
    await t.send('session.error', {
      sessionID: 'ses_1',
      error: { name: 'ProviderAuthError', data: { message: '401' } },
    });
    await t.send('session.idle', { sessionID: 'ses_1' });
    expect((await done).error?.title).toBe('The lab could not reach a model');
  });
});

describe('lab runs that cannot hang', () => {
  it('ends the wait at once on Stop, even when the engine never answers', async () => {
    const t = setup();
    await t.attach();
    t.mirror.markStarted('ses_1');
    const stop = new AbortController();
    const done = t.mirror.wait('ses_1', { signal: stop.signal });
    stop.abort();
    expect((await done).status).toBe('stopped');
  });

  it('ends the wait with lab.timed_out at the deadline', async () => {
    const t = setup();
    await t.attach();
    t.mirror.markStarted('ses_1');
    await expect(t.mirror.wait('ses_1', { deadlineMs: 20 })).rejects.toMatchObject({ code: 'lab.timed_out' });
  });

  it('catches up on a session that finished while Core was not listening', async () => {
    const t = setup();
    await t.attach();
    t.mirror.markStarted('ses_1');
    const done = t.mirror.wait('ses_1');
    t.state.messages = [
      { info: { id: 'm_user', role: 'user' }, parts: [] },
      {
        info: {
          id: 'm_ai',
          role: 'assistant',
          time: { created: 1, completed: 2 },
          tokens: { input: 5, output: 3 },
        },
        parts: [{ id: 'p1', messageID: 'm_ai', type: 'text', text: 'Done while you were away.' }],
      },
    ];
    expect(await t.mirror.check('ses_1')).toBe(true);
    const out = await done;
    expect(out).toMatchObject({ status: 'complete', promptMessageId: 'm_user' });
    expect(out.parts).toEqual([{ type: 'text', text: 'Done while you were away.' }]);
  });

  it('does not mistake a busy or unfinished session for a finished one', async () => {
    const t = setup();
    await t.attach();
    t.mirror.markStarted('ses_1');
    t.state.statuses = { ses_1: { type: 'busy' } };
    expect(await t.mirror.check('ses_1')).toBe(false);
    t.state.statuses = {};
    t.state.messages = [
      { info: { id: 'm_user', role: 'user' }, parts: [] },
      { info: { id: 'm_ai', role: 'assistant', time: { created: 1 } }, parts: [] },
    ];
    expect(await t.mirror.check('ses_1')).toBe(false);
  });

  it('withdraws the questions of a run when it stops following its session', async () => {
    const t = setup();
    await t.attach();
    await t.send('permission.asked', ask('per_9', 'bash', { command: 'make' }, ['make']));
    expect(await t.perms.pendingApprovals()).toHaveLength(1);
    await t.mirror.detach('ses_1');
    expect(await t.perms.pendingApprovals()).toHaveLength(0);
  });
});
