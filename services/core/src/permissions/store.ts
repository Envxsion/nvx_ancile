/**
 * ------------------------------------------------------------------
 *  Title    |  Grants, approvals and decisions at rest
 *  Ref      |  DESIGN.md §5.3–§5.6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Grants are what "remember this" leaves behind; approvals
 *           |  are the questions a run is waiting on; decisions are the
 *           |  audit trail of every allow, deny and ask. All three
 *           |  survive a restart, which is what lets a run paused on an
 *           |  approval finish after Core comes back.
 *  How      |  PermissionStore is the interface; PgPermissionStore and
 *           |  MemoryPermissionStore implement it. decide() only reads
 *           |  grants (GrantSource); everything else is written by the
 *           |  conductor and the approval routes.
 * ------------------------------------------------------------------
 */

import type { Approval, Decision, Grant, Tier } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import { pgSafe } from '../db/json';
import type { GrantLike, GrantSource } from './decide';

export interface NewApproval {
  runId: string;
  stepSeq: number;
  threadId: string | null;
  callId: string;
  principal: string;
  tool: string;
  action: string;
  resource: string;
  args: unknown;
  argsPreview: unknown;
  tier: 'gated' | 'critical';
  suggestions: string[];
  expiresAt?: string | null;
}

export interface ApprovalRecord extends Approval {
  principal: string;
  step_seq: number;
  call_id: string | null;
  args: unknown;
  decision_scope: string | null;
  decision_pattern: string | null;
  reason: string | null;
}

export interface NewGrant {
  userId: string;
  principal: string;
  actionPattern: string;
  resourcePattern: string;
  effect: 'allow' | 'deny';
  scope: GrantLike['scope'];
  scopeRef: string | null;
  expiresAt: string | null;
  fromApprovalId: string | null;
}

export interface GrantPatch {
  resourcePattern?: string;
  scope?: GrantLike['scope'];
  scopeRef?: string | null;
  expiresAt?: string | null;
}

export interface NewDecision {
  userId: string;
  principal: string;
  action: string;
  resource: string;
  tier: Tier;
  outcome: Decision['outcome'];
  grantId?: string | null;
  approvalId?: string | null;
  policyId?: string | null;
  runId?: string | null;
  traceId: string;
}

export interface PermissionStore extends GrantSource {
  createGrant(g: NewGrant): Promise<Grant>;
  listGrants(): Promise<Grant[]>;
  revokeGrant(id: string): Promise<boolean>;
  extendGrant(id: string, expiresAt: string | null): Promise<Grant | undefined>;
  /** Change an active grant in place; absent fields stay as they are. */
  updateGrant(id: string, patch: GrantPatch): Promise<Grant | undefined>;
  /** Take back a revocation made within `withinMs`; older ones stay revoked. */
  restoreGrant(id: string, withinMs: number): Promise<Grant | undefined>;
  recordGrantUse(id: string): Promise<void>;

  /** Idempotent on (run, call): asking again for the same call returns the first approval. */
  createApproval(a: NewApproval): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | undefined>;
  pendingApprovals(): Promise<ApprovalRecord[]>;
  approvalsForRun(runId: string): Promise<ApprovalRecord[]>;
  /** Pending approvals past their expiry become `expired`; returns them. */
  expireDue(now: Date): Promise<ApprovalRecord[]>;
  /** Pending → approved/denied/cancelled. Returns false if it was no longer pending. */
  resolveApproval(
    id: string,
    r: {
      status: 'approved' | 'denied' | 'expired' | 'cancelled';
      decidedBy?: string;
      scope?: string;
      pattern?: string | null;
      reason?: string | null;
    },
  ): Promise<boolean>;
  cancelApprovalsForRun(runId: string): Promise<string[]>;

  recordDecision(d: NewDecision): Promise<Decision>;
  listDecisions(limit?: number): Promise<Decision[]>;
  /** Every decision a run caused, oldest first (the "why" view). */
  decisionsForRun(runId: string): Promise<Decision[]>;
}

