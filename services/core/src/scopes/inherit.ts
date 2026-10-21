/**
 * ------------------------------------------------------------------
 *  Title    |  Scopes a thread keeps when its notebook goes
 *  Ref      |  docs/scopes.md · docs/notebooks.md (Deleting a notebook)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A thread takes its privacy from its notebook. When the
 *           |  notebook is deleted the thread leaves it, so what the
 *           |  notebook limited must move onto the thread first, or a
 *           |  thread from a private notebook would quietly start
 *           |  reaching cloud models, the web and Claude Code.
 *  How      |  inheritedPatch is pure: the notebook's private switch
 *           |  and scope patch laid over the thread's own patch, the
 *           |  stricter value of every field winning. A thread can only
 *           |  narrow, so the result never widens anything.
 *           |  inheritIntoThreads does it inside the caller's
 *           |  transaction for every thread of the notebook (live,
 *           |  archived and in the Trash); inheritInStore does the same
 *           |  over a ScopeStore (tests and the harness).
 *  Note     |  "Private" itself is a switch on the notebook, so on a
 *           |  thread it becomes what it means: data stays on this
 *           |  machine and only local engines answer. Call this before
 *           |  the threads are detached and before the notebook's own
 *           |  scope row is deleted.
 * ------------------------------------------------------------------
 */

import { BUILTIN_TOOL_PRESETS, type ScopeField, type ScopePatch, type ToolPreset } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';
import { ALLOW_FIELDS, BOOLEAN_FIELDS, DENY_FIELDS, intersectAllow, LOCAL_ENGINES } from './resolve';
import { parsePatch, presetFromRow, type ScopeStore } from './store';

export interface InheritInput {
  /** The notebook's private switch. */
  private: boolean;
  /** The notebook's own scope patch. */
  notebook: ScopePatch;
  /** What the thread already set for itself. */
  thread: ScopePatch;
}

const BUILTIN: ReadonlyMap<string, ToolPreset> = new Map(BUILTIN_TOOL_PRESETS.map((p) => [p.id, p]));

/** A tool preset that no longer exists allows no tool at all (the same fail-closed rule as resolve.ts). */
const closed = (id: string): ToolPreset => ({
  id,
  name: id,
  description: '',
  builtin: false,
  updated_at: null,
  tools_allow: [],
  tools_deny: [],
  mcp_servers_allow: [],
  mcp_servers_deny: [],
  network: false,
});

/**
 * The patch a thread should hold once its notebook is gone: its own settings, narrowed by
 * everything the notebook limited. Fields the notebook left alone are not copied.
 */
export function inheritedPatch(
  input: InheritInput,
  presets: ReadonlyMap<string, ToolPreset> = BUILTIN,
): ScopePatch {
  const nb: ScopePatch = { ...input.notebook };
  if (input.private) {
    nb.data_leaves_machine = false;
    nb.engines = (nb.engines ?? [...LOCAL_ENGINES]).filter((e) => LOCAL_ENGINES.includes(e));
  }
  const out: Record<string, unknown> = { ...input.thread };
  // Booleans: only "off" is a limit, and off wins.
  for (const f of BOOLEAN_FIELDS) if (nb[f] === false) out[f] = false;
  // Deny lists: everything either side blocks.
  for (const f of DENY_FIELDS) {
    const theirs = nb[f];
    if (!theirs?.length) continue;
    out[f] = [...new Set([...(input.thread[f] ?? []), ...theirs])];
  }
  // Allow lists: only what both allow (null is no limit).
  for (const f of ALLOW_FIELDS) {
    const theirs = nb[f];
    if (theirs === undefined || theirs === null) continue;
    const own = input.thread[f];
    out[f] = own === undefined || own === null ? [...theirs] : intersectAllow(f, own, theirs);
  }
  // A tool preset only narrows, and a thread holds one: its own stays, the notebook's rules fold in.
  const nbPreset = nb.tool_preset;
  if (nbPreset) {
    const own = input.thread.tool_preset;
    if (!own) out.tool_preset = nbPreset;
    else if (own !== nbPreset) {
      const p = presets.get(nbPreset) ?? closed(nbPreset);
      out.tools_allow = intersectAllow(
        'tools_allow',
        (out.tools_allow as string[] | null | undefined) ?? null,
        p.tools_allow,
      );
      out.tools_deny = [...new Set([...((out.tools_deny as string[] | undefined) ?? []), ...p.tools_deny])];
      out.mcp_servers_allow = intersectAllow(
        'mcp_servers_allow',
        (out.mcp_servers_allow as string[] | null | undefined) ?? null,
        p.mcp_servers_allow,
      );
      out.mcp_servers_deny = [
        ...new Set([...((out.mcp_servers_deny as string[] | undefined) ?? []), ...p.mcp_servers_deny]),
      ];
      if (!p.network) out.network = false;
    }
  }
  // Null means "inherit" in a stored patch; a field that resolved to nothing is not stored.
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out as ScopePatch;
}

