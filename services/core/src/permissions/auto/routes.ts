/**
 * ------------------------------------------------------------------
 *  Title    |  /auto/plans: approve the plan once
 *  Ref      |  docs/auto-mode.md (The plan) · docs/api.md (Auto mode)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Propose a plan for a thread or run, read the current
 *           |  one, and approve or reject it. Once approved, calls
 *           |  that fit a step run without asking (floors and scopes
 *           |  still apply). "Add to plan" adds a step to the approved
 *           |  plan; GET /auto/reviewer says whether a reviewer is
 *           |  answering or Auto mode is on its rules alone.
 *           |  /auto/reviewer-check estimates, then (on confirm) runs
 *           |  the built-in eval cases through your reviewers.
 *  How      |  Thin over PlanStore. Each change is also a `plan.changed`
 *           |  run event when the plan belongs to a run, so an open
 *           |  thread sees it at once.
 * ------------------------------------------------------------------
 */

import {
  AddPlanStepRequest,
  AncileError,
  PlanDecisionRequest,
  ProposePlanRequest,
  ReviewerCheckRequest,
  type ReviewerStatus,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../app';
import { body } from '../../http/body';
import { notFound } from '../../obs/errors';
import type { RunEventLog } from '../../runs/events';
import type { ReviewerCheck } from './check';
import { type PlanStore, sessionKey } from './plans';

export interface AutoRouteDeps {
  plans: PlanStore;
  events?: Pick<RunEventLog, 'append'>;
  /** Is a reviewer answering? (AutoReview.reviewerStatus) */
  reviewer?: () => ReviewerStatus;
  /** Check my reviewers (R2). */
  check?: ReviewerCheck;
}

export function autoRoutes(deps: AutoRouteDeps) {
  const r = new Hono<AppEnv>();
  const { plans } = deps;

  const announce = async (
    runId: string | null,
    planId: string,
    status: 'proposed' | 'approved' | 'rejected',
  ) => {
    if (runId)
      await deps.events
        ?.append(runId, { type: 'plan.changed', plan_id: planId, status })
        .catch(() => undefined);
  };

  r.get('/auto/plans/current', async (c) => {
    const key = sessionKey({
      threadId: c.req.query('thread_id') ?? null,
      runId: c.req.query('run_id') ?? null,
    });
    if (!key)
      throw new AncileError({
        code: 'request.invalid',
        title: 'Say which thread or run',
        hint: 'Add ?thread_id= or ?run_id= to the request.',
        status: 400,
        errorClass: 'permanent',
      });
    return c.json({ plan: (await plans.current(key)) ?? null });
  });

  r.post('/auto/plans', async (c) => {
    const req = await body(c, ProposePlanRequest);
    const plan = await plans.propose({
      threadId: req.thread_id ?? null,
      runId: req.run_id ?? null,
      summary: req.summary,
      steps: req.steps,
    });
    await announce(plan.run_id, plan.id, 'proposed');
    return c.json(plan, 201);
  });

  r.get('/auto/reviewer', (c) =>
    c.json(
      deps.reviewer?.() ??
        ({
          status: 'unknown',
          outage_id: null,
          reason: null,
          local_only: false,
          since: null,
        } satisfies ReviewerStatus),
    ),
  );

  // What the check would do and cost. Free: it asks no reviewer a question.
  r.get('/auto/reviewer-check', async (c) => {
    if (!deps.check) throw notFound('The reviewer check');
    return c.json(await deps.check.estimate());
  });

  // Runs the fixed cases through the reviewers. Only with { confirm: true }: it may cost money.
  r.post('/auto/reviewer-check', async (c) => {
    if (!deps.check) throw notFound('The reviewer check');
    const req = await body(c, ReviewerCheckRequest);
    return c.json(await deps.check.run(req));
  });

  r.post('/auto/plans/:id/steps', async (c) => {
    const id = c.req.param('id');
    const step = await body(c, AddPlanStepRequest);
    const plan = await plans.get(id);
    if (!plan) throw notFound('That plan');
    const key = sessionKey({ threadId: plan.thread_id, runId: plan.run_id }) ?? 'none';
    const current = await plans.current(key);
    const next = current?.id === id ? await plans.addStep(id, step) : undefined;
    if (!next)
      throw new AncileError({
        code: 'auto.plan_not_active',
        title: 'This plan is no longer the approved one',
        hint: 'A newer plan may have replaced it, or it was declined. Allow the step once instead.',
        status: 409,
        errorClass: 'permanent',
      });
    await announce(next.run_id, id, 'approved');
    return c.json(next);
  });

  r.get('/auto/plans/:id', async (c) => {
    const plan = await plans.get(c.req.param('id'));
    if (!plan) throw notFound('That plan');
    return c.json(plan);
  });

  r.post('/auto/plans/:id/decision', async (c) => {
    const id = c.req.param('id');
    const { decision } = await body(c, PlanDecisionRequest);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    if (!(await plans.get(id))) throw notFound('That plan');
    if (!(await plans.decide(id, status)))
      throw new AncileError({
        code: 'auto.plan_not_pending',
        title: 'This plan was already answered',
        hint: 'A newer plan may have replaced it. Refresh to see the current one.',
        status: 409,
        errorClass: 'permanent',
      });
    const plan = await plans.get(id);
    await announce(plan?.run_id ?? null, id, status);
    return c.json(plan);
  });

  return r;
}