const grantToLike = (g: Grant): GrantLike => ({
  id: g.id,
  principal: g.principal,
  actionPattern: g.action_pattern,
  resourcePattern: g.resource_pattern,
  effect: g.effect,
  scope: g.scope,
  scopeRef: g.scope_ref,
  expiresAt: g.expires_at,
  revokedAt: g.revoked_at,
});

/* ---- Postgres ------------------------------------------------------------- */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

interface GrantRow {
  id: string;
  principal: string;
  action_pattern: string;
  resource_pattern: string;
  effect: 'allow' | 'deny';
  scope: Grant['scope'];
  scope_ref: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  uses: number;
  last_used_at: Date | null;
  created_from_approval_id: string | null;
  created_at: Date;
}

const grantFromRow = (r: GrantRow): Grant => ({
  id: r.id,
  principal: r.principal as Grant['principal'],
  action_pattern: r.action_pattern,
  resource_pattern: r.resource_pattern,
  effect: r.effect,
  scope: r.scope,
  scope_ref: r.scope_ref,
  expires_at: iso(r.expires_at),
  revoked_at: iso(r.revoked_at),
  uses: r.uses,
  last_used_at: iso(r.last_used_at),
  created_from_approval_id: r.created_from_approval_id,
  created_at: r.created_at.toISOString(),
});

interface ApprovalRow {
  id: string;
  run_id: string;
  step_seq: number;
  thread_id: string | null;
  call_id: string | null;
  principal: string;
  tool: string;
  action: string;
  resource: string;
  args: unknown;
  args_preview: unknown;
  suggestions: string[];
  tier: 'gated' | 'critical';
  status: Approval['status'];
  decision_scope: string | null;
  decision_pattern: string | null;
  reason: string | null;
  expires_at: Date | null;
  created_at: Date;
}

const approvalFromRow = (r: ApprovalRow): ApprovalRecord => ({
  id: r.id,
  run_id: r.run_id,
  step_seq: r.step_seq,
  thread_id: r.thread_id,
  call_id: r.call_id,
  principal: r.principal,
  tool: r.tool,
  action: r.action,
  resource: r.resource,
  args: r.args,
  args_preview: r.args_preview,
  suggestions: r.suggestions ?? [],
  tier: r.tier,
  status: r.status,
  decision_scope: r.decision_scope,
  decision_pattern: r.decision_pattern,
  reason: r.reason,
  created_at: r.created_at.toISOString(),
  expires_at: iso(r.expires_at),
});

interface DecisionRow {
  id: string;
  at: Date;
  principal: string;
  action: string;
  resource: string;
  tier: Tier;
  outcome: Decision['outcome'];
  grant_id: string | null;
  approval_id: string | null;
  policy_id: string | null;
  run_id: string | null;
  trace_id: string;
}

const decisionFromRow = (r: DecisionRow): Decision => ({
  id: r.id,
  at: r.at.toISOString(),
  principal: r.principal as Decision['principal'],
  action: r.action,
  resource: r.resource,
  tier: r.tier,
  outcome: r.outcome,
  grant_id: r.grant_id,
  approval_id: r.approval_id,
  policy_id: r.policy_id,
  run_id: r.run_id,
  trace_id: r.trace_id,
});

export class PgPermissionStore implements PermissionStore {
  constructor(private readonly sql: Sql) {}

  async forPrincipal(principal: string): Promise<GrantLike[]> {
    const rows = await this.sql<GrantRow[]>`
      select * from core.grants where principal = ${principal} and revoked_at is null
        and (expires_at is null or expires_at > now())`;
    return rows.map(grantFromRow).map(grantToLike);
  }

  async createGrant(g: NewGrant) {
    const rows = await this.sql<GrantRow[]>`
      insert into core.grants (id, user_id, principal, action_pattern, resource_pattern, effect, scope, scope_ref, expires_at, created_from_approval_id)
      values (${`gnt_${ulid()}`}, ${g.userId}, ${g.principal}, ${g.actionPattern}, ${g.resourcePattern}, ${g.effect}, ${g.scope},
        ${g.scopeRef}, ${g.expiresAt}, ${g.fromApprovalId})
      returning *`;
    return grantFromRow(rows[0] as GrantRow);
  }

