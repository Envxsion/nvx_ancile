/**
 * ------------------------------------------------------------------
 *  Title    |  Scopes: the module's front door
 *  Ref      |  docs/scopes.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the rest of Core imports: the effective scope for a
 *           |  notebook or thread, and the checks against it (engine
 *           |  and model, tool call, sources).
 *  How      |  getEffectiveScope reads both levels from a ScopeStore (or
 *           |  a postgres Sql, wrapped in PgScopeStore) and resolves
 *           |  them with resolve.ts. A thread's notebook is read from
 *           |  the thread when it is not given.
 *  Note     |  Engine selection (engines/) and the permission gate call
 *           |  these at execution time, never from a cached answer. That
 *           |  includes tool presets: a preset edited or deleted applies
 *           |  to the very next call.
 * ------------------------------------------------------------------
 */

import { BUILTIN_TOOL_PRESETS, type EffectiveScope, type ToolPreset } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { resolveScope } from './resolve';
import { PgScopeStore, type ScopeStore } from './store';

export { checkLinkRead, keepsLocal, type MergedScope, type MergeSide, mergeScopes } from './combine';
export {
  allowedSources,
  checkEngineAllowed,
  checkToolCall,
  DEFAULT_SCOPE,
  networkReach,
  resolveScope,
  type ToolCallShape,
  widenedFields,
} from './resolve';
export { MemoryScopeStore, PgScopeStore, type ScopeStore } from './store';

export interface ScopeRef {
  notebookId?: string | null;
  threadId?: string | null;
}

const stores = new WeakMap<object, ScopeStore>();

function asStore(db: ScopeStore | Sql): ScopeStore {
  if (typeof db !== 'function') return db;
  let s = stores.get(db);
  if (!s) {
    s = new PgScopeStore(db);
    stores.set(db, s);
  }
  return s;
}

/**
 * The scope in force for a thread (inside its notebook) or a notebook. With
 * neither, the defaults. A thread's notebook comes from the thread itself
 * when not given, so a caller cannot dodge the notebook by leaving it out.
 */
export async function getEffectiveScope(db: ScopeStore | Sql, ref: ScopeRef): Promise<EffectiveScope> {
  const store = asStore(db);
  const threadId = ref.threadId ?? null;
  let notebookId = ref.notebookId ?? null;
  if (threadId) {
    const nb = await store.threadNotebook(threadId);
    if (nb) notebookId = nb;
  }
  const [priv, notebook, thread] = await Promise.all([
    notebookId ? store.isPrivate(notebookId) : Promise.resolve(false),
    notebookId ? store.getPatch('notebook', notebookId) : Promise.resolve(null),
    threadId ? store.getPatch('thread', threadId) : Promise.resolve(null),
  ]);
  // Your own presets are only read when a level has chosen one that is not built in.
  const chosen = [notebook?.patch.tool_preset, thread?.patch.tool_preset].filter((id): id is string => !!id);
  const presets = await allPresets(
    store,
    chosen.some((id) => !BUILTIN.has(id)),
  );
  return resolveScope({
    notebookId,
    threadId,
    private: priv,
    notebook: notebook?.patch ?? null,
    thread: thread?.patch ?? null,
    presets,
  });
}

const BUILTIN: ReadonlyMap<string, ToolPreset> = new Map(BUILTIN_TOOL_PRESETS.map((p) => [p.id, p]));

/** Every tool preset by id: the built-in ones, then (when asked) your own. */
export async function allPresets(store: ScopeStore, own = true): Promise<ReadonlyMap<string, ToolPreset>> {
  if (!own) return BUILTIN;
  const out = new Map(BUILTIN);
  for (const p of await store.listPresets()) if (!out.has(p.id)) out.set(p.id, p);
  return out;
}

/** GET /tool-presets: built-in presets first, then your own by name. */
export async function listPresets(store: ScopeStore): Promise<ToolPreset[]> {
  return [...BUILTIN_TOOL_PRESETS, ...(await store.listPresets()).filter((p) => !BUILTIN.has(p.id))];
}

/** What the gate and the conductor are given: a resolver bound to a store. */
export interface ScopeResolver {
  effective(ref: ScopeRef): Promise<EffectiveScope>;
}

export const scopeResolver = (db: ScopeStore | Sql): ScopeResolver => ({
  effective: (ref) => getEffectiveScope(db, ref),
});
