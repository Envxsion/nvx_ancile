/**
 * ------------------------------------------------------------------
 *  Title    |  Scope resolution and checks
 *  Ref      |  docs/scopes.md · contracts/scopes.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn the notebook's and the thread's stored patches into
 *           |  one effective scope, with the level behind every field,
 *           |  and answer "may this engine, model, tool call, memory
 *           |  read or source be used here?" from it.
 *  How      |  Pure functions. Defaults, then the private-notebook
 *           |  floor, then the notebook, then the thread, which can
 *           |  only narrow: a widening thread value is clamped to the
 *           |  notebook (and listed in `clamped`); PATCH rejects it up
 *           |  front (widenedFields).
 *  Note     |  A private notebook is a floor, not a default: nothing in
 *           |  it can switch cloud engines, Claude Code or data leaving
 *           |  the machine back on. Tool presets are kept beside the
 *           |  values, not merged into them: checkToolCall tests each
 *           |  preset in force as its own narrowing layer, so the
 *           |  editor still shows what each level itself set.
 * ------------------------------------------------------------------
 */

import { posix } from 'node:path';
import type {
  AppliedToolPreset,
  EffectiveScope,
  ScopeCheck,
  ScopeField,
  ScopeLevel,
  ScopePatch,
  ScopeProvenance,
  ScopeValues,
  ToolPreset,
} from '@nvx/contracts';
import { matchAction, matchGlob } from '../permissions/glob';
import { isWithin, scheme } from '../permissions/normalize';

export const DEFAULT_SCOPE: ScopeValues = {
  engines: null,
  models_allow: null,
  models_deny: [],
  data_leaves_machine: true,
  sources: null,
  context_links: true,
  memory_read: true,
  memory_write: true,
  tools_allow: null,
  tools_deny: [],
  mcp_servers_allow: null,
  mcp_servers_deny: [],
  folders: null,
  network: true,
  tool_preset: null,
};

export const SCOPE_FIELDS = Object.keys(DEFAULT_SCOPE) as ScopeField[];

/** Engines that never leave the machine. Anything else is treated as cloud. */
export const LOCAL_ENGINES: readonly string[] = ['gateway_local'];

export const BOOLEAN_FIELDS = [
  'data_leaves_machine',
  'context_links',
  'memory_read',
  'memory_write',
  'network',
] as const satisfies readonly ScopeField[];
export const DENY_FIELDS = [
  'models_deny',
  'tools_deny',
  'mcp_servers_deny',
] as const satisfies readonly ScopeField[];
export const ALLOW_FIELDS = [
  'engines',
  'models_allow',
  'sources',
  'tools_allow',
  'mcp_servers_allow',
  'folders',
] as const satisfies readonly ScopeField[];
type AllowField = (typeof ALLOW_FIELDS)[number];

const PRIVATE_NOTE = 'Private notebook: local models only, nothing leaves this machine';

const folderOf = (p: string) => {
  const f = posix.normalize(p.replace(/\\/g, '/'));
  return f.length > 1 && f.endsWith('/') ? f.slice(0, -1) : f;
};

/** Model ids use "/" as the separator; tool actions and server names use ".". */
function covers(field: AllowField, parent: string, child: string): boolean {
  if (parent === child) return true;
  switch (field) {
    case 'folders':
      return isWithin(folderOf(child), folderOf(parent));
    case 'engines':
    case 'sources':
      return false;
    case 'models_allow':
      return matchGlob(parent, child, '/') && (!child.includes('**') || parent.includes('**'));
    default:
      return matchAction(parent, child) && (!child.includes('**') || parent.includes('**'));
  }
}

/** The entries of `child` that `parent` covers (null parent covers everything). */
function narrowList(field: AllowField, parent: string[] | null, child: string[]): string[] {
  if (parent === null) return child;
  return child.filter((c) => parent.some((p) => covers(field, p, c)));
}