  async listGrants() {
    const rows = await this.sql<
      GrantRow[]
    >`select * from core.grants where revoked_at is null order by created_at desc`;
    return rows.map(grantFromRow);
  }

  async revokeGrant(id: string) {
    const rows = await this
      .sql`update core.grants set revoked_at = now() where id = ${id} and revoked_at is null returning id`;
    return rows.length > 0;
  }

  async extendGrant(id: string, expiresAt: string | null) {
    const rows = await this.sql<GrantRow[]>`
      update core.grants set expires_at = ${expiresAt} where id = ${id} and revoked_at is null returning *`;
    return rows[0] ? grantFromRow(rows[0]) : undefined;
  }

  async updateGrant(id: string, p: GrantPatch) {
    const rows = await this.sql<GrantRow[]>`
      update core.grants set
        resource_pattern = coalesce(${p.resourcePattern ?? null}::text, resource_pattern),
        scope = coalesce(${p.scope ?? null}::text, scope),
        scope_ref = case when ${'scopeRef' in p}::boolean then ${p.scopeRef ?? null}::text else scope_ref end,
        expires_at = case when ${'expiresAt' in p}::boolean then ${p.expiresAt ?? null}::timestamptz else expires_at end
      where id = ${id} and revoked_at is null returning *`;
    return rows[0] ? grantFromRow(rows[0]) : undefined;
  }

  async restoreGrant(id: string, withinMs: number) {
    const rows = await this.sql<GrantRow[]>`
      update core.grants set revoked_at = null
      where id = ${id} and revoked_at is not null
        and revoked_at > now() - make_interval(secs => ${withinMs / 1000})
      returning *`;
    return rows[0] ? grantFromRow(rows[0]) : undefined;
  }

  async recordGrantUse(id: string) {
    await this.sql`update core.grants set uses = uses + 1, last_used_at = now() where id = ${id}`;
  }

  async createApproval(a: NewApproval) {
    const rows = await this.sql<ApprovalRow[]>`
      insert into core.approvals (id, run_id, step_seq, thread_id, call_id, principal, tool, action, resource, args, args_preview,
        suggestions, tier, status, expires_at)
      values (${`apr_${ulid()}`}, ${a.runId}, ${a.stepSeq}, ${a.threadId}, ${a.callId}, ${a.principal}, ${a.tool}, ${a.action},
        ${a.resource}, ${this.sql.json(pgSafe(a.args ?? null) as never)}, ${this.sql.json(pgSafe(a.argsPreview ?? null) as never)},
        ${this.sql.json(pgSafe(a.suggestions) as never)}, ${a.tier}, 'pending', ${a.expiresAt ?? null})
      on conflict (run_id, call_id) do nothing
      returning *`;
    if (rows[0]) return approvalFromRow(rows[0]);
    const existing = await this.sql<ApprovalRow[]>`
      select * from core.approvals where run_id = ${a.runId} and call_id = ${a.callId}`;
    return approvalFromRow(existing[0] as ApprovalRow);
  }

  async getApproval(id: string) {
    const rows = await this.sql<ApprovalRow[]>`select * from core.approvals where id = ${id}`;
    return rows[0] ? approvalFromRow(rows[0]) : undefined;
  }

  async pendingApprovals() {
    const rows = await this.sql<
      ApprovalRow[]
    >`select * from core.approvals where status = 'pending' order by created_at`;
    return rows.map(approvalFromRow);
  }

  async approvalsForRun(runId: string) {
    const rows = await this.sql<ApprovalRow[]>`
      select * from core.approvals where run_id = ${runId} order by created_at`;
    return rows.map(approvalFromRow);
  }

