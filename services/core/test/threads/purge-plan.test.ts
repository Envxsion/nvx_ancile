/**
 * The guard on the Trash purge: every table that points at a thread, a message, a branch or a run
 * has a reviewed entry in PURGE_PLAN. Reads the drizzle schema objects and the migration files,
 * never a database, so a table added later fails here until someone decides what a purge does to it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { PURGE_PLAN } from '../../src/threads/purge-plan';

const TARGETS = new Set(['threads', 'messages', 'branches', 'runs']);
/** A plain column that holds one of those ids, with or without a foreign key. */
const REF_COLUMN = /(^|_)(thread|message|run|branch)_id$/;
const REF_FK = /references\s+core\.(threads|messages|branches|runs)\b/i;
const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));

const planned = new Map(PURGE_PLAN.map((e) => [e.table.replace(/^core\./, ''), e]));

const tables = (Object.values(schema) as unknown[])
  .filter((v) => is(v, PgTable))
  .map((t) => getTableConfig(t as PgTable));

describe('purge plan', () => {
  it('has an entry for every drizzle table with a foreign key to threads, messages, branches or runs', () => {
    const missing: string[] = [];
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        const ref = fk.reference();
        const target = getTableConfig(ref.foreignTable).name;
        if (TARGETS.has(target) && !planned.has(t.name))
          missing.push(`${t.name} -> ${target} (${ref.columns.map((c) => c.name).join(',')})`);
      }
    }
    expect(missing, 'add each of these to PURGE_PLAN in src/threads/purge-plan.ts').toEqual([]);
  });

  it('has an entry for every drizzle table with a plain thread, message, run or branch id column', () => {
    const missing = tables
      .filter((t) => !TARGETS.has(t.name) && !planned.has(t.name))
      .filter((t) => t.columns.some((c) => REF_COLUMN.test(c.name)))
      .map((t) => t.name);
    expect(missing, 'add each of these to PURGE_PLAN in src/threads/purge-plan.ts').toEqual([]);
  });

  it('has an entry for every migration table that references or stores those ids', () => {
    const missing = new Set<string>();
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
      const sql = readFileSync(`${MIGRATIONS}${f}`, 'utf8');
      for (const m of sql.matchAll(/create table (?:if not exists )?core\.(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi)) {
        const table = m[1] as string;
        const body = m[2] as string;
        if (TARGETS.has(table) || planned.has(table)) continue;
        const plain = body.split('\n').some((line) => REF_COLUMN.test(line.trim().split(/\s+/)[0] ?? ''));
        if (REF_FK.test(body) || plain) missing.add(`${table} (${f})`);
      }
      for (const m of sql.matchAll(
        /alter table core\.(\w+)\s+add column(?: if not exists)? (\w+)([^;]*);/gi,
      )) {
        const table = m[1] as string;
        const col = m[2] as string;
        if (TARGETS.has(table) || planned.has(table)) continue;
        if (REF_COLUMN.test(col) || REF_FK.test(m[3] as string)) missing.add(`${table}.${col} (${f})`);
      }
    }
    expect([...missing], 'add each of these to PURGE_PLAN in src/threads/purge-plan.ts').toEqual([]);
  });

  it('gives every entry a reason and a known action, and lists no table twice', () => {
    expect(PURGE_PLAN.every((e) => e.why.length > 20)).toBe(true);
    expect(PURGE_PLAN.every((e) => ['delete', 'detach', 'keep-summary', 'keep'].includes(e.action))).toBe(
      true,
    );
    const names = PURGE_PLAN.map((e) => e.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only names tables and columns that exist', () => {
    const byName = new Map(tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
    const migrated = readdirSync(MIGRATIONS)
      .map((f) => readFileSync(`${MIGRATIONS}${f}`, 'utf8'))
      .join('\n');
    for (const e of PURGE_PLAN) {
      const name = e.table.replace(/^core\./, '');
      const cols = byName.get(name);
      expect(cols ?? migrated.includes(`core.${name}`), `${e.table} exists`).toBeTruthy();
      if (cols && e.by !== 'raw') expect(cols.has(e.column), `${e.table}.${e.column}`).toBe(true);
      for (const n of e.nulls ?? []) if (cols) expect(cols.has(n), `${e.table}.${n}`).toBe(true);
    }
  });
});
