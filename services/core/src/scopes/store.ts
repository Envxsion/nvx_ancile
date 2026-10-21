/**
 * ------------------------------------------------------------------
 *  Title    |  Scopes at rest
 *  Ref      |  docs/scopes.md · migrations/0018_scopes_auto.sql
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep each notebook's and thread's scope patch, and a
 *           |  notebook's private switch, and find a thread's notebook.
 *  How      |  core.scopes (one row per level and id) and
 *           |  core.notebooks.private in Postgres; MemoryScopeStore for
 *           |  tests and the harness. Patches are stored as given:
 *           |  nulls are dropped, so a stored patch only has fields that
 *           |  were set. Your own tool presets live in core.tool_presets
 *           |  (0025); the built-in ones are never stored.
 * ------------------------------------------------------------------
 */

import { ScopePatch, type ToolPreset, ToolPresetRules } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';

export type ScopeLevelRef = 'notebook' | 'thread';

export interface StoredPatch {
  patch: ScopePatch;
  updated_at: string | null;
}

export interface ScopeStore {
  getPatch(level: ScopeLevelRef, id: string): Promise<StoredPatch>;
  /** Merge `patch` into the stored one: a null field is removed (back to inheriting). */
  mergePatch(level: ScopeLevelRef, id: string, patch: ScopePatch): Promise<StoredPatch>;
  isPrivate(notebookId: string): Promise<boolean>;
  setPrivate(notebookId: string, value: boolean): Promise<void>;
  /** The thread's notebook; undefined when the thread does not exist. */
  threadNotebook(threadId: string): Promise<string | null | undefined>;
  notebookExists(notebookId: string): Promise<boolean>;
  /** The notebook is deleted: its own scope patch goes (its threads took what they need first). */
  forgetNotebook(notebookId: string): Promise<void>;
  /** Your own tool presets (never the built-in ones), by name. */
  listPresets(): Promise<ToolPreset[]>;
  /** Insert or replace one of your own presets. */
  putPreset(preset: ToolPreset): Promise<ToolPreset>;
  /** False when there was nothing to delete. */
  deletePreset(id: string): Promise<boolean>;
  /** How many notebooks and threads have chosen this preset. */
  presetUsage(id: string): Promise<number>;
}

/** A stored preset row read back; rules that no longer parse allow no tool (fail closed). */
export function presetFromRow(r: {
  id: string;
  name: string;
  description: string;
  rules: unknown;
  updated_at: Date | string;
}): ToolPreset {
  const rules = ToolPresetRules.safeParse(r.rules);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    builtin: false,
    updated_at: new Date(r.updated_at).toISOString(),
    ...(rules.success
      ? rules.data
      : { tools_allow: [], tools_deny: [], mcp_servers_allow: [], mcp_servers_deny: [], network: false }),
  };
}

const rulesOf = (p: ToolPreset) => ({
  tools_allow: p.tools_allow,
  tools_deny: p.tools_deny,
  mcp_servers_allow: p.mcp_servers_allow,
  mcp_servers_deny: p.mcp_servers_deny,
  network: p.network,
});

const byName = (a: ToolPreset, b: ToolPreset) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Apply a PATCH: set fields replace, null fields are dropped. */
export function mergeStored(current: ScopePatch, patch: ScopePatch): ScopePatch {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as ScopePatch;
}

/** A stored patch read back: anything no longer valid is dropped, never trusted. */
export function parsePatch(raw: unknown): ScopePatch {
  const r = ScopePatch.safeParse(raw ?? {});
  if (r.success) return r.data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    const one = ScopePatch.safeParse({ [k]: v });
    if (one.success) Object.assign(out, one.data);
  }
  return out as ScopePatch;
}

export class MemoryScopeStore implements ScopeStore {
  private readonly patches = new Map<string, StoredPatch>();
  private readonly privates = new Set<string>();
  /** threadId → notebookId (null: not in a notebook). Tests fill it. */
  readonly threads = new Map<string, string | null>();
  readonly notebooks = new Set<string>();

  async getPatch(level: ScopeLevelRef, id: string) {
    return this.patches.get(`${level}:${id}`) ?? { patch: {}, updated_at: null };
  }

  async mergePatch(level: ScopeLevelRef, id: string, patch: ScopePatch) {
    const cur = await this.getPatch(level, id);
    const next = { patch: mergeStored(cur.patch, patch), updated_at: new Date().toISOString() };
    this.patches.set(`${level}:${id}`, next);
    return next;
  }

  async isPrivate(notebookId: string) {
    return this.privates.has(notebookId);
  }

