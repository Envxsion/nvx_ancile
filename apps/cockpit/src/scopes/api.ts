/**
 * ------------------------------------------------------------------
 *  Title    |  Scopes: reading, changing and explaining them
 *  Ref      |  docs/scopes.md · packages/contracts/src/scopes.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What a notebook or a thread may use, in the words the
 *           |  Cockpit shows: a one-line summary, the chip in a
 *           |  thread's header, why a model is not offered, and where
 *           |  each value comes from.
 *  How      |  GET/PATCH /notebooks/:id/scope and /threads/:id/scope
 *           |  answer StoredScope (the level's own patch and the
 *           |  effective scope with provenance). checkModel() mirrors
 *           |  Core's checkEngineAllowed so the model picker can say
 *           |  no before a send is refused; Core still decides.
 *           |  GET /tool-presets lists the tool presets a level can
 *           |  choose (the built-in ones are in contracts too).
 *  Note     |  Never cached across a change: a PATCH puts its answer
 *           |  in place and marks every scope stale, since a notebook
 *           |  change moves its threads too.
 * ------------------------------------------------------------------
 */

import {
  BUILTIN_TOOL_PRESETS,
  type EffectiveScope,
  type PatchNotebookScopeRequest,
  type PatchThreadScopeRequest,
  type ScopeEngine,
  type ScopeField,
  type ScopeLevel,
  type ScopeValues,
  type StoredScope,
  type ToolPreset,
  type ToolPresetList,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { useUi } from '../state/ui';

export const SCOPE_KEYS = {
  all: ['scope'] as const,
  thread: (id: string) => ['scope', 'thread', id] as const,
  notebook: (id: string) => ['scope', 'notebook', id] as const,
};

/** What a scope is with nothing set anywhere (docs/scopes.md, Fields). */
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

export const ALL_ENGINES: ScopeEngine[] = ['gateway_cloud', 'gateway_local', 'claude_code'];

export function useThreadScope(threadId: string | null | undefined) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: SCOPE_KEYS.thread(threadId ?? ''),
    queryFn: () => api.get<StoredScope>(`/threads/${threadId}/scope`),
    enabled: !!threadId && threadId.startsWith('thr_') && !demo,
    staleTime: 30_000,
    retry: false,
  });
}

export function useNotebookScope(notebookId: string | null | undefined) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: SCOPE_KEYS.notebook(notebookId ?? ''),
    queryFn: () => api.get<StoredScope>(`/notebooks/${notebookId}/scope`),
    enabled: !!notebookId && !demo,
    staleTime: 30_000,
    retry: false,
  });
}

export async function patchThreadScope(
  threadId: string,
  patch: PatchThreadScopeRequest,
): Promise<StoredScope> {
  const r = await api.patch<StoredScope>(`/threads/${threadId}/scope`, patch);
  queryClient.setQueryData(SCOPE_KEYS.thread(threadId), r);
  void queryClient.invalidateQueries({ queryKey: SCOPE_KEYS.all });
  return r;
}

export async function patchNotebookScope(
  notebookId: string,
  patch: PatchNotebookScopeRequest,
): Promise<StoredScope> {
  const r = await api.patch<StoredScope>(`/notebooks/${notebookId}/scope`, patch);
  queryClient.setQueryData(SCOPE_KEYS.notebook(notebookId), r);
  // Its threads' effective scopes moved with it.
  void queryClient.invalidateQueries({ queryKey: SCOPE_KEYS.all });
  return r;
}

/**
 * Every tool preset: the built-in ones, then your own. In the demo, and
 * until Core answers, the built-in ones alone.
 */
export function useToolPresets() {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: ['tool-presets'] as const,
    queryFn: async () =>
      (await api.get<ToolPresetList>('/tool-presets')).presets ?? [...BUILTIN_TOOL_PRESETS],
    enabled: !demo,
    staleTime: 60_000,
    retry: false,
    placeholderData: [...BUILTIN_TOOL_PRESETS],
  });
}

/** A preset's name for the editor and the summary; an id it cannot find is shown as is. */
export function presetName(presets: readonly ToolPreset[] | undefined, id: string): string {
  return (presets ?? BUILTIN_TOOL_PRESETS).find((p) => p.id === id)?.name ?? id;
}

/* ---- Globs ---------------------------------------------------------------- */

const globCache = new Map<string, RegExp>();

/** `*` within one segment, `**` across any depth, as Core's permissions/glob.ts. */
export function globMatch(pattern: string, value: string, sep: '/' | '.' = '/'): boolean {
  const key = `${sep}${pattern}`;
  let re = globCache.get(key);
  if (!re) {
    const s = sep === '/' ? '/' : '\\.';
    const body = pattern
      .split(/(\*\*|\*)/)
      .map((part) =>
        part === '**' ? '.*' : part === '*' ? `[^${s}]*` : part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'),
      )
      .join('');
    re = new RegExp(`^${body}$`);
    globCache.set(key, re);
  }
  return re.test(value);
}

/* ---- Engines and models --------------------------------------------------- */

export type ModelKind = 'claude_code' | 'local' | 'cloud';

const ENGINE_OF: Record<ModelKind, ScopeEngine> = {
  claude_code: 'claude_code',
  local: 'gateway_local',
  cloud: 'gateway_cloud',
};

