/**
 * The Phase 3 A routes over their stores: Auto mode's plan (propose, read,
 * approve once, and a plan.changed event for a run's plan) and the engine
 * routes (the engines, a turn sent to Engines.send, and instructions and
 * persona for a thread or notebook). Engines themselves are tested in
 * test/engines; here only the HTTP edge.
 */
import type { AutoPlan, InstructionsView } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Engines } from '../../src/engines';
import { engineRoutes } from '../../src/engines/routes';
import { MemoryEngineStore } from '../../src/engines/store';
import { errorHandler } from '../../src/obs/errors';
import { MemoryPlanStore } from '../../src/permissions/auto/plans';
import { autoRoutes } from '../../src/permissions/auto/routes';
import { MemoryThreadRepo } from '../../src/threads/repo';

type Err = { error: { code: string } };

function client(app: Hono) {
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
}

describe('Auto mode plan routes', () => {
  let call: ReturnType<typeof client>;
  let events: { runId: string; e: unknown }[];

  beforeEach(() => {
    events = [];
    const app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/',
      autoRoutes({
        plans: new MemoryPlanStore(),
        events: { append: async (runId: string, e: unknown) => void events.push({ runId, e }) } as never,
      }) as unknown as Hono,
    );
    call = client(app);
  });

  const STEPS = [{ action: 'fs.write', resource: 'fs:/workspace/src/**', note: 'Edit the source' }];

  it('proposes a plan for a run, answers it once, and says so on the run', async () => {
    const made = await call<AutoPlan>('POST', '/auto/plans', {
      run_id: 'run_1',
      summary: 'Fix the parser',
      steps: STEPS,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ status: 'proposed', run_id: 'run_1' });
    const current = await call<{ plan: AutoPlan | null }>('GET', '/auto/plans/current?run_id=run_1');
    expect(current.body.plan?.id).toBe(made.body.id);
    expect((await call<AutoPlan>('GET', `/auto/plans/${made.body.id}`)).body.summary).toBe('Fix the parser');

    const ok = await call<AutoPlan>('POST', `/auto/plans/${made.body.id}/decision`, { decision: 'approve' });
    expect(ok.body.status).toBe('approved');
    const again = await call<Err>('POST', `/auto/plans/${made.body.id}/decision`, { decision: 'reject' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('auto.plan_not_pending');
    expect(events.map((x) => (x.e as { status: string }).status)).toEqual(['proposed', 'approved']);
  });

  it('a thread plan needs no run; a plan without a step that says what it touches is refused', async () => {
    const made = await call<AutoPlan>('POST', '/auto/plans', {
      thread_id: 'thr_1',
      summary: 'Tidy',
      steps: STEPS,
    });
    expect(made.status).toBe(201);
    expect(events).toEqual([]);
    const rejected = await call<AutoPlan>('POST', `/auto/plans/${made.body.id}/decision`, {
      decision: 'reject',
    });
    expect(rejected.body.status).toBe('rejected');
    const broad = await call<Err>('POST', '/auto/plans', {
      thread_id: 'thr_1',
      summary: 'Anything',
      steps: [{ action: '*', resource: 'fs:/**' }],
    });
    expect(broad.status).toBe(422);
    expect(broad.body.error.code).toBe('auto.plan_too_broad');
  });

  it('asks which thread or run, and a missing plan is 404', async () => {
    expect((await call<Err>('GET', '/auto/plans/current')).status).toBe(400);
    expect(
      (await call<{ plan: null }>('GET', '/auto/plans/current?thread_id=thr_none')).body.plan,
    ).toBeNull();
    expect((await call('GET', '/auto/plans/apl_missing')).status).toBe(404);
    expect((await call('POST', '/auto/plans/apl_missing/decision', { decision: 'approve' })).status).toBe(
      404,
    );
  });
});

describe('engine routes', () => {
  let call: ReturnType<typeof client>;
  let threads: MemoryThreadRepo;
  let store: MemoryEngineStore;
  let sent: { threadId: string; opts: Record<string, unknown> }[];

  beforeEach(async () => {
    threads = new MemoryThreadRepo();
    store = new MemoryEngineStore();
    store.known.add('nbk_1');
    sent = [];
    const engines = {
      info: async () => [{ kind: 'gateway', available: true }],
      send: async (t: { id: string }, opts: Record<string, unknown>) => {
        sent.push({ threadId: t.id, opts });
        return {
          run_id: 'run_1',
          user_message_id: 'msg_u',
          assistant_message_id: 'msg_a',
          engine: 'gateway',
        };
      },
    } as unknown as Engines;
    const app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/',
      engineRoutes({ engines: () => engines, threads, store, workspaceId: 'wsp_1' }) as unknown as Hono,
    );
    call = client(app);
    await threads.createThread({ id: 'thr_1', workspace_id: 'wsp_1', notebook_id: 'nbk_1' });
    await threads.createThread({ id: 'thr_other', workspace_id: 'wsp_2' });
  });

  it('lists the engines and sends a turn with only what was asked for', async () => {
    expect((await call<{ items: unknown[] }>('GET', '/engines')).body.items).toHaveLength(1);
    const r = await call('POST', '/threads/thr_1/turns', {
      text: 'Hello',
      model: 'claude-code/sonnet',
      effort: 'high',
      source_ids: ['src_1'],
      as_branch: true,
      idempotency_key: 'turn-0001',
    });
    expect(r.status).toBe(202);
    expect(sent[0]).toEqual({
      threadId: 'thr_1',
      opts: {
        text: 'Hello',
        parentId: undefined,
        model: 'claude-code/sonnet',
        effort: 'high',
        sourceIds: ['src_1'],
        asBranch: true,
        idempotencyKey: 'turn-0001',
      },
    });
    expect(
      (await call('POST', '/threads/thr_other/turns', { text: 'x', idempotency_key: 'turn-0002' })).status,
    ).toBe(404);
    expect(
      (await call('POST', '/threads/thr_1/turns', { text: '', idempotency_key: 'turn-0003' })).status,
    ).toBe(400);
  });

  it('a thread’s instructions win over its notebook’s, field by field', async () => {
    await call('PUT', '/notebooks/nbk_1/instructions', {
      instructions: 'Use British spelling.',
      persona: 'Calm',
    });
    let v = await call<InstructionsView>('GET', '/threads/thr_1/instructions');
    expect(v.body.notebook).toEqual({ instructions: 'Use British spelling.', persona: 'Calm' });
    expect(v.body.effective).toContain('Use British spelling.');
    v = await call<InstructionsView>('PUT', '/threads/thr_1/instructions', { persona: 'Brief' });
    expect(v.body.thread).toEqual({ instructions: '', persona: 'Brief' });
    expect(v.body.effective).toContain('Brief');
    expect(v.body.effective).not.toContain('Calm');
    expect(v.body.effective).toContain('Use British spelling.');
    expect((await call('GET', '/notebooks/nbk_1/instructions')).status).toBe(200);
    expect((await call('GET', '/notebooks/nbk_none/instructions')).status).toBe(404);
    expect((await call('PUT', '/notebooks/nbk_none/instructions', { persona: 'x' })).status).toBe(404);
    expect((await call('GET', '/threads/thr_other/instructions')).status).toBe(404);
  });
});
