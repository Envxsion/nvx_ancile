/**
 * ------------------------------------------------------------------
 *  Title    |  Migrations
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Apply src/db/migrations/*.sql in order, once each, in
 *           |  a transaction per file, recorded in core._migrations.
 *  How      |  Plain SQL files so the authoritative schema is readable
 *           |  without drizzle. pendingMigrations() powers the boot test
 *           |  "migrations current". Each file and its ledger row
 *           |  commit together or not at all, so a migration cut off
 *           |  half way (a full disk, a crash) leaves the database as
 *           |  it was. The ledger also records which NVX Ancile applied
 *           |  each file (app_version), for the downgrade screen.
 *  Note     |  A migration must not COMMIT, BEGIN or use CREATE INDEX
 *           |  CONCURRENTLY: any of those would break the one
 *           |  transaction (assertTransactional refuses them).
 *           |  Start-up goes through db/prepare.ts, which backs up
 *           |  first and refuses to run on a newer database.
 * ------------------------------------------------------------------
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** The migration files this build knows, in order. */
export async function migrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

export async function ensureLedger(sql: Sql): Promise<void> {
  await sql`create schema if not exists core`;
  await sql`create table if not exists core._migrations (name text primary key, applied_at timestamptz not null default now())`;
  // Which NVX Ancile applied each file: an older one starting later can say who.
  await sql`alter table core._migrations add column if not exists app_version text`;
}

/** The migrations recorded in the database, in order. */
export async function appliedMigrations(sql: Sql): Promise<{ name: string; app_version: string | null }[]> {
  await ensureLedger(sql);
  return sql<{ name: string; app_version: string | null }[]>`
    select name, app_version from core._migrations order by name`;
}

export async function pendingMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const applied = new Set((await appliedMigrations(sql)).map((r) => r.name));
  return (await migrationFiles(dir)).filter((f) => !applied.has(f));
}

/**
 * Statements that end or escape the transaction a migration runs in. Kept
 * simple: a word at the start of a statement, outside $$ bodies (plpgsql
 * blocks legitimately say BEGIN).
 */
export function assertTransactional(name: string, body: string): void {
  const outside = body
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = /(^|;)\s*(begin|commit|rollback|start\s+transaction|end)\s*(;|$)|\bconcurrently\b/i.exec(
    outside,
  );
  if (bad)
    throw new Error(
      `${name} cannot run inside one transaction (${bad[0].replace(/[;\s]+/g, ' ').trim()}); split the work so each file is all or nothing`,
    );
}

export async function migrate(
  sql: Sql,
  dir = MIGRATIONS_DIR,
  opts: { appVersion?: string; only?: string } = {},
): Promise<string[]> {
  const pending = (await pendingMigrations(sql, dir)).filter((n) => !opts.only || n === opts.only);
  for (const name of pending) {
    const body = await readFile(join(dir, name), 'utf8');
    assertTransactional(name, body);
    // One transaction per file: the change and its ledger row, or neither.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe('insert into core._migrations (name, app_version) values ($1, $2)', [
        name,
        opts.appVersion ?? null,
      ]);
    });
  }
  return pending;
}