  async expireDue(now: Date) {
    const rows = await this.sql<ApprovalRow[]>`
      update core.approvals set status = 'expired', decided_at = now()
      where status = 'pending' and expires_at is not null and expires_at <= ${now.toISOString()}::timestamptz
      returning *`;
    return rows.map(approvalFromRow);
  }

  async resolveApproval(id: string, r: Parameters<PermissionStore['resolveApproval']>[1]) {
    const rows = await this.sql`
      update core.approvals set status = ${r.status}, decided_by = ${r.decidedBy ?? null}, decided_at = now(),
        decision_scope = ${r.scope ?? null}, decision_pattern = ${r.pattern ?? null}, reason = ${r.reason ?? null}
      where id = ${id} and status = 'pending' returning id`;
    return rows.length > 0;
  }

  async cancelApprovalsForRun(runId: string) {
    const rows = await this.sql<{ id: string }[]>`
      update core.approvals set status = 'cancelled', decided_at = now() where run_id = ${runId} and status = 'pending' returning id`;
    return rows.map((r) => r.id);
  }

  async recordDecision(d: NewDecision) {
    const rows = await this.sql<DecisionRow[]>`
      insert into core.decisions (id, user_id, principal, action, resource, tier, outcome, grant_id, approval_id, policy_id, run_id, trace_id)
      values (${`dec_${ulid()}`}, ${d.userId}, ${d.principal}, ${d.action}, ${d.resource}, ${d.tier}, ${d.outcome},
        ${d.grantId ?? null}, ${d.approvalId ?? null}, ${d.policyId ?? null}, ${d.runId ?? null}, ${d.traceId})
      returning *`;
    return decisionFromRow(rows[0] as DecisionRow);
  }

  async listDecisions(limit = 200) {
    const rows = await this.sql<DecisionRow[]>`select * from core.decisions order by at desc limit ${limit}`;
    return rows.map(decisionFromRow);
  }

  async decisionsForRun(runId: string) {
    const rows = await this.sql<DecisionRow[]>`
      select * from core.decisions where run_id = ${runId} order by at asc, id asc limit 500`;
    return rows.map(decisionFromRow);
  }
}

/* ---- Memory (unit tests) -------------------------------------------------- */

export class MemoryPermissionStore implements PermissionStore {
  readonly grants = new Map<string, Grant & { userId: string }>();
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly decisions: Decision[] = [];
  private n = 0;
  private id(prefix: string) {
    return `${prefix}_${String(++this.n).padStart(26, '0')}`;
  }
  now = () => Date.now();

  async forPrincipal(principal: string) {
    const now = this.now();
    return [...this.grants.values()]
      .filter(
        (g) =>
          g.principal === principal && !g.revoked_at && (!g.expires_at || Date.parse(g.expires_at) > now),
      )
      .map(grantToLike);
  }

  async createGrant(g: NewGrant) {
    const rec = {
      id: this.id('gnt'),
      userId: g.userId,
      principal: g.principal as Grant['principal'],
      action_pattern: g.actionPattern,
      resource_pattern: g.resourcePattern,
      effect: g.effect,
      scope: g.scope,
      scope_ref: g.scopeRef,
      expires_at: g.expiresAt,
      revoked_at: null,
      uses: 0,
      last_used_at: null,
      created_from_approval_id: g.fromApprovalId,
      created_at: new Date(this.now()).toISOString(),
    };
    this.grants.set(rec.id, rec);
    const { userId: _u, ...out } = rec;
    return out;
  }

  async listGrants() {
    return [...this.grants.values()].filter((g) => !g.revoked_at).map(({ userId: _u, ...g }) => g);
  }

  async revokeGrant(id: string) {
    const g = this.grants.get(id);
    if (!g || g.revoked_at) return false;
    g.revoked_at = new Date(this.now()).toISOString();
    return true;
  }

  async extendGrant(id: string, expiresAt: string | null) {
    const g = this.grants.get(id);
    if (!g || g.revoked_at) return undefined;
    g.expires_at = expiresAt;
    const { userId: _u, ...out } = g;
    return out;
  }

