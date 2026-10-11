/**
 * ------------------------------------------------------------------
 *  Title    |  Run stores
 *  Ref      |  DESIGN.md §7.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Where runs and their recorded steps live. PgRunStore is
 *           |  the real one; MemoryRunStore has the same semantics for
 *           |  unit tests (one claimer at a time, leases by clock).
 *  How      |  claim() is one UPDATE over a SKIP LOCKED subselect, so
 *           |  two workers can never take the same run. save() is a
 *           |  compare-and-set on the status (and lease) the writer saw,
 *           |  and clears the lease whenever the run leaves `running`.
 *           |  A thread has at most one live run: a partial unique index
 *           |  (0002_run_safety.sql) that create() turns into
 *           |  run.already_running. The memory store checks the same.
 * ------------------------------------------------------------------
 */

import { AncileError, type RunStatus } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import { pgSafe } from '../db/json';
import type { Expected, NewRun, RunKind, RunRecord, RunStore, StepRecord } from './engine';
import { TERMINAL } from './machine';

interface RunRow {
  id: string;
  kind: RunKind;
  status: RunStatus;
  attempt: number;
  step_cursor: number;
  checkpoint: unknown;
  trace_id: string;
  thread_id: string | null;
  message_id: string | null;
  error: unknown;
  lease_owner: string | null;
  created_at: Date;
  updated_at: Date;
}

const fromRow = (r: RunRow): RunRecord => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  attempt: r.attempt,
  stepCursor: r.step_cursor,
  checkpoint: r.checkpoint,
  traceId: r.trace_id,
  threadId: r.thread_id,
  messageId: r.message_id,
  error: r.error,
  leaseOwner: r.lease_owner,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** The thread already has a live run: one at a time, enforced by the store. */
export function alreadyRunning(runId?: string): AncileError {
  return new AncileError({
    code: 'run.already_running',
    title: 'This thread is already answering',
    hint: 'Wait for it, or stop it first.',
    status: 409,
    errorClass: 'permanent',
    ...(runId && { context: { run_id: runId } }),
  });
}

const ACTIVE = ['queued', 'running', 'waiting_approval', 'waiting_compute'] as const;

export class PgRunStore implements RunStore {
  constructor(private readonly sql: Sql) {}