  async setPrivate(notebookId: string, value: boolean) {
    if (value) this.privates.add(notebookId);
    else this.privates.delete(notebookId);
  }

  async threadNotebook(threadId: string) {
    return this.threads.has(threadId) ? (this.threads.get(threadId) ?? null) : undefined;
  }

  async notebookExists(notebookId: string) {
    return this.notebooks.has(notebookId);
  }

  async forgetNotebook(notebookId: string) {
    this.patches.delete(`notebook:${notebookId}`);
  }

  private readonly presets = new Map<string, ToolPreset>();

  async listPresets() {
    return [...this.presets.values()].sort(byName);
  }

  async putPreset(preset: ToolPreset) {
    const stored = { ...preset, builtin: false, updated_at: new Date().toISOString() };
    this.presets.set(preset.id, stored);
    return stored;
  }

  async deletePreset(id: string) {
    return this.presets.delete(id);
  }

  async presetUsage(id: string) {
    return [...this.patches.values()].filter((p) => p.patch.tool_preset === id).length;
  }
}

export class PgScopeStore implements ScopeStore {
  constructor(private readonly sql: Sql) {}

  async getPatch(level: ScopeLevelRef, id: string): Promise<StoredPatch> {
    const [r] = await this.sql<{ patch: unknown; updated_at: Date }[]>`
      select patch, updated_at from core.scopes where level = ${level} and ref_id = ${id}`;
    return r
      ? { patch: parsePatch(r.patch), updated_at: r.updated_at.toISOString() }
      : { patch: {}, updated_at: null };
  }

  async mergePatch(level: ScopeLevelRef, id: string, patch: ScopePatch): Promise<StoredPatch> {
    return this.sql.begin(async (tx) => {
      const [cur] = await tx<{ patch: unknown }[]>`
        select patch from core.scopes where level = ${level} and ref_id = ${id} for update`;
      const next = mergeStored(parsePatch(cur?.patch), patch);
      const [r] = await tx<{ updated_at: Date }[]>`
        insert into core.scopes (level, ref_id, patch) values (${level}, ${id}, ${tx.json(pgSafe(next) as never)})
        on conflict (level, ref_id) do update set patch = excluded.patch, updated_at = now()
        returning updated_at`;
      return { patch: next, updated_at: (r?.updated_at ?? new Date()).toISOString() };
    }) as Promise<StoredPatch>;
  }

  async isPrivate(notebookId: string) {
    const [r] = await this.sql<{ private: boolean }[]>`
      select private from core.notebooks where id = ${notebookId}`;
    return r?.private === true;
  }

  async setPrivate(notebookId: string, value: boolean) {
    await this.sql`update core.notebooks set private = ${value}, updated_at = now() where id = ${notebookId}`;
  }

  async threadNotebook(threadId: string) {
    const [r] = await this.sql<{ notebook_id: string | null }[]>`
      select notebook_id from core.threads where id = ${threadId}`;
    return r ? r.notebook_id : undefined;
  }

  async notebookExists(notebookId: string) {
    const [r] = await this.sql<{ n: number }[]>`select 1 as n from core.notebooks where id = ${notebookId}`;
    return !!r;
  }

  async forgetNotebook(notebookId: string) {
    await this.sql`delete from core.scopes where level = 'notebook' and ref_id = ${notebookId}`;
  }

  async listPresets() {
    const rows = await this.sql<
      { id: string; name: string; description: string; rules: unknown; updated_at: Date }[]
    >`select id, name, description, rules, updated_at from core.tool_presets`;
    return rows.map(presetFromRow).sort(byName);
  }

  async putPreset(preset: ToolPreset) {
    const [r] = await this.sql<
      { id: string; name: string; description: string; rules: unknown; updated_at: Date }[]
    >`
      insert into core.tool_presets (id, name, description, rules)
      values (${preset.id}, ${preset.name}, ${preset.description}, ${this.sql.json(pgSafe(rulesOf(preset)) as never)})
      on conflict (id) do update set name = excluded.name, description = excluded.description,
        rules = excluded.rules, updated_at = now()
      returning id, name, description, rules, updated_at`;
    if (!r) throw new Error('tool preset insert returned nothing');
    return presetFromRow(r);
  }

  async deletePreset(id: string) {
    const rows = await this.sql`delete from core.tool_presets where id = ${id} returning id`;
    return rows.length > 0;
  }

  async presetUsage(id: string) {
    const [r] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from core.scopes where patch ? 'tool_preset' and patch->>'tool_preset' = ${id}`;
    return r?.n ?? 0;
  }
}
