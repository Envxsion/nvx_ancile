/**
 * ------------------------------------------------------------------
 *  Title    |  Migrations
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Apply src/db/migrations/*.sql in order, once each, in
 *           |  a transaction per file, recorded in core._migrations.
 *  How      |  Plain SQL files so the authoritative schema is readable
 *           |  without drizzle. pendingMigrations() powers the boot test
 *           |  "migrations current".
 * ------------------------------------------------------------------
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function migrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`create schema if not exists core`;
  await sql`create table if not exists core._migrations (name text primary key, applied_at timestamptz not null default now())`;
}

export async function pendingMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await ensureLedger(sql);
  const applied = new Set(
    (await sql<{ name: string }[]>`select name from core._migrations`).map((r) => r.name),
  );
  return (await migrationFiles(dir)).filter((f) => !applied.has(f));
}

export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const pending = await pendingMigrations(sql, dir);
  for (const name of pending) {
    const body = await readFile(join(dir, name), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe('insert into core._migrations (name) values ($1)', [name]);
    });
  }
  return pending;
}

// `pnpm db:migrate`
if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('migrate.ts')
) {
  const { default: postgres } = await import('postgres');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date.');
  await sql.end();
}
