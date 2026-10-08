/**
 * Phase 2 acceptance, Core side: a chat turn streams, falls back, runs
 * tools behind the three tiers, pauses for approval and resumes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, RunEvent, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const of = <T extends RunEvent['type']>(evs: RunEvent[], type: T) =>
  evs.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

async function lastAssistant(threadId: string): Promise<Message> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  return path.messages.at(-1) as Message;
}

describe('a chat turn', () => {
  it('streams the answer, persists it and closes the stream', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/say Hello from the offline model.');
    const run = await h.settle(sent.run_id);
    expect(run.status).toBe('succeeded');

    const evs = await h.eventsOf(sent.run_id);
    expect(h.text(evs)).toBe('Hello from the offline model.');
    expect(of(evs, 'model')[0]?.model_id).toBe('offline/test');
    expect(evs.at(-1)?.type).toBe('done');
    // seq is gapless and starts at 1, so a reconnect can resume exactly
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));

    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect(m.model_id).toBe('offline/test');
    expect(m.parts).toEqual([{ type: 'text', text: 'Hello from the offline model.' }]);
    expect(m.usage?.output_tokens).toBeGreaterThan(0);
  });

  it('titles a new thread from the first message', async () => {
    h = await harness();
    const t = await h.newThread();
    await h.settle((await h.send(t, 'What is the boiling point of water at altitude?')).run_id);
    const thread = (await h.call<{ title: string }>('GET', `/threads/${t}`)).body;
    expect(thread.title).toBe('What is the boiling point of water at altitude?');
  });

  it('falls back to the next model when the first fails, and says so', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/fail 500');
    await h.settle(sent.run_id);
    const evs = await h.eventsOf(sent.run_id);
    const fb = of(evs, 'fallback')[0];
    expect(fb).toMatchObject({ from_model: 'offline/test', to_model: 'offline/echo' });
    const m = await lastAssistant(t);
    expect(m.model_id).toBe('offline/echo');
    // The backup says it could not follow the directive instead of parroting it.
    expect(JSON.stringify(m.parts)).toContain("I'm Offline echo, the backup model");
    expect(m.status).toBe('complete');
    expect((m.provenance as { attempts: { model: string }[] }).attempts[0]?.model).toBe('offline/test');
  });

  it('treats a refusal as a reason to fall back', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/fail refusal');
    await h.settle(sent.run_id);
    expect(of(await h.eventsOf(sent.run_id), 'fallback')[0]?.reason).toBe('refusal');
    expect((await lastAssistant(t)).model_id).toBe('offline/echo');
  });

  it('reports a clear error when every model fails', async () => {
    h = await harness({
      offline: false,
      models: [fakeModel('a', 'fail:auth')],
      taskClasses: { 'chat.default': ['fake/a'] },
    });
    const t = await h.newThread();
    const sent = await h.send(t, 'hi');
    const run = await h.settle(sent.run_id);
    expect(run.status).toBe('failed');
    const err = of(await h.eventsOf(sent.run_id), 'error')[0];
    expect(err?.code).toBe('model.chain_exhausted');
    expect(err?.hint).toMatch(/key/i);
    expect((await lastAssistant(t)).status).toBe('error');
  });

  it('uses an explicit model first, and the next message keeps the earlier context', async () => {
    h = await harness({
      models: [fakeModel('echo2', 'echo')],
      taskClasses: { 'chat.default': ['offline/test'] },
    });
    const t = await h.newThread();
    const first = await h.send(t, '/say first answer');
    await h.settle(first.run_id);
    const second = await h.send(t, 'second question', {
      parent_id: first.assistant_message_id,
      model: 'fake/echo2',
    });
    await h.settle(second.run_id);
    expect((await lastAssistant(t)).model_id).toBe('fake/echo2');
    const req = h.provider.calls.at(-1)?.req;
    expect(req?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req?.messages[1]?.content).toBe('first answer');
  });

  it('refuses an embedding model chosen for a chat turn, for a send and as a thread model', async () => {
    h = await harness({
      models: [{ ...fakeModel('embed', 'say:vectors'), capabilities: ['embeddings'] }],
      taskClasses: { 'chat.default': ['offline/test'] },
    });
    const t = await h.newThread();
    const sent = await h.call<{ error: { code: string } }>('POST', `/threads/${t}/messages`, {
      parent_id: null,
      parts: [{ type: 'text', text: 'hi' }],
      model: 'fake/embed',
    });
    expect(sent.status).toBe(422);
    expect(sent.body.error.code).toBe('model.not_chat');
    const created = await h.call<{ error: { code: string } }>('POST', '/threads', { model: 'fake/embed' });
    expect(created.body.error.code).toBe('model.not_chat');
    const patched = await h.call<{ error: { code: string } }>('PATCH', `/threads/${t}`, {
      model: 'fake/embed',
    });
    expect(patched.body.error.code).toBe('model.not_chat');
    expect(h.provider.calls.map((c) => c.model)).not.toContain('fake/embed');
    // Nothing was written for the refused send.
    expect((await h.repo.messages(t)).length).toBe(0);
  });

  it('regenerates with the thread or default model when the one asked for is switched off', async () => {
    h = await harness({
      models: [fakeModel('echo2', 'echo')],
      taskClasses: { 'chat.default': ['offline/test'] },
    });
    const t = await h.newThread();
    const first = await h.send(t, '/say first', { model: 'fake/echo2' });
    await h.settle(first.run_id);
    await h.registry.setEnabled({ 'fake/echo2': false });
    const regen = await h.call<{ run_id: string }>(
      'POST',
      `/messages/${first.assistant_message_id}/regenerate`,
      {},
    );
    expect(regen.status).toBe(202);
    await h.settle(regen.body.run_id);
    expect((await lastAssistant(t)).model_id).toBe('offline/test');
  });

  it('refuses a model that has no key, naming what to do', async () => {
    h = await harness({
      models: [{ ...fakeModel('x', 'echo'), id: 'anthropic/claude-x', provider: 'anthropic' }],
    });
    const t = await h.newThread();
    const r = await h.call<{ error: { code: string; hint: string } }>('POST', `/threads/${t}/messages`, {
      parent_id: null,
      parts: [{ type: 'text', text: 'hi' }],
      model: 'anthropic/claude-x',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('model.not_configured');
    expect(r.body.error.hint).toMatch(/Settings/);
  });

  it('refuses a second turn while the thread is answering', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await h.send(t, '/slow one two three four five six');
    const b = await h.call<{ error: { code: string } }>('POST', `/threads/${t}/messages`, {
      parent_id: a.assistant_message_id,
      parts: [{ type: 'text', text: 'again' }],
    });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('run.already_running');
    await h.call('POST', `/messages/${a.assistant_message_id}/stop`);
    await h.settle(a.run_id);
  });

  it('stops mid-answer and keeps what was said', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/slow alpha beta gamma delta epsilon zeta eta theta');
    // Wait for some text to arrive, then stop.
    for (let i = 0; i < 100 && h.text(await h.eventsOf(sent.run_id)).length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    const stop = await h.call<{ status: string }>('POST', `/messages/${sent.assistant_message_id}/stop`);
    expect(stop.body.status).toBe('cancelled');
    const run = await h.settle(sent.run_id);
    expect(run.status).toBe('cancelled');
    const m = await lastAssistant(t);
    expect(m.status).toBe('stopped');
    expect(m.parts.length).toBeGreaterThan(0);
  });

  it('regenerates as a sibling and edits as a new branch', async () => {
    h = await harness();
    const t = await h.newThread();
    const first = await h.send(t, '/say one');
    await h.settle(first.run_id);
    const regen = (
      await h.call<{ run_id: string; assistant_message_id: string }>(
        'POST',
        `/messages/${first.assistant_message_id}/regenerate`,
        {},
      )
    ).body;
    await h.settle(regen.run_id);
    let path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    expect(path.messages.at(-1)?.id).toBe(regen.assistant_message_id);
    expect(path.messages.at(-1)?.siblings).toMatchObject({ index: 1, count: 2 });

    const edit = (
      await h.call<{ run_id: string; user_message_id: string }>(
        'POST',
        `/messages/${first.user_message_id}/edit`,
        { parts: [{ type: 'text', text: '/say two' }] },
      )
    ).body;
    await h.settle(edit.run_id);
    path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    expect(path.messages[0]?.id).toBe(edit.user_message_id);
    expect(path.messages[0]?.siblings).toMatchObject({
      index: 1,
      count: 2,
      ids: [first.user_message_id, edit.user_message_id],
    });
    expect(path.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'two' }]);
    // The old branch is still reachable by its head.
    const old = (await h.call<ThreadPath>('GET', `/threads/${t}/path?head=${first.assistant_message_id}`))
      .body;
    expect(old.messages.map((m) => m.id)).toEqual([first.user_message_id, first.assistant_message_id]);
  });
});

describe('tools behind permissions', () => {
  it('runs an AUTO tool without asking and gives the model its result', async () => {
    h = await harness();
    await writeFile(join(h.dir, 'notes.md'), 'hello file');
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_read {"path":"notes.md"}');
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const evs = await h.eventsOf(sent.run_id);
    expect(of(evs, 'approval.required')).toHaveLength(0);
    expect(of(evs, 'tool.result')[0]?.ok).toBe(true);
    expect(h.text(evs)).toContain('hello file');
    const decisions = await h.perms.listDecisions();
    expect(decisions[0]).toMatchObject({
      action: 'fs.read',
      outcome: 'auto',
      resource: 'fs:/workspace/notes.md',
    });
  });

  it('asks once for a GATED tool, remembers the pattern, and does not ask again', async () => {
    h = await harness();
    const t = await h.newThread();
    const first = await h.send(t, '/tool fs_write {"path":"docs/a.md","content":"A"}');
    expect((await h.settle(first.run_id)).status).toBe('waiting_approval');
    const ask = of(await h.eventsOf(first.run_id), 'approval.required')[0];
    expect(ask).toMatchObject({ tool: 'fs_write', tier: 'gated', resource: 'fs:/workspace/docs/a.md' });
    expect(ask?.suggestions).toContain('fs:/workspace/docs/**');

    const ok = await h.call('POST', `/approvals/${ask?.approval_id}`, {
      decision: 'approve',
      scope: 'always',
      pattern: 'fs:/workspace/**',
    });
    expect(ok.status).toBe(200);
    expect((await h.settle(first.run_id)).status).toBe('succeeded');
    expect(await readFile(join(h.dir, 'docs', 'a.md'), 'utf8')).toBe('A');

    const second = await h.send(t, '/tool fs_write {"path":"docs/b.md","content":"B"}', {
      parent_id: first.assistant_message_id,
    });
    expect((await h.settle(second.run_id)).status).toBe('succeeded');
    expect(of(await h.eventsOf(second.run_id), 'approval.required')).toHaveLength(0);
    const grants = (await h.call<{ items: { uses: number }[] }>('GET', '/grants')).body.items;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.uses).toBe(1);
  });

  it('tells the model when a person declines, and the turn still completes', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"x.md","content":"x"}');
    await h.settle(sent.run_id);
    const ask = of(await h.eventsOf(sent.run_id), 'approval.required')[0];
    await h.call('POST', `/approvals/${ask?.approval_id}`, {
      decision: 'deny',
      scope: 'once',
      reason: 'not now',
    });
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const m = await lastAssistant(t);
    const result = m.parts.find((p) => p.type === 'tool_result');
    expect(result).toMatchObject({ ok: false, declined_reason: 'not now' });
    expect(h.text(await h.eventsOf(sent.run_id))).toContain('declined');
  });

  it('asks every time for CRITICAL and refuses to remember it', async () => {
    h = await harness();
    await writeFile(join(h.dir, 'gone.md'), 'bye');
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_delete {"path":"gone.md"}');
    await h.settle(sent.run_id);
    const ask = of(await h.eventsOf(sent.run_id), 'approval.required')[0];
    expect(ask).toMatchObject({ tier: 'critical', suggestions: [] });

    const remembered = await h.call<{ error: { code: string } }>('POST', `/approvals/${ask?.approval_id}`, {
      decision: 'approve',
      scope: 'always',
    });
    expect(remembered.status).toBe(422);
    expect(remembered.body.error.code).toBe('permission.critical_not_rememberable');

    await h.call('POST', `/approvals/${ask?.approval_id}`, { decision: 'approve', scope: 'once' });
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    await expect(readFile(join(h.dir, 'gone.md'))).rejects.toThrow();
    expect((await h.call<{ items: unknown[] }>('GET', '/grants')).body.items).toHaveLength(0);
  });

  it('denies a path that climbs out of the workspace without asking', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_read {"path":"/workspace/../etc/passwd"}');
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const evs = await h.eventsOf(sent.run_id);
    expect(of(evs, 'approval.required')).toHaveLength(0);
    expect(of(evs, 'tool.result')[0]?.ok).toBe(false);
  });

  it('applies the Cedar forbid policies from config', async () => {
    const base = await readFile(join(__dirname, '../../../../config/policies/base.cedar'), 'utf8');
    h = await harness({ cedar: { 'base.cedar': base } });
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":".env.local","content":"KEY=1"}');
    await h.settle(sent.run_id);
    const evs = await h.eventsOf(sent.run_id);
    expect(of(evs, 'approval.required')).toHaveLength(0);
    const decision = (await h.perms.listDecisions())[0];
    expect(decision).toMatchObject({ outcome: 'policy_deny', policy_id: 'base.protect-internals' });
  });

  it('survives a restart while waiting for approval, then finishes after the decision', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"r.md","content":"after restart"}');
    expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
    await h.restart();
    const pending = (await h.call<{ items: { id: string }[] }>('GET', '/approvals')).body.items;
    expect(pending).toHaveLength(1);
    await h.call('POST', `/approvals/${pending[0]?.id}`, { decision: 'approve', scope: 'once' });
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    expect(await readFile(join(h.dir, 'r.md'), 'utf8')).toBe('after restart');
    // The resumed stream redraws from committed parts before continuing.
    expect(of(await h.eventsOf(sent.run_id), 'message.snapshot').length).toBeGreaterThan(0);
  });

  it('answers a second click on the same approval as a no-op', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"once.md","content":"1"}');
    await h.settle(sent.run_id);
    const ask = of(await h.eventsOf(sent.run_id), 'approval.required')[0];
    const a = await h.call<{ status: string }>('POST', `/approvals/${ask?.approval_id}`, {
      decision: 'approve',
      scope: 'once',
    });
    const b = await h.call<{ status: string }>('POST', `/approvals/${ask?.approval_id}`, {
      decision: 'deny',
      scope: 'once',
    });
    expect(a.body.status).toBe('approved');
    expect(b.body.status).toBe('approved');
  });
});
