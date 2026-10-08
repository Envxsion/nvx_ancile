/**
 * ------------------------------------------------------------------
 *  Title    |  Database client
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One pooled postgres.js connection for Core's queries,
 *           |  and a drizzle handle for code that wants the typed
 *           |  query builder.
 *  How      |  connect() retries with backoff through @nvx/resilience,
 *           |  so Core comes up cleanly when it starts before Postgres
 *           |  is ready (DESIGN.md §7.6).
 *  Note     |  drizzle's postgres-js driver replaces the client's json,
 *           |  jsonb and timestamp serialisers with pass-throughs, which
 *           |  breaks plain tagged-template queries on the same client
 *           |  (sql.json() and Date parameters stop binding). So drizzle
 *           |  gets its own small pool, created on first use.
 * ------------------------------------------------------------------
 */

import { ClassifiedError, retry } from '@nvx/resilience';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { logFor } from '../obs/logger';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  sql: Sql;
  db: Db;
  close(): Promise<void>;
}

const log = logFor('db');

export async function connect(
  url: string,
  opts: { poolMax?: number; attempts?: number } = {},
): Promise<Database> {
  const sql = postgres(url, {
    max: opts.poolMax ?? 10,
    idle_timeout: 30,
    connect_timeout: 5,
    onnotice: () => {},
    connection: { application_name: 'ancile-core' },
  });

  await retry(
    async (attempt) => {
      try {
        await sql`select 1`;
      } catch (err) {
        log.warn({ attempt, err: (err as Error).message }, 'database not reachable yet');
        throw new ClassifiedError('transient', 'database unreachable', { cause: err });
      }
    },
    { maxAttempts: opts.attempts ?? 8, baseMs: 500, capMs: 5000 },
  );

  let drizzleClient: Sql | null = null;
  let db: Db | null = null;
  return {
    sql,
    get db() {
      drizzleClient ??= postgres(url, {
        max: 2,
        idle_timeout: 30,
        connect_timeout: 5,
        onnotice: () => {},
        connection: { application_name: 'ancile-core-orm' },
      });
      db ??= drizzle(drizzleClient, { schema });
      return db;
    },
    close: async () => {
      await Promise.all([sql.end({ timeout: 5 }), drizzleClient?.end({ timeout: 5 })]);
    },
  };
}
