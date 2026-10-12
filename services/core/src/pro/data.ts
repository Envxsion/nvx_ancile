/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: Pro's data, whatever the licence says
 *  Ref      |  DESIGN.md §9 · ROADMAP.md track G · docs/desktop.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When a licence lapses, or the build goes back to the
 *           |  free edition, what Pro made (context packs, insights,
 *           |  fleet settings, sync state) stays on disk, readable and
 *           |  exportable, and is never deleted. Turning Pro on again
 *           |  finds it as it was.
 *  How      |  Pro keeps its tables in the `pro` schema (ProDb). These
 *           |  routes read that schema directly, so they work in the
 *           |  free build, which has no Pro code at all, and in a Pro
 *           |  build whose licence has lapsed (Pro's own routes are
 *           |  locked then). GET /system/pro-data: each table and its
 *           |  rows; GET /system/pro-data/export: every row, as JSON.
 *  Note     |  Read-only by construction: one READ ONLY transaction,
 *           |  identifiers quoted. Nothing in Core drops or truncates
 *           |  the `pro` schema; migrations only add.
 * ------------------------------------------------------------------
 */

import type { system } from '@nvx/contracts';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../app';

export const PRO_SCHEMA = 'pro';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function proTables(sql: Sql, schema: string): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = ${schema} and table_type = 'BASE TABLE'
    order by table_name`;
  return rows.map((r) => r.table_name);
}

/** JSON for any column type: bytes as base64, the rest as postgres.js reads them. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = Buffer.isBuffer(v) ? v.toString('base64') : v;
  return out;
}

export async function proDataSummary(sql: Sql, schema = PRO_SCHEMA): Promise<system.ProDataSummary> {
  return sql.begin('read only', async (tx) => {
    const tables: system.ProDataSummary['tables'] = [];
    for (const name of await proTables(tx as unknown as Sql, schema)) {
      const [r] = await tx.unsafe<{ n: string }[]>(
        `select count(*)::text as n from ${ident(schema)}.${ident(name)}`,
      );
      tables.push({ name, rows: Number(r?.n ?? 0) });
    }
    return { tables, total_rows: tables.reduce((n, t) => n + t.rows, 0) };
  }) as Promise<system.ProDataSummary>;
}

export async function proDataExport(
  sql: Sql,
  edition: 'free' | 'pro',
  schema = PRO_SCHEMA,
  now = () => new Date(),
): Promise<system.ProDataExport> {
  return sql.begin('read only', async (tx) => {
    const tables: system.ProDataExport['tables'] = {};
    for (const name of await proTables(tx as unknown as Sql, schema)) {
      const rows = await tx.unsafe<Record<string, unknown>[]>(
        `select * from ${ident(schema)}.${ident(name)}`,
      );
      tables[name] = rows.map(plain);
    }
    return { exported_at: now().toISOString(), edition, tables };
  }) as Promise<system.ProDataExport>;
}

/** Readable in every edition and with any licence: no feature check, GET only. */
export function proDataRoutes(deps: { sql: Sql; edition: () => 'free' | 'pro'; schema?: string }) {
  const r = new Hono<AppEnv>();
  r.get('/system/pro-data', async (c) => c.json(await proDataSummary(deps.sql, deps.schema)));
  r.get('/system/pro-data/export', async (c) => {
    const data = await proDataExport(deps.sql, deps.edition(), deps.schema);
    c.header(
      'content-disposition',
      `attachment; filename="nvx-ancile-pro-data-${data.exported_at.slice(0, 10)}.json"`,
    );
    c.header('cache-control', 'no-store');
    return c.json(data);
  });
  return r;
}
