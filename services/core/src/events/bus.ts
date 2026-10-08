/**
 * ------------------------------------------------------------------
 *  Title    |  Event bus
 *  Ref      |  DESIGN.md §2 (LISTEN/NOTIFY → SSE), §4.1 global events
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Notifications, approvals, ingest progress, node
 *           |  operations and health changes reach every open tab on
 *           |  one resumable stream.
 *  How      |  Any service publishes with NOTIFY ancile_events '<json>';
 *           |  Core LISTENs, assigns a seq, keeps a short ring buffer
 *           |  for Last-Event-ID replay and fans out to SSE clients.
 *           |  MemoryEventBus is the same contract in-process.
 *  Note     |  NOTIFY payloads cap at 8 kB: publishers send ids and a
 *           |  one-line message, never documents.
 * ------------------------------------------------------------------
 */

import type { GlobalEvent } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { logFor } from '../obs/logger';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type GlobalEventInput = DistributiveOmit<GlobalEvent, 'seq' | 'at'>;

export const CHANNEL = 'ancile_events';

export interface EventBus {
  publish(event: GlobalEventInput): Promise<void>;
  /** Replay events after `afterSeq` that are still buffered, then live. */
  subscribe(afterSeq: number, fn: (e: GlobalEvent) => void): () => void;
}

export class MemoryEventBus implements EventBus {
  private seq = 0;
  private ring: GlobalEvent[] = [];
  private subs = new Set<(e: GlobalEvent) => void>();

  constructor(private readonly capacity = 500) {}

  /** Deliver an event that already happened elsewhere (used by PgEventBus). */
  deliver(event: GlobalEventInput): GlobalEvent {
    const full = { ...event, seq: ++this.seq, at: new Date().toISOString() } as GlobalEvent;
    this.ring.push(full);
    if (this.ring.length > this.capacity) this.ring.shift();
    for (const fn of this.subs) fn(full);
    return full;
  }

  async publish(event: GlobalEventInput): Promise<void> {
    this.deliver(event);
  }

  subscribe(afterSeq: number, fn: (e: GlobalEvent) => void): () => void {
    for (const e of this.ring) if (e.seq > afterSeq) fn(e);
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

/** Postgres-backed: events from Knowledge and the Controller arrive here too. */
export class PgEventBus implements EventBus {
  private readonly local = new MemoryEventBus();
  private readonly log = logFor('events');

  private constructor(private readonly sql: Sql) {}

  static async start(sql: Sql): Promise<PgEventBus> {
    const bus = new PgEventBus(sql);
    await sql.listen(CHANNEL, (payload) => {
      try {
        bus.local.deliver(JSON.parse(payload) as GlobalEventInput);
      } catch (err) {
        bus.log.warn({ err: (err as Error).message }, 'dropped malformed event');
      }
    });
    return bus;
  }

  async publish(event: GlobalEventInput): Promise<void> {
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload) > 7_900)
      throw new Error(`event ${event.type} is too large for NOTIFY; send ids, not documents`);
    await this.sql.notify(CHANNEL, payload);
  }

  subscribe(afterSeq: number, fn: (e: GlobalEvent) => void): () => void {
    return this.local.subscribe(afterSeq, fn);
  }
}