export const ENGINE_WORDS: Record<string, string> = {
  gateway_cloud: 'Cloud models',
  gateway_local: 'Local models',
  claude_code: 'Claude Code',
};

/** "this thread" or "this notebook": who set a field. */
function setBy(level: ScopeLevel | undefined): string {
  return level === 'thread' ? 'this thread' : 'this notebook';
}

/**
 * Why this model cannot answer here, in a sentence; null when it can.
 * Mirrors Core's checkEngineAllowed (scopes/resolve.ts); Core decides again.
 */
export function checkModel(
  scope: EffectiveScope | null | undefined,
  kind: ModelKind,
  modelId: string | null,
): string | null {
  if (!scope) return null;
  const s = scope.scope;
  const local = kind === 'local';
  if (!local && scope.private) return 'This notebook is private: local models only';
  if (!local && !s.data_leaves_machine)
    return `Nothing leaves this computer in ${setBy(scope.provenance.data_leaves_machine?.level)}: local models only`;
  const engine = ENGINE_OF[kind];
  if (s.engines !== null && !s.engines.includes(engine))
    return `${ENGINE_WORDS[engine]} are off for ${setBy(scope.provenance.engines?.level)}`.replace(
      'Claude Code are',
      'Claude Code is',
    );
  if (modelId) {
    if (s.models_deny.some((p) => globMatch(p, modelId)))
      return `Blocked for ${setBy(scope.provenance.models_deny?.level)}`;
    if (s.models_allow !== null && !s.models_allow.some((p) => globMatch(p, modelId)))
      return `Not one of the models allowed in ${setBy(scope.provenance.models_allow?.level)}`;
  }
  return null;
}

/* ---- Words ---------------------------------------------------------------- */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The engines a scope allows, after the private and data switches. */
export function allowedEngines(scope: EffectiveScope): ScopeEngine[] {
  const base = scope.scope.engines ?? ALL_ENGINES;
  if (scope.private || !scope.scope.data_leaves_machine) return base.filter((e) => e === 'gateway_local');
  return base;
}

/**
 * The summary first: "Local models only · no network · 3 sources". Only
 * what differs from the default is named; a default scope reads "Anything
 * NVX Ancile allows".
 */
export function scopeSummary(scope: EffectiveScope): string {
  const s = scope.scope;
  const bits: string[] = [];
  const engines = allowedEngines(scope);
  if (scope.private) bits.push('Private');
  if (engines.length === 0) bits.push('No models');
  else if (engines.length === 1 && engines[0] === 'gateway_local') bits.push('Local models only');
  else if (engines.length < ALL_ENGINES.length)
    bits.push(engines.map((e) => ENGINE_WORDS[e] ?? e).join(' and '));
  if (!s.data_leaves_machine && !scope.private) bits.push('nothing leaves this computer');
  if (!s.network) bits.push('no network');
  if (s.sources !== null) bits.push(plural(s.sources.length, 'source'));
  if (!s.memory_read) bits.push('no memory');
  else if (!s.memory_write) bits.push('memory read only');
  if (!s.context_links) bits.push('no context links');
  const presets = scope.tool_presets ?? [];
  if (presets.length) bits.push(`${presets.map((p) => p.name).join(' and ')} tools`);
  else if (s.tools_allow !== null || s.tools_deny.length) bits.push('tools limited');
  if (s.mcp_servers_allow !== null || s.mcp_servers_deny.length) bits.push('MCP servers limited');
  if (s.folders !== null) bits.push(plural(s.folders.length, 'folder'));
  if (s.models_allow !== null || s.models_deny.length) bits.push('models limited');
  if (bits.length === 0) return 'Anything NVX Ancile allows';
  const [first = '', ...rest] = bits;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' · ');
}

/** The thread header's chip, only when the scope is narrower than the default. */
export function scopeChip(scope: EffectiveScope | null | undefined): string | null {
  if (!scope) return null;
  if (scope.private) return 'Private';
  const engines = allowedEngines(scope);
  if (engines.length === 1 && engines[0] === 'gateway_local') return 'Local only';
  return scopeSummary(scope) === 'Anything NVX Ancile allows' ? null : 'Narrowed';
}

export const LEVEL_WORDS: Record<ScopeLevel, string> = {
  default: 'Default',
  private: 'Private notebook',
  notebook: 'From the notebook',
  thread: 'Set for this thread',
};

/** Where a field's value comes from, for the editor's quiet right-hand note. */
export function provenanceOf(
  scope: EffectiveScope,
  field: ScopeField,
): { label: string; note: string | null } {
  const p = scope.provenance[field];
  if (!p) return { label: LEVEL_WORDS.default, note: null };
  return { label: LEVEL_WORDS[p.level], note: p.note };
}

export const FIELD_WORDS: Record<ScopeField, string> = {
  engines: 'which engines answer',
  models_allow: 'models allowed',
  models_deny: 'models blocked',
  data_leaves_machine: 'data leaving this computer',
  sources: 'sources',
  context_links: 'context links',
  memory_read: 'reading memory',
  memory_write: 'learning into memory',
  tools_allow: 'tools allowed',
  tools_deny: 'tools blocked',
  mcp_servers_allow: 'MCP servers allowed',
  mcp_servers_deny: 'MCP servers blocked',
  folders: 'folders',
  network: 'network',
  tool_preset: 'tool preset',
};
