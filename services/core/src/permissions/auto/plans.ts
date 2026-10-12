/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode: the plan you approve once
 *  Ref      |  docs/auto-mode.md (The plan)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep one plan per session (a thread, or a run with no
 *           |  thread): proposed, then approved or rejected by you.
 *           |  Once approved, a call that fits one of its steps runs
 *           |  without asking.
 *  How      |  core.auto_plans; MemoryPlanStore for tests. A new plan
 *           |  supersedes the session's earlier ones. A step is an
 *           |  action glob and a resource glob with a real literal
 *           |  start, so "anything" can never be a step. A step can be
 *           |  added to the approved plan in force ("Add to plan" on a
 *           |  step outside it); it is checked like any other.
 *  Note     |  A plan never lifts a floor or a scope: those are checked
 *           |  before a plan is consulted.
 * ------------------------------------------------------------------
 */

import { AncileError, type AutoPlan, type AutoPlanStep } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import { pgSafe } from '../../db/json';
import { matchAction, matchResource } from '../glob';

export const sessionKey = (ref: { threadId?: string | null; runId?: string | null }) =>
  ref.threadId ? `thread:${ref.threadId}` : ref.runId ? `run:${ref.runId}` : null;

export interface NewPlan {
  threadId: string | null;
  runId: string | null;
  summary: string;
  steps: AutoPlanStep[];
}

export interface PlanStore {
  propose(p: NewPlan): Promise<AutoPlan>;
  get(id: string): Promise<AutoPlan | undefined>;
  /** proposed → approved | rejected. False when it was no longer proposed. */
  decide(id: string, status: 'approved' | 'rejected'): Promise<boolean>;
  /** The session's latest plan that is not superseded. */
  current(key: string): Promise<AutoPlan | undefined>;
  /** Add a step to an approved plan. Undefined when it is not approved (or superseded). */
  addStep(id: string, step: AutoPlanStep): Promise<AutoPlan | undefined>;
}

/** The literal start of a glob, up to its first wildcard. */
const literal = (p: string) => p.split('*')[0] ?? '';

/** A step must name something: a scheme plus at least a little real path or command. */
export function validateSteps(steps: AutoPlanStep[]): void {
  for (const s of steps) {
    const lit = literal(s.resource);
    const i = lit.indexOf(':');
    const bad = i <= 0 || lit.length - i - 1 < 2 || s.resource.startsWith('*') || /^\*+$/.test(s.action);
    if (bad)
      throw new AncileError({
        code: 'auto.plan_too_broad',
        title: 'A plan step must say what it touches',
        hint: `"${s.action} on ${s.resource}" covers too much. Name a folder or command, such as fs:/workspace/src/** or shell:pnpm test*.`,
        status: 422,
        errorClass: 'permanent',
      });
  }
}

/** The step a call fits, if any. */
export function planStepFor(plan: AutoPlan | undefined | null, call: { action: string; resource: string }) {
  if (!plan || plan.status !== 'approved') return undefined;
  return plan.steps.find(
    (s) => matchAction(s.action, call.action) && matchResource(s.resource, call.resource),
  );
}

const keyOf = (p: NewPlan) => sessionKey(p) ?? 'none';

export class MemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, AutoPlan & { key: string }>();

  async propose(p: NewPlan) {
    validateSteps(p.steps);
    const key = keyOf(p);
    for (const old of this.plans.values())
      if (old.key === key && old.status !== 'superseded' && old.status !== 'rejected')
        old.status = 'superseded';
    const plan: AutoPlan & { key: string } = {
      id: `apl_${ulid()}`,
      key,
      thread_id: p.threadId,
      run_id: p.runId,
      summary: p.summary,
      steps: p.steps,
      status: 'proposed',
      created_at: new Date().toISOString(),
      decided_at: null,
    };
    this.plans.set(plan.id, plan);
    const { key: _k, ...out } = plan;
    return out;
  }

  async get(id: string) {
    const p = this.plans.get(id);
    if (!p) return undefined;
    const { key: _k, ...out } = p;
    return out;
  }

  async decide(id: string, status: 'approved' | 'rejected') {
    const p = this.plans.get(id);
    if (!p || p.status !== 'proposed') return false;
    p.status = status;
    p.decided_at = new Date().toISOString();
    return true;
  }

  async current(key: string) {
    const all = [...this.plans.values()].filter((p) => p.key === key && p.status !== 'superseded');
    const p = all.sort((a, b) => b.id.localeCompare(a.id))[0];
    if (!p) return undefined;
    const { key: _k, ...out } = p;
    return out;
  }

  async addStep(id: string, step: AutoPlanStep) {
    validateSteps([step]);
    const p = this.plans.get(id);
    if (p?.status !== 'approved') return undefined;
    p.steps = [...p.steps, step];
    const { key: _k, ...out } = p;
    return out;
  }
}

interface Row {
  id: string;
  thread_id: string | null;
  run_id: string | null;
  summary: string;
  steps: AutoPlanStep[];
  status: AutoPlan['status'];
  created_at: Date;
  decided_at: Date | null;
}

const fromRow = (r: Row): AutoPlan => ({
  id: r.id,
  thread_id: r.thread_id,
  run_id: r.run_id,
  summary: r.summary,
  steps: r.steps,
  status: r.status,
  created_at: r.created_at.toISOString(),
  decided_at: r.decided_at ? r.decided_at.toISOString() : null,
});

export class PgPlanStore implements PlanStore {
  constructor(private readonly sql: Sql) {}

  async propose(p: NewPlan) {
    validateSteps(p.steps);
    const key = keyOf(p);
    const id = `apl_${ulid()}`;
    const rows = (await this.sql.begin(async (tx) => {
      await tx`update core.auto_plans set status = 'superseded'
               where session_key = ${key} and status in ('proposed','approved')`;
      return tx<Row[]>`
        insert into core.auto_plans (id, session_key, run_id, thread_id, summary, steps, status)
        values (${id}, ${key}, ${p.runId}, ${p.threadId}, ${p.summary}, ${tx.json(pgSafe(p.steps) as never)}, 'proposed')
        returning *`;
    })) as Row[];
    return fromRow(rows[0] as Row);
  }

  async get(id: string) {
    const [r] = await this.sql<Row[]>`select * from core.auto_plans where id = ${id}`;
    return r && fromRow(r);
  }

  async decide(id: string, status: 'approved' | 'rejected') {
    const r = await this.sql`update core.auto_plans set status = ${status}, decided_at = now()
                             where id = ${id} and status = 'proposed'`;
    return r.count > 0;
  }

  async current(key: string) {
    const [r] = await this.sql<Row[]>`
      select * from core.auto_plans where session_key = ${key} and status <> 'superseded'
      order by created_at desc, id desc limit 1`;
    return r && fromRow(r);
  }

  async addStep(id: string, step: AutoPlanStep) {
    validateSteps([step]);
    const [r] = await this.sql<Row[]>`
      update core.auto_plans set steps = steps || ${this.sql.json(pgSafe([step]) as never)}::jsonb
      where id = ${id} and status = 'approved'
      returning *`;
    return r && fromRow(r);
  }
}