/** Does the notebook limit anything a thread would otherwise lose? */
export const limitsAnything = (priv: boolean, patch: ScopePatch): boolean =>
  priv || Object.values(patch).some((v) => v !== undefined && v !== null);

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changed(next: ScopePatch, was: ScopePatch): boolean {
  const keys = new Set([...Object.keys(next), ...Object.keys(was)]) as Set<ScopeField>;
  for (const k of keys) if (!sameJson(next[k], was[k])) return true;
  return false;
}

/**
 * Inside the caller's transaction: copy the notebook's limits onto every thread that is in it
 * (live, archived and in the Trash). Returns how many threads were written.
 */
export async function inheritIntoThreads(tx: Sql, notebookId: string): Promise<number> {
  const [nb] = await tx<{ private: boolean }[]>`select private from core.notebooks where id = ${notebookId}`;
  const [np] = await tx<{ patch: unknown }[]>`
    select patch from core.scopes where level = 'notebook' and ref_id = ${notebookId}`;
  const notebook = parsePatch(np?.patch);
  const priv = nb?.private === true;
  if (!limitsAnything(priv, notebook)) return 0;
  const threads = await tx<{ id: string; patch: unknown }[]>`
    select t.id, s.patch from core.threads t
    left join core.scopes s on s.level = 'thread' and s.ref_id = t.id
    where t.notebook_id = ${notebookId}`;
  let presets: ReadonlyMap<string, ToolPreset> = BUILTIN;
  if (notebook.tool_preset && !BUILTIN.has(notebook.tool_preset)) {
    const rows = await tx<
      { id: string; name: string; description: string; rules: unknown; updated_at: Date }[]
    >`select id, name, description, rules, updated_at from core.tool_presets`;
    presets = new Map([...BUILTIN, ...rows.map((r) => [r.id, presetFromRow(r)] as const)]);
  }
  let written = 0;
  for (const t of threads) {
    const own = parsePatch(t.patch);
    const next = inheritedPatch({ private: priv, notebook, thread: own }, presets);
    if (!changed(next, own)) continue;
    await tx`
      insert into core.scopes (level, ref_id, patch) values ('thread', ${t.id}, ${tx.json(pgSafe(next) as never)})
      on conflict (level, ref_id) do update set patch = excluded.patch, updated_at = now()`;
    written++;
  }
  return written;
}

/** The same over a ScopeStore, for the threads given (tests, the harness). */
export async function inheritInStore(
  store: ScopeStore,
  notebookId: string,
  threadIds: string[],
): Promise<number> {
  const priv = await store.isPrivate(notebookId);
  const notebook = (await store.getPatch('notebook', notebookId)).patch;
  if (!limitsAnything(priv, notebook)) return 0;
  const presets = new Map([...BUILTIN, ...(await store.listPresets()).map((p) => [p.id, p] as const)]);
  let written = 0;
  for (const id of threadIds) {
    const own = (await store.getPatch('thread', id)).patch;
    const next = inheritedPatch({ private: priv, notebook, thread: own }, presets);
    if (!changed(next, own)) continue;
    await store.mergePatch('thread', id, next);
    written++;
  }
  return written;
}