  async updateGrant(id: string, p: GrantPatch) {
    const g = this.grants.get(id);
    if (!g || g.revoked_at) return undefined;
    if (p.resourcePattern !== undefined) g.resource_pattern = p.resourcePattern;
    if (p.scope !== undefined) g.scope = p.scope;
    if ('scopeRef' in p) g.scope_ref = p.scopeRef ?? null;
    if ('expiresAt' in p) g.expires_at = p.expiresAt ?? null;
    const { userId: _u, ...out } = g;
    return out;
  }

  async restoreGrant(id: string, withinMs: number) {
    const g = this.grants.get(id);
    if (!g?.revoked_at || this.now() - Date.parse(g.revoked_at) > withinMs) return undefined;
    g.revoked_at = null;
    const { userId: _u, ...out } = g;
    return out;
  }

  async recordGrantUse(id: string) {
    const g = this.grants.get(id);
    if (g) {
      g.uses += 1;
      g.last_used_at = new Date(this.now()).toISOString();
    }
  }

  async createApproval(a: NewApproval) {
    // Mirrors the unique index approvals_one_per_call.
    for (const e of this.approvals.values())
      if (e.run_id === a.runId && e.call_id === a.callId) return structuredClone(e);
    const rec: ApprovalRecord = {
      id: this.id('apr'),
      run_id: a.runId,
      step_seq: a.stepSeq,
      thread_id: a.threadId,
      call_id: a.callId,
      principal: a.principal,
      tool: a.tool,
      action: a.action,
      resource: a.resource,
      args: structuredClone(a.args),
      args_preview: a.argsPreview,
      suggestions: a.suggestions,
      tier: a.tier,
      status: 'pending',
      decision_scope: null,
      decision_pattern: null,
      reason: null,
      created_at: new Date(this.now()).toISOString(),
      expires_at: a.expiresAt ?? null,
    };
    this.approvals.set(rec.id, rec);
    return structuredClone(rec);
  }

  async getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? structuredClone(a) : undefined;
  }

  async pendingApprovals() {
    return [...this.approvals.values()].filter((a) => a.status === 'pending').map((a) => structuredClone(a));
  }

  async approvalsForRun(runId: string) {
    return [...this.approvals.values()].filter((a) => a.run_id === runId).map((a) => structuredClone(a));
  }

  async expireDue(now: Date) {
    const out: ApprovalRecord[] = [];
    for (const a of this.approvals.values()) {
      if (a.status === 'pending' && a.expires_at && Date.parse(a.expires_at) <= now.getTime()) {
        a.status = 'expired';
        out.push(structuredClone(a));
      }
    }
    return out;
  }

  async resolveApproval(id: string, r: Parameters<PermissionStore['resolveApproval']>[1]) {
    const a = this.approvals.get(id);
    if (a?.status !== 'pending') return false;
    a.status = r.status;
    a.decision_scope = r.scope ?? null;
    a.decision_pattern = r.pattern ?? null;
    a.reason = r.reason ?? null;
    return true;
  }

  async cancelApprovalsForRun(runId: string) {
    const ids: string[] = [];
    for (const a of this.approvals.values()) {
      if (a.run_id === runId && a.status === 'pending') {
        a.status = 'cancelled';
        ids.push(a.id);
      }
    }
    return ids;
  }

  async recordDecision(d: NewDecision) {
    const rec: Decision = {
      id: this.id('dec'),
      at: new Date(this.now()).toISOString(),
      principal: d.principal as Decision['principal'],
      action: d.action,
      resource: d.resource,
      tier: d.tier,
      outcome: d.outcome,
      grant_id: d.grantId ?? null,
      approval_id: d.approvalId ?? null,
      policy_id: d.policyId ?? null,
      run_id: d.runId ?? null,
      trace_id: d.traceId,
    };
    this.decisions.unshift(rec);
    return rec;
  }

  async listDecisions(limit = 200) {
    return this.decisions.slice(0, limit);
  }

  async decisionsForRun(runId: string) {
    return this.decisions.filter((d) => d.run_id === runId).reverse();
  }
}
