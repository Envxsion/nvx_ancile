/**
 * Store contract tests: one suite, run against the in-memory store the
 * harness uses and against the Postgres store Core runs on, so both behave
 * the same. The Postgres half needs CORE_TEST_DATABASE_URL (see pg-setup.ts)
 * and skips without it.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, describe, inject } from 'vitest';
import type { Owner } from '../../src/db/bootstrap';

export interface Backend {
  name: 'memory' | 'postgres';
  owner: Owner;
  /** Only on the Postgres backend. */
  sql: Sql | null;
}

const MEMORY_OWNER: Owner = {
  userId: 'usr_01TESTUSER00000000000000000',
  workspaceId: 'wsp_01TESTWORKSPACE000000000000',
};

let shared: Sql | null = null;
function pg(): Sql | null {
  const url = inject('pgUrl');
  if (!url) return null;
  shared ??= postgres(url, { max: 4, onnotice: () => {} });
  return shared;
}

/**
 * Run `body` once per backend. `make` builds the store for that backend;
 * suites that need several stores build them from `backend.sql`.
 */
export function eachBackend(title: string, body: (backend: () => Backend) => void): void {
  for (const name of ['memory', 'postgres'] as const) {
    const sql = name === 'postgres' ? pg() : null;
    const owner = name === 'postgres' ? inject('pgOwner') : MEMORY_OWNER;
    describe.skipIf(name === 'postgres' && !sql)(`${title} (${name})`, () => {
      body(() => ({ name, owner: owner as Owner, sql }));
    });
  }
  afterAll(async () => {
    if (shared) {
      const s = shared;
      shared = null;
      await s.end();
    }
  });
}

/** A unique id per test, so suites never see each other's rows. */
let n = 0;
export const uid = (prefix: string) =>
  `${prefix}_T${Date.now().toString(36).toUpperCase()}${(n++).toString(36).toUpperCase().padStart(4, '0')}`;
