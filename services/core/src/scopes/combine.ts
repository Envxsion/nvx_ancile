/**
 * ------------------------------------------------------------------
 *  Title    |  Where two scopes meet: merge and context links
 *  Ref      |  docs/scopes.md · docs/notebooks.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Two answers. When notebook B is merged into A, what
 *           |  scope does the merged notebook get? The narrower value
 *           |  of every field, and private wins. And may a thread (or
 *           |  notebook) read across a context link? Only if the read
 *           |  passes the reading side's scope and the linked side's.
 *  How      |  Pure functions over effective scopes. Booleans: both
 *           |  must allow. Deny lists: both apply. Allow lists: only
 *           |  what both allow (null is no limit). Sources are the one
 *           |  exception, because each list names that notebook's own
 *           |  sources: the merged list keeps each notebook's limit on
 *           |  its own sources (null stays null only when both are).
 *  Note     |  A link from a local-only place into a place whose
 *           |  answers may go to cloud models is refused, whichever
 *           |  model happens to answer: a fallback could be a cloud one.
 * ------------------------------------------------------------------
 */

import type {
  EffectiveScope,
  MergeScopeChange,
  ScopeCheck,
  ScopeField,
  ScopePatch,
  ScopeValues,
  ToolPreset,
} from '@nvx/contracts';
import {
  ALLOW_FIELDS,
  type AllowField,
  allowCovers,
  BOOLEAN_FIELDS,
  checkEngineAllowed,
  DEFAULT_SCOPE,
  DENY_FIELDS,
  intersectAllow,
  LOCAL_ENGINES,
  SCOPE_FIELDS,
} from './resolve';

const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = [...a].sort();
    const y = [...b].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return a === b;
};

const FIELD_WORDS: Record<ScopeField, string> = {
  engines: 'Engines',
  models_allow: 'Models allowed',
  models_deny: 'Models blocked',
  data_leaves_machine: 'Data leaving this machine',
  sources: 'Sources',
  context_links: 'Context links',
  memory_read: 'Reading memory',
  memory_write: 'Learning into memory',
  tools_allow: 'Tools allowed',
  tools_deny: 'Tools blocked',
  mcp_servers_allow: 'MCP servers allowed',
  mcp_servers_deny: 'MCP servers blocked',
  folders: 'Folders',
  network: 'Network for tools',
  tool_preset: 'Tool preset',
};

function noteFor(field: ScopeField): string {
  const name = FIELD_WORDS[field];
  if ((BOOLEAN_FIELDS as readonly string[]).includes(field))
    return `${name}: on only if both notebooks allow it`;
  if ((DENY_FIELDS as readonly string[]).includes(field)) return `${name}: everything either notebook blocks`;
  if (field === 'sources') return `${name}: each notebook keeps its own limit on its own sources`;
  if (field === 'tool_preset') return `${name}: both presets keep applying`;
  return `${name}: only what both notebooks allow`;
}

export interface MergeSide {
  scope: EffectiveScope;
  /** Every source id the notebook holds (after deduplication, in the merged notebook's ids). */
  sourceIds: string[];
}

export interface MergedScope {
  private: boolean;
  values: ScopeValues;
  /** What the merged notebook stores: every field that is not the default. */
  patch: ScopePatch;
  changes: MergeScopeChange[];
  toolPresets: { into: string | null; from: string | null; merged: string | null; folded: boolean };
}

/** Fold a tool preset's rules into scope values as one more narrowing layer. */
function foldPreset(v: ScopeValues, p: ToolPreset): ScopeValues {
  return {
    ...v,
    tools_allow: intersectAllow('tools_allow', v.tools_allow, p.tools_allow),
    tools_deny: [...new Set([...v.tools_deny, ...p.tools_deny])],
    mcp_servers_allow: intersectAllow('mcp_servers_allow', v.mcp_servers_allow, p.mcp_servers_allow),
    mcp_servers_deny: [...new Set([...v.mcp_servers_deny, ...p.mcp_servers_deny])],
    network: v.network && p.network,
  };
}

/**
 * The scope of notebook `into` after `from` is merged into it: the narrower
 * of the two for every field, never wider than either. Private wins.
 */
