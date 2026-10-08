/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry store
 *  Ref      |  migrations/0010_telemetry.sql
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The queue of envelopes waiting to be sent, and the
 *           |  per-day counters they are rolled up from.
 *  How      |  Postgres in Core, memory in tests. The queue is capped:
 *           |  when it is full the oldest go first, so an install
 *           |  that is offline for weeks never grows without bound.
 * ------------------------------------------------------------------
 */

import type { telemetry } from '@nvx/contracts';
import type { Sql } from 'postgres';

export const QUEUE_MAX = 200;

export interface Queued {
  id: number;
  envelope: telemetry.TelemetryEnvelope;
  tries: number;
}

export interface TelemetryStore {
  enqueue(envelopes: telemetry.TelemetryEnvelope[]): Promise<void>;
  peek(limit: number): Promise<Queued[]>;
  remove(ids: number[]): Promise<void>;
  bump(ids: number[]): Promise<void>;
  queued(): Promise<number>;
  /** Add to per-day keys (c:…, h:…, e:…, x:…). */
  add(day: string, deltas: Record<string, number>): Promise<void>;
  /** Days before `before` that have counters, oldest first. */
  daysBefore(before: string): Promise<string[]>;
  day(day: string): Promise<Record<string, number>>;
  dropDay(day: string): Promise<void>;
  /** Everything: saying no to statistics. */
  purge(): Promise<void>;
}

export class MemoryTelemetryStore implements TelemetryStore {
  private q: Queued[] = [];
  private next = 1;
  private days = new Map<string, Map<string, number>>();

  async enqueue(envelopes: telemetry.TelemetryEnvelope[]) {
    for (const envelope of envelopes) this.q.push({ id: this.next++, envelope, tries: 0 });
    if (this.q.length > QUEUE_MAX) this.q.splice(0, this.q.length - QUEUE_MAX);
  }
  async peek(limit: number) {
    return this.q.slice(0, limit).map((x) => ({ ...x }));
  }
  async remove(ids: number[]) {
    this.q = this.q.filter((x) => !ids.includes(x.id));
  }
  async bump(ids: number[]) {
    for (const x of this.q) if (ids.includes(x.id)) x.tries++;
  }
  async queued() {
    return this.q.length;
  }
  async add(day: string, deltas: Record<string, number>) {
    const m = this.days.get(day) ?? new Map<string, number>();
    for (const [k, v] of Object.entries(deltas)) m.set(k, (m.get(k) ?? 0) + v);
    this.days.set(day, m);
  }
  async daysBefore(before: string) {
    return [...this.days.keys()].filter((d) => d < before).sort();
  }
  async day(day: string) {
    return Object.fromEntries(this.days.get(day) ?? []);
  }
  async dropDay(day: string) {
    this.days.delete(day);
  }
  async purge() {
    this.q = [];
    this.days.clear();
  }
}

export class PgTelemetryStore implements TelemetryStore {
  constructor(private readonly sql: Sql) {}

  async enqueue(envelopes: telemetry.TelemetryEnvelope[]) {
    if (!envelopes.length) return;
    await this.sql`
      insert into core.telemetry_queue ${this.sql(envelopes.map((e) => ({ envelope: this.sql.json(e as never) })))}`;
    await this.sql`
      delete from core.telemetry_queue where id in (
        select id from core.telemetry_queue order by id desc offset ${QUEUE_MAX})`;
  }
  async peek(limit: number) {
    const rows = await this.sql<{ id: string; envelope: telemetry.TelemetryEnvelope; tries: number }[]>`
      select id, envelope, tries from core.telemetry_queue order by id limit ${limit}`;
    return rows.map((r) => ({ id: Number(r.id), envelope: r.envelope, tries: r.tries }));
  }
  async remove(ids: number[]) {
    if (ids.length) await this.sql`delete from core.telemetry_queue where id = any(${ids})`;
  }
  async bump(ids: number[]) {
    if (ids.length) await this.sql`update core.telemetry_queue set tries = tries + 1 where id = any(${ids})`;
  }
  async queued() {
    const [r] = await this.sql<{ n: string }[]>`select count(*) as n from core.telemetry_queue`;
    return Number(r?.n ?? 0);
  }
  async add(day: string, deltas: Record<string, number>) {
    const rows = Object.entries(deltas)
      .filter(([, n]) => n !== 0)
      .map(([key, n]) => ({ day, key, n }));
    if (!rows.length) return;
    await this.sql`
      insert into core.telemetry_daily ${this.sql(rows)}
      on conflict (day, key) do update set n = core.telemetry_daily.n + excluded.n`;
  }
  async daysBefore(before: string) {
    const rows = await this.sql<{ day: string }[]>`
      select distinct to_char(day, 'YYYY-MM-DD') as day from core.telemetry_daily
      where day < ${before}::date order by 1`;
    return rows.map((r) => r.day);
  }
  async day(day: string) {
    const rows = await this.sql<{ key: string; n: string }[]>`
      select key, n from core.telemetry_daily where day = ${day}::date`;
    return Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
  }
  async dropDay(day: string) {
    await this.sql`delete from core.telemetry_daily where day = ${day}::date`;
  }
  async purge() {
    await this.sql`delete from core.telemetry_queue`;
    await this.sql`delete from core.telemetry_daily`;
  }
}
