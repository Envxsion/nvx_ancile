import postgres from 'postgres';
import { afterAll, describe, expect } from 'vitest';
import { pendingMigrations } from '../../src/db/migrate';
import { atRealBoot, bootCheck } from './check';

const url = process.env.DATABASE_URL;

// At real boot the database is mandatory. In CI without one, say so and skip.
describe.skipIf(!url && !atRealBoot)('database', () => {
  const sql = postgres(url ?? 'postgres://missing', { max: 1, connect_timeout: 3, onnotice: () => {} });
  afterAll(() => sql.end({ timeout: 2 }));

  bootCheck(
    'Postgres answers',
    'Run `pnpm start`, which starts the embedded Postgres. If you set DATABASE_URL yourself, check its host, port and password.',
    async () => {
      const [row] = await sql<{ ok: number }[]>`select 1 as ok`;
      expect(row?.ok).toBe(1);
    },
  );

  bootCheck(
    'the pgvector extension is installed',
    'Run `pnpm start`: the embedded Postgres ships pgvector. On your own server, install pgvector and run `create extension vector;` as a superuser.',
    async () => {
      const rows = await sql`select 1 from pg_extension where extname = 'vector'`;
      expect(rows.length).toBe(1);
    },
  );

  bootCheck(
    'the core schema is up to date',
    'Run `pnpm --filter @nvx/ancile-core db:migrate`. Core also migrates itself on start unless ANCILE_BOOT_TESTS=strict blocks it first.',
    async () => {
      const pending = await pendingMigrations(sql);
      // At boot, Core applies pending migrations right after these checks; only report.
      if (!atRealBoot) expect(pending).toEqual([]);
    },
  );
});