/**
 * The entries both lists allow (null is "no limit"): each entry of one that
 * the other covers. Used where two scopes meet (a notebook merge, a context
 * link) and the narrower must win.
 */
export function intersectAllow(field: AllowField, a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  return [...new Set([...narrowList(field, b, a), ...narrowList(field, a, b)])];
}

/** Is every entry of `child` covered by `parent` (null parent covers all; null child is "all")? */
export function allowCovers(field: AllowField, parent: string[] | null, child: string[] | null): boolean {
  if (parent === null) return true;
  if (child === null) return false;
  return narrowList(field, parent, child).length === child.length;
}

export type { AllowField };

/**
 * The fields of a thread patch that would widen the notebook's effective
 * scope. An empty list means the patch only narrows (or repeats) it.
 */
export function widenedFields(parent: ScopeValues, patch: ScopePatch): ScopeField[] {
  const out: ScopeField[] = [];
  for (const f of BOOLEAN_FIELDS) {
    if (patch[f] === true && parent[f] === false) out.push(f);
  }
  for (const f of ALLOW_FIELDS) {
    const v = patch[f];
    if (v === undefined || v === null) continue;
    if (narrowList(f, parent[f], v).length !== v.length) out.push(f);
  }
  return out;
}

const prov = (level: ScopeLevel, note: string | null = null): ScopeProvenance => ({ level, note });

/**
 * Apply one level's patch on top of `base`. `narrowOnly` (the thread) clamps
 * anything wider than the base and reports it.
 */
function applyLevel(
  base: ScopeValues,
  provenance: Record<ScopeField, ScopeProvenance>,
  patch: ScopePatch,
  level: 'notebook' | 'thread',
  narrowOnly: boolean,
  clamped: ScopeField[],
): ScopeValues {
  const out: ScopeValues = { ...base };
  for (const f of BOOLEAN_FIELDS) {
    const v = patch[f];
    if (v === undefined || v === null) continue;
    if (narrowOnly && v && !base[f]) {
      clamped.push(f);
      continue;
    }
    out[f] = v;
    provenance[f] = prov(level);
  }
  for (const f of DENY_FIELDS) {
    const v = patch[f];
    if (!v?.length) continue;
    out[f] = [...new Set([...base[f], ...v])];
    provenance[f] = prov(level);
  }
  for (const f of ALLOW_FIELDS) {
    const v = patch[f];
    if (v === undefined || v === null) continue;
    const kept = narrowOnly ? narrowList(f, base[f], v) : v;
    if (kept.length !== v.length) clamped.push(f);
    out[f] = kept;
    provenance[f] = prov(level);
  }
  return out;
}

/** The private-notebook floor, applied to whatever a level asked for. */
function privateFloor(s: ScopeValues, provenance: Record<ScopeField, ScopeProvenance>): ScopeValues {
  const out = { ...s, data_leaves_machine: false };
  provenance.data_leaves_machine = prov('private', PRIVATE_NOTE);
  const engines = (s.engines ?? [...LOCAL_ENGINES]).filter((e) => LOCAL_ENGINES.includes(e));
  if (s.engines === null || engines.length !== s.engines.length)
    provenance.engines = prov('private', PRIVATE_NOTE);
  out.engines = engines;
  return out;
}

export interface ResolveInput {
  notebookId: string | null;
  threadId: string | null;
  private: boolean;
  notebook: ScopePatch | null;
  thread: ScopePatch | null;
  /** Every tool preset by id (built-in and your own); a chosen id not here fails closed. */
  presets?: ReadonlyMap<string, ToolPreset>;
}

/** The preset a level chose, as applied; a missing one allows no tool at all. */
function appliedPreset(
  level: 'notebook' | 'thread',
  id: string,
  presets: ReadonlyMap<string, ToolPreset> | undefined,
): AppliedToolPreset {
  const p = presets?.get(id);
  if (!p)
    return {
      level,
      id,
      name: id,
      missing: true,
      tools_allow: [],
      tools_deny: [],
      mcp_servers_allow: [],
      mcp_servers_deny: [],
      network: false,
    };
  return {
    level,
    id,
    name: p.name,
    missing: false,
    tools_allow: p.tools_allow,
    tools_deny: p.tools_deny,
    mcp_servers_allow: p.mcp_servers_allow,
    mcp_servers_deny: p.mcp_servers_deny,
    network: p.network,
  };
}

