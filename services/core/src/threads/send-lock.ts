/**
 * ------------------------------------------------------------------
 *  Title    |  One sender per thread
 *  Ref      |  docs/api.md (One sender at a time) · migrations/0030
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Two Cockpit windows (later a phone) sending into one
 *           |  thread at once: the second is told plainly that another
 *           |  window is sending (thread.busy), instead of two turns
 *           |  racing for the same place in the thread.
 *  How      |  A lock per thread, shared across clients through the
 *           |  database (one row per thread, core.thread_send_locks),
 *           |  on top of idempotency keys. A window holds it from the
 *           |  moment it sends until the run its send started is no
 *           |  longer active. Taking it is one atomic statement: free
 *           |  when there is no row, when the row is the same window's,
 *           |  when its lease ran out before a run was started (a crash
 *           |  or a timeout mid-send), or when the run it started has
 *           |  ended. Nothing needs to clean up for it to come free.
 *  Note     |  The holder is a window's random id (CLIENT_ID_HEADER),
 *           |  never a person or a secret. A request without one is a
 *           |  holder of its own. One active run per thread is still
 *           |  the database's own rule (runs_one_active_per_thread).
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { AncileError } from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { RunStore } from '../runs/engine';

/** How long a send may take before its lock comes free by itself (no run started yet). */
export const SEND_LEASE_MS = 30_000;

const ACTIVE = ['queued', 'running', 'waiting_approval', 'waiting_compute'] as const;

export function threadBusy(): AncileError {
  return new AncileError({
    code: 'thread.busy',
    title: 'Another window is sending in this thread',
    hint: 'Wait for it to finish, or send as a branch.',
    status: 409,
    errorClass: 'transient',
  });
}

/** Who is sending: the window's own id from its header, or a holder of its own. */
export function holderOf(header: string | null | undefined): string {
  const h = header?.trim() ?? '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(h) ? `win:${h}` : `req:${randomUUID()}`;
}

export type Acquired = { ok: true } | { ok: false; holder: string };

export interface SendLocks {
  /** Take the thread's lock for this holder, or say who holds it. */
  acquire(threadId: string, holder: string, leaseMs?: number): Promise<Acquired>;
  /** The send started this run: the lock is held until the run is no longer active. */
  attach(threadId: string, holder: string, runId: string): Promise<void>;
  /** The send did not start a run: let go at once. */
  release(threadId: string, holder: string): Promise<void>;
}

/**
 * Run a send under the thread's lock. A send that starts a run keeps the
 * lock until that run ends; one that fails lets go at once. The same
 * window sending again while its own turn runs hears "already answering",
 * as before; another window hears thread.busy.
 */
export async function withSendLock<T extends { run_id: string }>(
  locks: SendLocks | null | undefined,
  threadId: string,
  holder: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!locks) return fn();
  const got = await locks.acquire(threadId, holder);
  if (!got.ok) throw threadBusy();
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    // Nothing started: let go (a turn this window started earlier and still running keeps it).
    await locks.release(threadId, holder).catch(() => undefined);
    throw err;
  }
  await locks.attach(threadId, holder, out.run_id).catch(() => undefined);
  return out;
}

export class PgSendLocks implements SendLocks {
  constructor(private readonly sql: Sql) {}

  async acquire(threadId: string, holder: string, leaseMs = SEND_LEASE_MS): Promise<Acquired> {
    const sql = this.sql;
    const rows = await sql<{ holder: string }[]>`
      insert into core.thread_send_locks as l (thread_id, holder, run_id, lease_until, acquired_at)
      values (${threadId}, ${holder}, null, now() + ${leaseMs} * interval '1 millisecond', now())
      on conflict (thread_id) do update set
        holder = excluded.holder,
        run_id = case when l.holder = excluded.holder then l.run_id else null end,
        lease_until = excluded.lease_until,
        acquired_at = case when l.holder = excluded.holder then l.acquired_at else now() end
      where l.holder = excluded.holder
        or (l.run_id is null and l.lease_until < now())
        or (l.run_id is not null and not exists (
          select 1 from core.runs r where r.id = l.run_id and r.status in ${sql(ACTIVE)}))
      returning holder`;
    if (rows.length) return { ok: true };
    const held = await sql<{ holder: string }[]>`
      select holder from core.thread_send_locks where thread_id = ${threadId}`;
    return { ok: false, holder: held[0]?.holder ?? '' };
  }

  async attach(threadId: string, holder: string, runId: string): Promise<void> {
    await this.sql`
      update core.thread_send_locks set run_id = ${runId}
      where thread_id = ${threadId} and holder = ${holder}`;
  }

  async release(threadId: string, holder: string): Promise<void> {
    await this.sql`
      delete from core.thread_send_locks l where l.thread_id = ${threadId} and l.holder = ${holder}
        and (l.run_id is null or not exists (
          select 1 from core.runs r where r.id = l.run_id and r.status in ${this.sql(ACTIVE)}))`;
  }
}

/** The same rules in memory (tests, the harness), over a run store for "is its run still active". */
export class MemorySendLocks implements SendLocks {
  readonly rows = new Map<string, { holder: string; runId: string | null; leaseUntil: number }>();
  now = () => Date.now();
  constructor(private readonly runs: Pick<RunStore, 'get'>) {}

  async acquire(threadId: string, holder: string, leaseMs = SEND_LEASE_MS): Promise<Acquired> {
    const cur = this.rows.get(threadId);
    // Decide on what is known now, then set in the same tick: no await between check and set
    // except the run lookup, after which the row is read again.
    let free = !cur || cur.holder === holder || (cur.runId === null && cur.leaseUntil < this.now());
    if (!free && cur?.runId) {
      const run = await this.runs.get(cur.runId);
      free = !run || !(ACTIVE as readonly string[]).includes(run.status);
    }
    const again = this.rows.get(threadId);
    if (again !== cur) return this.acquire(threadId, holder, leaseMs);
    if (!free) return { ok: false, holder: cur?.holder ?? '' };
    this.rows.set(threadId, {
      holder,
      runId: cur && cur.holder === holder ? cur.runId : null,
      leaseUntil: this.now() + leaseMs,
    });
    return { ok: true };
  }

  async attach(threadId: string, holder: string, runId: string): Promise<void> {
    const cur = this.rows.get(threadId);
    if (cur && cur.holder === holder) this.rows.set(threadId, { ...cur, runId });
  }

  async release(threadId: string, holder: string): Promise<void> {
    const cur = this.rows.get(threadId);
    if (cur?.holder !== holder) return;
    if (cur.runId) {
      const run = await this.runs.get(cur.runId);
      if (run && (ACTIVE as readonly string[]).includes(run.status)) return;
    }
    if (this.rows.get(threadId) === cur) this.rows.delete(threadId);
  }
}