export function mergeScopes(
  into: MergeSide,
  from: MergeSide,
  presets: ReadonlyMap<string, ToolPreset>,
): MergedScope {
  const a = into.scope.scope;
  const b = from.scope.scope;
  const priv = into.scope.private || from.scope.private;
  const out: ScopeValues = { ...DEFAULT_SCOPE };
  for (const f of BOOLEAN_FIELDS) out[f] = a[f] && b[f];
  for (const f of DENY_FIELDS) out[f] = [...new Set([...a[f], ...b[f]])];
  for (const f of ALLOW_FIELDS) {
    if (f === 'sources') continue;
    out[f] = intersectAllow(f, a[f], b[f]);
  }
  out.sources =
    a.sources === null && b.sources === null
      ? null
      : [...new Set([...(a.sources ?? into.sourceIds), ...(b.sources ?? from.sourceIds)])];
  if (priv) {
    out.data_leaves_machine = false;
    out.engines = (out.engines ?? [...LOCAL_ENGINES]).filter((e) => LOCAL_ENGINES.includes(e));
  }
  // Tool presets: one is kept as the notebook's preset; a second, different one is folded in.
  const pa = a.tool_preset;
  const pb = b.tool_preset;
  let folded = false;
  out.tool_preset = pa ?? pb;
  if (pa && pb && pa !== pb) {
    const other = presets.get(pb);
    // A preset that no longer exists allows no tool at all (fails closed), so folding it does too.
    Object.assign(
      out,
      foldPreset(
        out,
        other ?? {
          id: pb,
          name: pb,
          description: '',
          builtin: false,
          updated_at: null,
          tools_allow: [],
          tools_deny: [],
          mcp_servers_allow: [],
          mcp_servers_deny: [],
          network: false,
        },
      ),
    );
    folded = true;
  }
  const changes: MergeScopeChange[] = [];
  for (const f of SCOPE_FIELDS) {
    const narrowsInto = !same(out[f], a[f]);
    const narrowsFrom = !same(out[f], b[f]);
    if (same(a[f], b[f]) && !narrowsInto) continue;
    changes.push({
      field: f,
      into: a[f],
      from: b[f],
      merged: out[f],
      // Sources only grow by the other notebook's own sources: never a wider read of either.
      narrows_into: f === 'sources' ? false : narrowsInto,
      narrows_from: f === 'sources' ? false : narrowsFrom,
      note: noteFor(f),
    });
  }
  const patch: Record<string, unknown> = {};
  for (const f of SCOPE_FIELDS) if (!same(out[f], DEFAULT_SCOPE[f])) patch[f] = out[f];
  return {
    private: priv,
    values: out,
    patch: patch as ScopePatch,
    changes,
    toolPresets: { into: pa, from: pb, merged: out.tool_preset, folded },
  };
}

/** Nothing here may leave this machine: a private notebook, or data leaving switched off. */
export const keepsLocal = (s: EffectiveScope): boolean => s.private || !s.scope.data_leaves_machine;

/**
 * May `reader` (the thread or notebook drawing on a link) read what the
 * linked side holds? Both scopes, as they are now. `call`, when known, is
 * the engine about to read it (Claude Code through its search tool).
 */
export function checkLinkRead(
  reader: EffectiveScope,
  linked: EffectiveScope,
  name: string,
  call?: { engine: 'gateway' | 'claude_code' | (string & {}); local: boolean; modelId?: string | null },
): ScopeCheck {
  if (!reader.scope.context_links)
    return {
      ok: false,
      code: 'scope.context_links_off',
      field: 'context_links',
      reason: 'Context links are switched off here',
    };
  if (
    keepsLocal(linked) &&
    (reader.scope.data_leaves_machine || (call && (!call.local || call.engine === 'claude_code')))
  )
    return linked.private
      ? {
          ok: false,
          code: 'scope.private_notebook',
          field: 'data_leaves_machine',
          reason: `${name} is private, so it can only be read where nothing leaves this machine`,
        }
      : {
          ok: false,
          code: 'scope.data_stays_local',
          field: 'data_leaves_machine',
          reason: `${name} keeps its data on this machine, so it can only be read where nothing leaves it either`,
        };
  if (call) {
    const ok = checkEngineAllowed(linked, call);
    if (!ok.ok) return { ...ok, reason: `${name}: ${ok.reason}` };
  }
  const l = linked.scope;
  const r = reader.scope;
  // A reader that keeps everything here only ever uses local engines, whatever its list says.
  const readerEngines = keepsLocal(reader)
    ? (r.engines ?? [...LOCAL_ENGINES]).filter((e) => LOCAL_ENGINES.includes(e))
    : r.engines;
  if (!allowCovers('engines' as AllowField, l.engines, readerEngines))
    return {
      ok: false,
      code: 'scope.engine_not_allowed',
      field: 'engines',
      reason: `${name} allows fewer engines than this place does`,
    };
  if (!allowCovers('models_allow' as AllowField, l.models_allow, r.models_allow))
    return {
      ok: false,
      code: 'scope.model_not_allowed',
      field: 'models_allow',
      reason: `${name} allows fewer models than this place does`,
    };
  if (l.models_deny.some((m) => !r.models_deny.includes(m)))
    return {
      ok: false,
      code: 'scope.model_not_allowed',
      field: 'models_deny',
      reason: `${name} blocks models this place allows`,
    };
  return { ok: true };
}
