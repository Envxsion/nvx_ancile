/**
 * Track G, Auto mode: the reviewer goes offline (every reviewer in the chain
 * unavailable), and a step outside an approved plan.
 *
 * - Offline: Auto falls back to the rules alone, says so once per outage
 *   with the reason (no key, key rejected, network, model not pulled), and
 *   says once when a reviewer answers again.
 * - Out of plan: with an approved plan in force, an ask that fits none of its
 *   steps is marked out of plan (approval.batched), and "Add to plan" adds
 *   the step so the next such call runs.
 */

import type { ReviewerStatus } from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { errorHandler } from '../../src/obs/errors';
import { type AutoCall, AutoReview, MemoryPlanStore, type Reviewer } from '../../src/permissions/auto';
import { autoRoutes } from '../../src/permissions/auto/routes';
import type { RunEventInput } from '../../src/runs/events';

const call = (over: Partial<AutoCall> = {}): AutoCall => ({
  principal: 'agent:default',
  action: 'shell.exec',
  resource: 'shell:pnpm test',
  outsideRoot: false,
  destructive: true,
  ...over,
});

const ctx = (c: AutoCall, over: Record<string, unknown> = {}) => ({
  call: c,
  scope: null,
  threadId: 'th1',
  notebookId: null,
  runId: 'run1',
  traceId: 't',
  root: '/workspace',
  ...over,
});

const reviewer = (
  id: Reviewer['id'],
  opts: { local?: boolean; available?: boolean; fail?: unknown; answer?: [number, number] } = {},
): Reviewer => ({
  id,
  local: opts.local ?? false,
  async available() {
    return opts.available ?? true;
  },
  async review() {
    if (opts.fail) throw opts.fail;
    const [f, i] = opts.answer ?? [0.95, 0.01];
    return { p_fits: f, p_injection: i, cost_usd: 0 };
  },
});

describe('reviewer offline', () => {
  it('falls back to the rules alone when every reviewer is unavailable, and says so once', async () => {
    const said: ReviewerStatus[] = [];
    const a = new AutoReview({
      reviewers: [
        reviewer('jev_openrouter', { available: false }),
        reviewer('jev_direct', { available: false }),
        reviewer('local_model', { local: true, available: false }),
      ],
      plans: new MemoryPlanStore(),
      onReviewerStatus: (s) => said.push(s),
    });
    expect(a.reviewerStatus().status).toBe('unknown');
    // Routine: the rules allow it. Not routine: the rules ask.
    const routine = await a.settle(ctx(call()), async () => null);
    expect(routine).toMatchObject({ verdict: 'allow', via: 'rules', reviewer: 'rules' });
    const odd = await a.settle(ctx(call({ resource: 'shell:./tool --go' })), async () => null);
    expect(odd).toMatchObject({ verdict: 'ask', via: 'rules' });
    await a.settle(ctx(call({ resource: 'shell:./other --go' })), async () => null);

    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ status: 'offline', reason: 'no_key', local_only: false });
    expect(said[0]?.outage_id).toMatch(/^rvo_/);
    expect(a.reviewerStatus().status).toBe('offline');
  });

  it('names the most useful reason: a failure beats a missing key', async () => {
    const reasons = async (reviewers: Reviewer[], scope: unknown = null) => {
      const said: ReviewerStatus[] = [];
      const a = new AutoReview({
        reviewers,
        plans: new MemoryPlanStore(),
        onReviewerStatus: (s) => said.push(s),
      });
      await a.settle(ctx(call({ resource: 'shell:./x' }), { scope }), async () => null);
      return said[0];
    };
    expect(
      (
        await reasons([
          reviewer('jev_openrouter', { fail: new ClassifiedError('transient', 'timed out') }),
          reviewer('jev_direct', { available: false }),
        ])
      )?.reason,
    ).toBe('network');
    expect(
      (
        await reasons([
          reviewer('jev_openrouter', { fail: new ClassifiedError('permanent', '401', { status: 401 }) }),
        ])
      )?.reason,
    ).toBe('key_rejected');
    expect(
      (
        await reasons([
          reviewer('jev_openrouter', { available: false }),
          reviewer('local_model', {
            local: true,
            fail: new Error('model "llama3" not found, try pulling it first'),
          }),
        ])
      )?.reason,
    ).toBe('model_not_pulled');
    // Nothing may leave the machine: only the local reviewer counts, and it is missing.
    const privateScope = { private: true, scope: { data_leaves_machine: false }, tool_presets: [] };
    expect(
      await reasons(
        [reviewer('jev_openrouter'), reviewer('local_model', { local: true, available: false })],
        privateScope,
      ),
    ).toMatchObject({ reason: 'model_not_pulled', local_only: true });
  });

  it('says once when a reviewer answers again, and a new outage gets a new id', async () => {
    const said: ReviewerStatus[] = [];
    let up = false;
    const jev: Reviewer = {
      id: 'jev_openrouter',
      local: false,
      available: async () => true,
      review: async () => {
        if (!up) throw new ClassifiedError('transient', 'fetch failed');
        return { p_fits: 0.95, p_injection: 0.01, cost_usd: 0 };
      },
    };
    const a = new AutoReview({
      reviewers: [jev],
      plans: new MemoryPlanStore(),
      onReviewerStatus: (s) => said.push(s),
    });
    await a.settle(ctx(call({ resource: 'shell:./a' })), async () => null);
    await a.settle(ctx(call({ resource: 'shell:./b' })), async () => null);
    up = true;
    const back = await a.settle(ctx(call({ resource: 'shell:./c' })), async () => null);
    expect(back).toMatchObject({ verdict: 'allow', reviewer: 'jev_openrouter' });
    await a.settle(ctx(call({ resource: 'shell:./d' })), async () => null);
    up = false;
    await a.settle(ctx(call({ resource: 'shell:./e' })), async () => null);
    expect(said.map((s) => s.status)).toEqual(['offline', 'online', 'offline']);
    expect(said[0]?.outage_id).not.toBe(said[2]?.outage_id);
  });

  it('GET /auto/reviewer answers with the status', async () => {
    const a = new AutoReview({ reviewers: [], plans: new MemoryPlanStore() });
    await a.settle(ctx(call({ resource: 'shell:./x' })), async () => null);
    const app = new Hono<AppEnv>();
    app.route('/', autoRoutes({ plans: new MemoryPlanStore(), reviewer: () => a.reviewerStatus() }));
    const r = await app.request('/auto/reviewer');
    expect(await r.json()).toMatchObject({ status: 'offline', reason: 'no_key' });
  });
});