  async create(run: NewRun): Promise<RunRecord> {
    try {
      const rows = await this.sql<RunRow[]>`
        insert into core.runs (id, kind, thread_id, message_id, status, checkpoint, trace_id)
        values (${run.id}, ${run.kind}, ${run.threadId}, ${run.messageId}, 'queued', ${this.sql.json(pgSafe(run.checkpoint) as never)}, ${run.traceId})
        returning *`;
      return fromRow(rows[0] as RunRow);
    } catch (err) {
      const e = err as { code?: string; constraint_name?: string };
      if (e.code === '23505' && e.constraint_name === 'runs_one_active_per_thread') {
        const live = run.threadId ? (await this.activeForThread(run.threadId))[0] : undefined;
        throw alreadyRunning(live?.id);
      }
      throw err;
    }
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const rows = await this.sql<RunRow[]>`select * from core.runs where id = ${id}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async claim(owner: string, leaseMs: number): Promise<RunRecord | null> {
    const rows = await this.sql<RunRow[]>`
      update core.runs set status = 'running', lease_owner = ${owner},
        lease_until = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      where id = (
        select id from core.runs where status = 'queued'
        order by created_at for update skip locked limit 1
      )
      returning *`;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async claimMany(owner: string, leaseMs: number, n: number): Promise<RunRecord[]> {
    const rows = await this.sql<RunRow[]>`
      update core.runs set status = 'running', lease_owner = ${owner},
        lease_until = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      where id in (
        select id from core.runs where status = 'queued'
        order by created_at, id for update skip locked limit ${n}
      )
      returning *`;
    // Oldest first; runs made in the same instant keep their (monotonic) id order.
    return rows
      .map(fromRow)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  }

  async renew(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const rows = await this.sql`
      update core.runs set lease_until = now() + ${leaseMs} * interval '1 millisecond'
      where id = ${id} and lease_owner = ${owner} and status = 'running'
      returning id`;
    return rows.length > 0;
  }

  async save(run: RunRecord, expected: Expected): Promise<boolean> {
    const keepLease = run.status === 'running';
    const checkOwner = expected.owner !== undefined;
    const owner = expected.owner ?? null;
    const expiredBy = expected.leaseExpiredBy?.toISOString() ?? null;
    const rows = await this.sql`
      update core.runs set status = ${run.status}, attempt = ${run.attempt}, step_cursor = ${run.stepCursor},
        checkpoint = ${this.sql.json(pgSafe(run.checkpoint ?? null) as never)},
        error = ${run.error === undefined || run.error === null ? null : this.sql.json(pgSafe(run.error) as never)},
        lease_owner = case when ${keepLease} then lease_owner else null end,
        lease_until = case when ${keepLease} then lease_until else null end,
        updated_at = now()
      where id = ${run.id} and status = ${expected.status}
        and (not ${checkOwner} or lease_owner is not distinct from ${owner}::text)
        and (${expiredBy}::timestamptz is null or lease_until is null or lease_until < ${expiredBy}::timestamptz)
      returning id`;
    return rows.length > 0;
  }

  async expiredLeases(now: Date): Promise<RunRecord[]> {
    const rows = await this.sql<RunRow[]>`
      select * from core.runs where status = 'running' and (lease_until is null or lease_until < ${now.toISOString()}::timestamptz)`;
    return rows.map(fromRow);
  }

  async activeForThread(threadId: string): Promise<RunRecord[]> {
    const rows = await this.sql<RunRow[]>`
      select * from core.runs where thread_id = ${threadId}
        and status in ${this.sql(ACTIVE)}
      order by created_at desc`;
    return rows.map(fromRow);
  }

  async forThread(threadId: string, kind: RunKind): Promise<RunRecord[]> {
    const rows = await this.sql<RunRow[]>`
      select * from core.runs where thread_id = ${threadId} and kind = ${kind} order by created_at, id`;
    return rows.map(fromRow);
  }

  async withStatus(status: RunStatus, limit = 200): Promise<RunRecord[]> {
    const rows = await this.sql<RunRow[]>`
      select * from core.runs where status = ${status} order by updated_at limit ${limit}`;
    return rows.map(fromRow);
  }

  async step(runId: string, seq: number): Promise<StepRecord | undefined> {
    const rows = await this.sql<
      {
        seq: number;
        kind: string;
        idempotency_key: string;
        status: StepRecord['status'];
        input: unknown;
        output: unknown;
      }[]
    >`
      select seq, kind, idempotency_key, status, input, output from core.run_steps where run_id = ${runId} and seq = ${seq}`;
    const r = rows[0];
    return r
      ? {
          runId,
          seq: r.seq,
          kind: r.kind,
          idempotencyKey: r.idempotency_key,
          status: r.status,
          input: r.input,
          output: r.output,
        }
      : undefined;
  }

  async putStep(s: StepRecord): Promise<void> {
    const done = s.status !== 'in_progress' && s.status !== 'waiting';
    await this.sql`
      insert into core.run_steps (id, run_id, seq, kind, idempotency_key, status, input, output, ended_at)
      values (${`stp_${ulid()}`}, ${s.runId}, ${s.seq}, ${s.kind}, ${s.idempotencyKey}, ${s.status},
        ${this.sql.json(pgSafe(s.input ?? null) as never)}, ${this.sql.json(pgSafe(s.output ?? null) as never)}, ${done ? new Date().toISOString() : null}::timestamptz)
      on conflict (run_id, seq) do update set status = excluded.status, output = excluded.output, ended_at = excluded.ended_at`;
  }
}

type MemoryRun = RunRecord & { leaseOwner: string | null; leaseUntil: number | null };

export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, MemoryRun>();
  readonly steps = new Map<string, StepRecord>();
  now = () => Date.now();

  async create(run: NewRun): Promise<RunRecord> {
    // Mirrors the partial unique index runs_one_active_per_thread.
    for (const r of this.runs.values())
      if (run.threadId && r.threadId === run.threadId && !TERMINAL.has(r.status)) throw alreadyRunning(r.id);
    const at = new Date(this.now()).toISOString();
    const rec: MemoryRun = {
      ...run,
      checkpoint: structuredClone(run.checkpoint),
      status: 'queued' as const,
      attempt: 0,
      stepCursor: 0,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: at,
      updatedAt: at,
    };
    this.runs.set(run.id, rec);
    return { ...rec };
  }

  async get(id: string) {
    const r = this.runs.get(id);
    return r ? { ...r } : undefined;
  }

  async claim(owner: string, leaseMs: number) {
    for (const r of this.runs.values()) {
      if (r.status !== 'queued') continue;
      Object.assign(r, { status: 'running', leaseOwner: owner, leaseUntil: this.now() + leaseMs });
      return { ...r };
    }
    return null;
  }

  async claimMany(owner: string, leaseMs: number, n: number) {
    const out: RunRecord[] = [];
    for (let i = 0; i < n; i++) {
      const r = await this.claim(owner, leaseMs);
      if (!r) break;
      out.push(r);
    }
    return out;
  }

  async renew(id: string, owner: string, leaseMs: number) {
    const r = this.runs.get(id);
    if (!r || r.leaseOwner !== owner || r.status !== 'running') return false;
    r.leaseUntil = this.now() + leaseMs;
    return true;
  }

  async save(run: RunRecord, expected: Expected) {
    const r = this.runs.get(run.id);
    if (!r || r.status !== expected.status) return false;
    if (expected.owner !== undefined && r.leaseOwner !== expected.owner) return false;
    if (expected.leaseExpiredBy && r.leaseUntil !== null && r.leaseUntil >= expected.leaseExpiredBy.getTime())
      return false;
    const keep = run.status === 'running';
    const { leaseOwner: _o, ...fields } = run as MemoryRun;
    const { leaseUntil: _u, ...rest } = fields as Partial<MemoryRun>;
    Object.assign(r, structuredClone(rest), {
      leaseOwner: keep ? r.leaseOwner : null,
      leaseUntil: keep ? r.leaseUntil : null,
      updatedAt: new Date(this.now()).toISOString(),
    });
    return true;
  }

  async expiredLeases(now: Date) {
    return [...this.runs.values()]
      .filter((r) => r.status === 'running' && (r.leaseUntil === null || r.leaseUntil < now.getTime()))
      .map((r) => ({ ...r }));
  }

  async activeForThread(threadId: string) {
    return [...this.runs.values()]
      .filter((r) => r.threadId === threadId && !TERMINAL.has(r.status))
      .reverse()
      .map((r) => ({ ...r }));
  }

  async forThread(threadId: string, kind: RunKind) {
    return [...this.runs.values()]
      .filter((r) => r.threadId === threadId && r.kind === kind)
      .map((r) => ({ ...r }));
  }

  async withStatus(status: RunStatus, limit = 200) {
    return [...this.runs.values()]
      .filter((r) => r.status === status)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async step(runId: string, seq: number) {
    return this.steps.get(`${runId}:${seq}`);
  }

  async putStep(s: StepRecord) {
    this.steps.set(`${s.runId}:${s.seq}`, { ...s });
  }
}