export function resolveScope(input: ResolveInput): EffectiveScope {
  const provenance = Object.fromEntries(SCOPE_FIELDS.map((f) => [f, prov('default')])) as Record<
    ScopeField,
    ScopeProvenance
  >;
  const clamped: ScopeField[] = [];
  let s: ScopeValues = { ...DEFAULT_SCOPE };
  if (input.private) s = privateFloor(s, provenance);
  if (input.notebook) s = applyLevel(s, provenance, input.notebook, 'notebook', false, clamped);
  if (input.private) s = privateFloor(s, provenance);
  if (input.thread) s = applyLevel(s, provenance, input.thread, 'thread', true, clamped);
  // Presets only narrow, so a thread's preset never widens and is never clamped.
  const toolPresets: AppliedToolPreset[] = [];
  for (const level of ['notebook', 'thread'] as const) {
    const id = input[level]?.tool_preset;
    if (!id) continue;
    toolPresets.push(appliedPreset(level, id, input.presets));
    s.tool_preset = id;
    provenance.tool_preset = prov(level);
  }
  return {
    notebook_id: input.notebookId,
    thread_id: input.threadId,
    private: input.private,
    scope: s,
    provenance,
    clamped: [...new Set(clamped)],
    tool_presets: toolPresets,
  };
}

/** For a private notebook: the patch fields that try to switch the floor off. */
export function privateConflicts(patch: ScopePatch): ScopeField[] {
  const out: ScopeField[] = [];
  if (patch.data_leaves_machine === true) out.push('data_leaves_machine');
  if (patch.engines?.some((e) => !LOCAL_ENGINES.includes(e))) out.push('engines');
  return out;
}

/* ---- checks ---------------------------------------------------------------- */

const valuesOf = (scope: EffectiveScope | ScopeValues): ScopeValues =>
  'scope' in scope ? scope.scope : scope;
const isPrivate = (scope: EffectiveScope | ScopeValues) => 'private' in scope && scope.private === true;
const OK: ScopeCheck = { ok: true };

/**
 * May this engine (and model) answer here? `local` is true when the model
 * runs on this machine or a node you control; Claude Code never is.
 */
export function checkEngineAllowed(
  scope: EffectiveScope | ScopeValues,
  call: { engine: 'gateway' | 'claude_code' | (string & {}); modelId?: string | null; local: boolean },
): ScopeCheck {
  const s = valuesOf(scope);
  const local = call.engine !== 'claude_code' && call.local;
  const engine = call.engine === 'gateway' ? (local ? 'gateway_local' : 'gateway_cloud') : call.engine;
  if (!local && isPrivate(scope))
    return {
      ok: false,
      code: 'scope.private_notebook',
      field: 'data_leaves_machine',
      reason:
        call.engine === 'claude_code'
          ? 'This notebook is private, so Claude Code is never used here'
          : 'This notebook is private, so only local models answer here',
    };
  if (!local && !s.data_leaves_machine)
    return {
      ok: false,
      code: 'scope.data_stays_local',
      field: 'data_leaves_machine',
      reason: 'Nothing may leave this machine here, so only local models answer',
    };
  if (s.engines !== null && !s.engines.includes(engine))
    return {
      ok: false,
      code: 'scope.engine_not_allowed',
      field: 'engines',
      reason: `${engineName(engine)} is not allowed here`,
    };
  const model = call.modelId ?? null;
  if (model) {
    if (s.models_deny.some((p) => matchGlob(p, model, '/')))
      return {
        ok: false,
        code: 'scope.model_not_allowed',
        field: 'models_deny',
        reason: `${model} is blocked here`,
      };
    if (s.models_allow !== null && !s.models_allow.some((p) => matchGlob(p, model, '/')))
      return {
        ok: false,
        code: 'scope.model_not_allowed',
        field: 'models_allow',
        reason: `${model} is not one of the models allowed here`,
      };
  }
  return OK;
}

