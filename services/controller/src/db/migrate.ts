/**
 * ------------------------------------------------------------------
 *  Title    |  Migrations
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Apply migrations/*.sql in order, once each, in a
 *           |  transaction per file, recorded in controller._migrations.
 *  Note     |  Same ledger shape as Core's runner. The Controller is a
 *           |  separate deployable, so it keeps its own copy rather than
 *           |  importing Core.
 * ------------------------------------------------------------------
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

async function migrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`create schema if not exists controller`;
  await sql`create table if not exists controller._migrations (name text primary key, applied_at timestamptz not null default now())`;
}

export async function pendingMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await ensureLedger(sql);
  const applied = new Set(
    (await sql<{ name: string }[]>`select name from controller._migrations`).map((r) => r.name),
  );
  return (await migrationFiles(dir)).filter((f) => !applied.has(f));
}

export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const pending = await pendingMigrations(sql, dir);
  for (const name of pending) {
    const body = await readFile(join(dir, name), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe('insert into controller._migrations (name) values ($1)', [name]);
    });
  }
  return pending;
}

// `pnpm db:migrate`
if (process.argv[1]?.replace(/\\/g, '/').endsWith('db/migrate.ts')) {
  const { default: postgres } = await import('postgres');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run through `pnpm start`, or set it in .env.');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date.');
  await sql.end();
}
