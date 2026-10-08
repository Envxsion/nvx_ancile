/**
 * Global setup for the Postgres half of the store contract tests.
 *
 * When CORE_TEST_DATABASE_URL names a Postgres server (any database on it;
 * CI points it at its service container, locally the dev stack's), a fresh
 * database `ancile_coretest` is made, given the extensions and schemas the
 * bootstrap creates, migrated, and seeded with an owner. Its URL and owner
 * reach the tests through `inject`. Without the variable nothing happens and
 * the Postgres suites skip; the in-memory halves always run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { ensureOwner, type Owner } from '../../src/db/bootstrap';
import { migrate } from '../../src/db/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string | null;
    pgOwner: Owner | null;
  }
}

const DB = 'ancile_coretest';
const INIT = fileURLToPath(new URL('../../../../infra/db/init.sql', import.meta.url));

export default async function setup(project: TestProject) {
  const base = process.env.CORE_TEST_DATABASE_URL;
  if (!base) {
    project.provide('pgUrl', null);
    project.provide('pgOwner', null);
    return;
  }
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${DB} with (force)`);
    await admin.unsafe(`create database ${DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${DB}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(readFileSync(INIT, 'utf8'));
    await migrate(sql);
    project.provide('pgOwner', await ensureOwner(sql));
    project.provide('pgUrl', url.toString());
  } finally {
    await sql.end();
  }
  return async () => {
    const drop = postgres(base, { max: 1, onnotice: () => {} });
    await drop.unsafe(`drop database if exists ${DB} with (force)`).catch(() => undefined);
    await drop.end();
  };
}
