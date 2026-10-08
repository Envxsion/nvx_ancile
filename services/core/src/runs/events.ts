/**
 * ------------------------------------------------------------------
 *  Title    |  Run event log
 *  Ref      |  DESIGN.md §4.1 (run stream)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every event a run emits is persisted with a monotonic
 *           |  seq before it is sent, so closing the tab mid-answer
 *           |  loses nothing: reconnect with Last-Event-ID and the
 *           |  stream replays from there, then continues live.
 *  How      |  RunEventLog is the interface; MemoryRunEventLog backs
 *           |  tests. PgRunEventLog appends to core.run_events, one run
 *           |  at a time in order (appends are chained per run, so seq
 *           |  is gapless), then fans out to this process's tails.
 *  Note     |  Live tails are in-process: one Core serves the streams.
 *           |  TODO(phase-5): NOTIFY run:<id> when Core scales out.
 * ------------------------------------------------------------------
 */

import type { RunEvent } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';

/** A run event before the log assigns its seq and timestamp. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RunEventInput = DistributiveOmit<RunEvent, 'seq' | 'at'>;

export interface RunEventLog {
  append(runId: string, event: RunEventInput): Promise<RunEvent>;
  /** Events with seq > afterSeq, in order. */
  since(runId: string, afterSeq: number): Promise<RunEvent[]>;
  /** Live events after subscription. Returns an unsubscribe. */
  subscribe(runId: string, fn: (e: RunEvent) => void): () => void;
}

export class MemoryRunEventLog implements RunEventLog {
  private logs = new Map<string, RunEvent[]>();
  private subs = new Map<string, Set<(e: RunEvent) => void>>();

  async append(runId: string, event: RunEventInput): Promise<RunEvent> {
    const list = this.logs.get(runId) ?? [];
    const full = { ...event, seq: list.length + 1, at: new Date().toISOString() } as RunEvent;
    list.push(full);
    this.logs.set(runId, list);
    for (const fn of this.subs.get(runId) ?? []) fn(full);
    return full;
  }

  async since(runId: string, afterSeq: number): Promise<RunEvent[]> {
    return (this.logs.get(runId) ?? []).filter((e) => e.seq > afterSeq);
  }

  subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
    const set = this.subs.get(runId) ?? new Set();
    set.add(fn);
    this.subs.set(runId, set);
    return () => set.delete(fn);
  }
}

export class PgRunEventLog implements RunEventLog {
  private subs = new Map<string, Set<(e: RunEvent) => void>>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly sql: Sql) {}

  append(runId: string, event: RunEventInput): Promise<RunEvent> {
    const prev = this.chains.get(runId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.write(runId, event));
    this.chains.set(runId, next);
    // The caller handles a failed append; this branch only tidies the chain.
    next
      .catch(() => undefined)
      .finally(() => {
        if (this.chains.get(runId) === next) this.chains.delete(runId);
      });
    return next;
  }

  private async write(runId: string, event: RunEventInput): Promise<RunEvent> {
    const { type, ...data } = event;
    const rows = await this.sql<{ seq: number; at: Date }[]>`
      insert into core.run_events (run_id, seq, type, data)
      select ${runId}, coalesce(max(seq), 0) + 1, ${type}, ${this.sql.json(pgSafe(data) as never)}
      from core.run_events where run_id = ${runId}
      returning seq, at`;
    const row = rows[0] as { seq: number; at: Date };
    const full = { ...event, seq: row.seq, at: row.at.toISOString() } as RunEvent;
    for (const fn of this.subs.get(runId) ?? []) fn(full);
    return full;
  }

  async since(runId: string, afterSeq: number): Promise<RunEvent[]> {
    const rows = await this.sql<{ seq: number; type: string; data: Record<string, unknown>; at: Date }[]>`
      select seq, type, data, at from core.run_events where run_id = ${runId} and seq > ${afterSeq} order by seq`;
    return rows.map((r) => ({ ...r.data, type: r.type, seq: r.seq, at: r.at.toISOString() }) as RunEvent);
  }

  subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
    const set = this.subs.get(runId) ?? new Set();
    set.add(fn);
    this.subs.set(runId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(runId);
    };
  }
}

/**
 * Replay then tail, with no gap and no duplicate: subscribe first and buffer,
 * read history, then flush buffered events newer than the last replayed seq.
 */
export async function replayThenTail(
  log: RunEventLog,
  runId: string,
  afterSeq: number,
  emit: (e: RunEvent) => void,
): Promise<() => void> {
  let last = afterSeq;
  let buffering = true;
  const buffer: RunEvent[] = [];
  const unsubscribe = log.subscribe(runId, (e) => {
    if (buffering) buffer.push(e);
    else if (e.seq > last) {
      last = e.seq;
      emit(e);
    }
  });
  let history: RunEvent[];
  try {
    history = await log.since(runId, afterSeq);
  } catch (err) {
    unsubscribe();
    throw err;
  }
  for (const e of history) {
    last = e.seq;
    emit(e);
  }
  for (const e of buffer) {
    if (e.seq > last) {
      last = e.seq;
      emit(e);
    }
  }
  buffering = false;
  return unsubscribe;
}
