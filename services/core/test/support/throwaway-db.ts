/**
 * A database of its own for a test file that changes the schema (backups,
 * restores, a "newer" ledger): made on the CORE_TEST_DATABASE_URL server,
 * given the bootstrap's extensions and schemas, and dropped afterwards.
 * Never the shared ancile_coretest database, never your workspace.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

const INIT = fileURLToPath(new URL('../../../../infra/db/init.sql', import.meta.url));

export interface Throwaway {
  url: string;
  sql: Sql;
  drop(): Promise<void>;
}

export async function throwawayDb(base: string, name: string): Promise<Throwaway> {
  if (!/^ancile_coretest_[a-z_]+$/.test(name)) throw new Error(`refusing to use ${name}`);
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  await sql.unsafe(readFileSync(INIT, 'utf8'));
  return {
    url,
    sql,
    drop: async () => {
      await sql.end({ timeout: 5 });
      const a = postgres(base, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
      await a.end();
    },
  };
}
