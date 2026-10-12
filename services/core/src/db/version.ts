/**
 * ------------------------------------------------------------------
 *  Title    |  Schema version
 *  Ref      |  ROADMAP.md track G · docs/desktop.md (Updates and your data)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Know which database this build expects, which one is on
 *           |  disk, and whether the one on disk is newer: an update
 *           |  was rolled back, or an older build was installed over a
 *           |  newer one. Migrations only ever run forwards.
 *  How      |  Core: the migration files this build carries against the
 *           |  names in core._migrations. A name in the ledger this
 *           |  build has never heard of means a newer NVX Ancile wrote
 *           |  it. Knowledge (when its Alembic folder is known): the
 *           |  revision in knowledge.alembic_version against the
 *           |  revisions in the folder, read from the files' own
 *           |  `revision = "…"` and `down_revision = "…"` lines. The
 *           |  Controller (when its migrations folder is known): its
 *           |  own ledger against its files, as for Core.
 *  Note     |  Read-only: nothing here changes the database except
 *           |  creating Core's ledger when it is missing.
 * ------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { appliedMigrations, MIGRATIONS_DIR, migrationFiles } from './migrate';

export interface KnowledgeVersion {
  /** The newest revision this build carries. */
  head: string | null;
  /** The revision on disk (null: Knowledge has never migrated). */
  current: string | null;
  /** On disk but unknown to this build: written by a newer NVX Ancile. */
  newer: boolean;
  pending: boolean;
}

/** The Controller's own ledger (controller._migrations), when its migrations folder is known. */
export interface ControllerVersion {
  pending: string[];
  newer: string[];
}

export interface SchemaState {
  /** The newest Core migration this build carries: the schema it expects. */
  expected: string;
  /** The newest Core migration applied (null on an empty database). */
  current: string | null;
  pending: string[];
  /** Applied by a newer NVX Ancile: this build does not have them. */
  newer: string[];
  /** Which NVX Ancile applied the newest of those, when it said. */
  newerBy: string | null;
  /** Core has never migrated here: there is nothing to back up. */
  empty: boolean;
  knowledge: KnowledgeVersion | null;
  controller: ControllerVersion | null;
}

/**
 * The Controller's migrations folder: the desktop app names it
 * (ANCILE_CONTROLLER_MIGRATIONS_DIR); a checkout finds it beside Core.
 */
export function controllerMigrationsDir(configured?: string): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ['../../..', '../..']) {
    const dir = join(here, up, 'services', 'controller', 'migrations');
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Null when the Controller has never migrated in this database (it may use
 * a database of its own): there is nothing of its here to back up.
 */
async function controllerState(sql: Sql, dir: string): Promise<ControllerVersion | null> {
  const [t] = await sql<{ t: string | null }[]>`select to_regclass('controller._migrations')::text as t`;
  if (!t?.t) return null;
  const files = await migrationFiles(dir);
  const applied = (await sql<{ name: string }[]>`select name from controller._migrations order by name`).map(
    (r) => r.name,
  );
  const known = new Set(files);
  const done = new Set(applied);
  return { pending: files.filter((f) => !done.has(f)), newer: applied.filter((n) => !known.has(n)) };
}

/**
 * Knowledge's Alembic folder: the desktop app names it
 * (ANCILE_KNOWLEDGE_MIGRATIONS_DIR); a checkout finds it beside Core.
 */
export function knowledgeVersionsDir(configured?: string): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db/ from source, dist/ in a build.
  for (const up of ['../../..', '../..']) {
    const dir = join(here, up, 'services', 'knowledge', 'alembic', 'versions');
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** The revisions in an Alembic versions folder, and the head they lead to. */
export async function alembicRevisions(dir: string): Promise<{ revisions: string[]; head: string | null }> {
  const revisions: string[] = [];
  const downs = new Set<string>();
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.py')).sort()) {
    const text = await readFile(join(dir, f), 'utf8');
    const rev = /^revision\s*(?::\s*[\w[\], |]+)?=\s*["']([^"']+)["']/m.exec(text)?.[1];
    if (!rev) continue;
    revisions.push(rev);
    const down = /^down_revision\s*(?::\s*[\w[\], |]+)?=\s*(.+)$/m.exec(text)?.[1] ?? '';
    for (const m of down.matchAll(/["']([^"']+)["']/g)) if (m[1]) downs.add(m[1]);
  }
  const heads = revisions.filter((r) => !downs.has(r));
  return { revisions, head: heads.length === 1 ? (heads[0] ?? null) : (heads.sort().at(-1) ?? null) };
}

async function knowledgeCurrent(sql: Sql): Promise<string | null> {
  const [t] = await sql<{ t: string | null }[]>`select to_regclass('knowledge.alembic_version')::text as t`;
  if (!t?.t) return null;
  const rows = await sql<{ version_num: string }[]>`select version_num from knowledge.alembic_version`;
  return rows[0]?.version_num ?? null;
}

export async function schemaState(
  sql: Sql,
  opts: { dir?: string; knowledgeDir?: string | null; controllerDir?: string | null } = {},
): Promise<SchemaState> {
  const known = await migrationFiles(opts.dir ?? MIGRATIONS_DIR);
  const knownSet = new Set(known);
  const applied = await appliedMigrations(sql);
  const appliedSet = new Set(applied.map((r) => r.name));
  const newerRows = applied.filter((r) => !knownSet.has(r.name));

  let knowledge: KnowledgeVersion | null = null;
  if (opts.knowledgeDir) {
    const { revisions, head } = await alembicRevisions(opts.knowledgeDir);
    const current = await knowledgeCurrent(sql);
    const newer = current !== null && !revisions.includes(current);
    knowledge = { head, current, newer, pending: !newer && head !== null && current !== head };
  }

  return {
    expected: known.at(-1) ?? '',
    current: applied.at(-1)?.name ?? null,
    pending: known.filter((f) => !appliedSet.has(f)),
    newer: newerRows.map((r) => r.name),
    newerBy: newerRows.findLast((r) => r.app_version)?.app_version ?? null,
    // Core has never migrated: nothing here belongs to anyone yet (Knowledge's rows hang off
    // Core's workspaces), even if Knowledge migrated first on a desktop's first start.
    empty: applied.length === 0,
    knowledge,
    controller: opts.controllerDir ? await controllerState(sql, opts.controllerDir) : null,
  };
}

/** Is the database on disk newer than this build in any schema it knows? */
export function isNewer(s: SchemaState): boolean {
  return s.newer.length > 0 || !!s.knowledge?.newer || (s.controller?.newer.length ?? 0) > 0;
}

/** Will starting this build change the database? */
export function needsMigration(s: SchemaState): boolean {
  return s.pending.length > 0 || !!s.knowledge?.pending || (s.controller?.pending.length ?? 0) > 0;
}