function engineName(e: string): string {
  if (e === 'gateway_cloud') return 'A cloud model';
  if (e === 'gateway_local') return 'A local model';
  if (e === 'claude_code') return 'Claude Code';
  return `The ${e} engine`;
}

/** Actions that reach the network whatever their resource says. */
const NETWORK_ACTIONS = ['http.**', 'web.**', 'git.push', 'git.push_force', 'git.pull', 'github.**'];
/** Shell commands that reach the network. Deliberately broad: a false hit only asks. */
const NETWORK_SHELL =
  /(^|[\s;|&(`$])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp|invoke-webrequest|iwr|irm|invoke-restmethod)(\s|$)|\bgit\s+(push|pull|fetch|clone)\b|\b(npm|pnpm|yarn|pip|uv|cargo|gem)\s+(install|add|publish|i)\b|https?:\/\//i;

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/i;

function hostOf(resource: string): string | null {
  try {
    return new URL(resource.slice(resource.indexOf(':') + 1)).hostname;
  } catch {
    return null;
  }
}

/** Does this call reach the network, and is it beyond this machine? */
export function networkReach(action: string, resource: string): 'none' | 'loopback' | 'remote' {
  const s = scheme(resource);
  if (s === 'http') {
    const host = hostOf(resource);
    return host && LOOPBACK.test(host) ? 'loopback' : 'remote';
  }
  if (s === 'shell') return NETWORK_SHELL.test(resource.slice(6)) ? 'remote' : 'none';
  if (NETWORK_ACTIONS.some((p) => matchAction(p, action))) return 'remote';
  return 'none';
}

export interface ToolCallShape {
  action: string;
  /** The normalised resource (fs:/…, http:…, shell:…, …). */
  resource: string;
  /** The MCP server behind the call, when the action does not name it (mcp.<server>.<tool>). */
  mcpServer?: string | null;
}

const presetsOf = (scope: EffectiveScope | ScopeValues): AppliedToolPreset[] =>
  'tool_presets' in scope ? scope.tool_presets : [];

/** The MCP server behind a call: given, or named by an mcp.<server>.<tool> action. */
const serverOf = (call: ToolCallShape) =>
  call.mcpServer ?? (call.action.startsWith('mcp.') ? (call.action.split('.')[1] ?? null) : null);

/** May this call run under one tool preset? Each preset in force is its own narrowing layer. */
function checkPreset(p: AppliedToolPreset, call: ToolCallShape): ScopeCheck {
  const { action, resource } = call;
  const named = `the ${p.name} tool preset`;
  if (p.missing)
    return {
      ok: false,
      code: 'scope.tool_not_allowed',
      field: 'tool_preset',
      reason: `The tool preset chosen here (${p.id}) no longer exists, so no tool runs until another is chosen`,
    };
  if (p.tools_deny.some((g) => matchAction(g, action)))
    return {
      ok: false,
      code: 'scope.tool_not_allowed',
      field: 'tool_preset',
      reason: `${action} is blocked by ${named}`,
    };
  if (p.tools_allow !== null && !p.tools_allow.some((g) => matchAction(g, action)))
    return {
      ok: false,
      code: 'scope.tool_not_allowed',
      field: 'tool_preset',
      reason: `${action} is not in ${named}`,
    };
  const server = serverOf(call);
  if (
    server &&
    (p.mcp_servers_deny.some((g) => matchAction(g, server)) ||
      (p.mcp_servers_allow !== null && !p.mcp_servers_allow.some((g) => matchAction(g, server))))
  )
    return {
      ok: false,
      code: 'scope.mcp_server_not_allowed',
      field: 'tool_preset',
      reason: `The ${server} MCP server is not in ${named}`,
    };
  if (!p.network && networkReach(action, resource) !== 'none')
    return {
      ok: false,
      code: 'scope.network_off',
      field: 'tool_preset',
      reason: `The ${p.name} tool preset has no network`,
    };
  return OK;
}

/**
 * May this tool call run here? Checked before and after any reviewer. The
 * scope's own fields first, then every tool preset in force.
 */
export function checkToolCall(scope: EffectiveScope | ScopeValues, call: ToolCallShape): ScopeCheck {
  const s = valuesOf(scope);
  const { action, resource } = call;
  if (s.tools_deny.some((p) => matchAction(p, action)))
    return {
      ok: false,
      code: 'scope.tool_not_allowed',
      field: 'tools_deny',
      reason: `${action} is blocked here`,
    };
  if (s.tools_allow !== null && !s.tools_allow.some((p) => matchAction(p, action)))
    return {
      ok: false,
      code: 'scope.tool_not_allowed',
      field: 'tools_allow',
      reason: `${action} is not one of the tools allowed here`,
    };
  const server = serverOf(call);
  if (server) {
    if (s.mcp_servers_deny.some((p) => matchAction(p, server)))
      return {
        ok: false,
        code: 'scope.mcp_server_not_allowed',
        field: 'mcp_servers_deny',
        reason: `The ${server} MCP server is blocked here`,
      };
    if (s.mcp_servers_allow !== null && !s.mcp_servers_allow.some((p) => matchAction(p, server)))
      return {
        ok: false,
        code: 'scope.mcp_server_not_allowed',
        field: 'mcp_servers_allow',
        reason: `The ${server} MCP server is not allowed here`,
      };
  }
  if (action === 'memory.read' && !s.memory_read)
    return { ok: false, code: 'scope.memory_read_off', field: 'memory_read', reason: 'Memory is off here' };
  if ((action === 'memory.write' || action === 'memory.propose') && !s.memory_write)
    return {
      ok: false,
      code: 'scope.memory_write_off',
      field: 'memory_write',
      reason: 'Nothing may be written to memory here',
    };
  if (scheme(resource) === 'fs' && s.folders !== null) {
    const path = folderOf(resource.slice(3));
    if (!s.folders.some((f) => isWithin(path, folderOf(f))))
      return {
        ok: false,
        code: 'scope.folder_not_allowed',
        field: 'folders',
        reason: `${path} is outside the folders allowed here`,
      };
  }
  const reach = networkReach(action, resource);
  if (reach !== 'none' && !s.network)
    return { ok: false, code: 'scope.network_off', field: 'network', reason: 'The network is off here' };
  if (reach === 'remote' && !s.data_leaves_machine)
    return isPrivate(scope)
      ? {
          ok: false,
          code: 'scope.private_notebook',
          field: 'data_leaves_machine',
          reason: 'This notebook is private, so nothing it holds is sent off this machine',
        }
      : {
          ok: false,
          code: 'scope.data_stays_local',
          field: 'data_leaves_machine',
          reason: 'Nothing may leave this machine here',
        };
  for (const p of presetsOf(scope)) {
    const r = checkPreset(p, call);
    if (!r.ok) return r;
  }
  return OK;
}

/**
 * The same scope for one call a person allowed to leave a private notebook (Settings → Private
 * notebooks): only the "nothing leaves this machine" floor is lifted. Network off, denied tools
 * and tool presets still apply.
 */
export function leavingAllowed(scope: EffectiveScope): EffectiveScope {
  return { ...scope, private: false, scope: { ...scope.scope, data_leaves_machine: true } };
}

/** The sources retrieval may read: the asked-for ones within the scope, or the scope's own list. */
export function allowedSources(
  scope: EffectiveScope | ScopeValues,
  asked: string[] | undefined,
): string[] | undefined {
  const allowed = valuesOf(scope).sources;
  if (allowed === null) return asked;
  if (!asked?.length) return allowed;
  return asked.filter((id) => allowed.includes(id));
}