describe('a step outside the approved plan', () => {
  it('asks once, grouped and marked out of plan; Add to plan lets the next one run', async () => {
    const plans = new MemoryPlanStore();
    const events: RunEventInput[] = [];
    const a = new AutoReview({
      reviewers: [reviewer('fake', { local: true, answer: [0.3, 0.01] })],
      plans,
      emit: async (_run, e) => {
        events.push(e);
      },
    });
    const plan = await plans.propose({
      threadId: 'th1',
      runId: null,
      summary: 'Fix the tests',
      steps: [{ action: 'shell.exec', resource: 'shell:pnpm test*', note: 'Run the tests' }],
    });
    await plans.decide(plan.id, 'approved');

    // In the plan: runs.
    expect((await a.settle(ctx(call()), async () => null)).verdict).toBe('allow');
    // Outside it: one grouped ask, with the reason and the action.
    const out = await a.settle(ctx(call({ resource: 'shell:git push origin fix' })), async () => null);
    expect(out).toMatchObject({ verdict: 'ask', out_of_plan: true, plan_id: plan.id });
    const batched = events.filter((e) => e.type === 'approval.batched');
    expect(batched).toHaveLength(1);
    expect(batched[0]).toMatchObject({
      action: 'shell.exec',
      out_of_plan: true,
      plan_id: plan.id,
      reason: expect.any(String),
    });

    // Add to plan, over HTTP.
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', autoRoutes({ plans }));
    const r = await app.request(`/auto/plans/${plan.id}/steps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'shell.exec',
        resource: 'shell:git push origin fix',
        note: 'Push the fix',
      }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { steps: unknown[] }).steps).toHaveLength(2);
    expect(
      (await a.settle(ctx(call({ resource: 'shell:git push origin fix' })), async () => null)).verdict,
    ).toBe('allow');

    // A step that says "anything" is refused, as when proposing.
    const bad = await app.request(`/auto/plans/${plan.id}/steps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'shell.exec', resource: 'shell:*' }),
    });
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('auto.plan_too_broad');
  });

  it('is not marked out of plan without an approved plan, or when a floor asks', async () => {
    const plans = new MemoryPlanStore();
    const a = new AutoReview({ reviewers: [reviewer('fake', { local: true, answer: [0.3, 0.01] })], plans });
    expect(
      (await a.settle(ctx(call({ resource: 'shell:./x' })), async () => null)).out_of_plan,
    ).toBeUndefined();
    const p = await plans.propose({
      threadId: 'th1',
      runId: null,
      summary: 's',
      steps: [{ action: 'shell.exec', resource: 'shell:pnpm test*', note: '' }],
    });
    await plans.decide(p.id, 'approved');
    const floored = await a.settle(ctx(call({ resource: 'shell:sudo ls' })), async () => null);
    expect(floored.verdict).toBe('ask');
    expect(floored.out_of_plan).toBeUndefined();
  });

  it('refuses Add to plan on a plan that is no longer in force', async () => {
    const plans = new MemoryPlanStore();
    const p = await plans.propose({
      threadId: 'th1',
      runId: null,
      summary: 's',
      steps: [{ action: 'shell.exec', resource: 'shell:pnpm test*', note: '' }],
    });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', autoRoutes({ plans }));
    const r = await app.request(`/auto/plans/${p.id}/steps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'shell.exec', resource: 'shell:git status' }),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('auto.plan_not_active');
  });
});
