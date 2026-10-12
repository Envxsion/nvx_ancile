/**
 * ------------------------------------------------------------------
 *  Title    |  /notebooks/:id/scope and /threads/:id/scope
 *  Ref      |  docs/scopes.md · docs/api.md (Scopes)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read and change what a notebook or a thread may use,
 *           |  and show the effective scope with the level behind
 *           |  each field.
 *  How      |  A notebook PATCH may set anything, except that a private
 *           |  notebook cannot switch cloud engines or data leaving the
 *           |  machine back on. A thread PATCH may only narrow its
 *           |  notebook: a widening field is refused (scope.widen)
 *           |  rather than silently clamped, so what you saw is what
 *           |  you get. /tool-presets lists the built-in presets and
 *           |  keeps your own; a level chooses one with `tool_preset`,
 *           |  which must exist when chosen (tool_preset.not_found). A
 *           |  preset in use cannot be deleted (tool_preset.in_use).
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  BUILTIN_TOOL_PRESETS,
  CreateToolPresetRequest,
  PatchNotebookScopeRequest,
  PatchThreadScopeRequest,
  type ScopeField,
  type StoredScope,
  type ToolPreset,
  type ToolPresetList,
  UpdateToolPresetRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import { allPresets, getEffectiveScope, listPresets } from './index';
import { privateConflicts, widenedFields } from './resolve';
import type { ScopeStore } from './store';

export interface ScopeRouteDeps {
  store: ScopeStore;
  /** A scope changed: drop anything cached from the old one. */
  onChange?: (ref: { notebookId?: string; threadId?: string }) => void;
}

const FIELD_NAMES: Record<ScopeField, string> = {
  engines: 'engines',
  models_allow: 'allowed models',
  models_deny: 'blocked models',
  data_leaves_machine: 'data leaving this machine',
  sources: 'sources',
  context_links: 'context links',
  memory_read: 'reading memory',
  memory_write: 'writing memory',
  tools_allow: 'allowed tools',
  tools_deny: 'blocked tools',
  mcp_servers_allow: 'allowed MCP servers',
  mcp_servers_deny: 'blocked MCP servers',
  folders: 'folders',
  network: 'the network',
  tool_preset: 'the tool preset',
};

const isBuiltin = (id: string) => BUILTIN_TOOL_PRESETS.some((p) => p.id === id);

export function presetNotFoundError(id: string): AncileError {
  return new AncileError({
    code: 'tool_preset.not_found',
    title: 'That tool preset does not exist',
    hint: 'It may have been deleted. Choose another preset, or none.',
    status: 422,
    errorClass: 'permanent',
    context: { fields: ['tool_preset'], id },
  });
}

export function presetBuiltinError(): AncileError {
  return new AncileError({
    code: 'tool_preset.builtin',
    title: 'Built-in tool presets cannot be changed',
    hint: 'Make your own preset instead, starting from the rules you want.',
    status: 409,
    errorClass: 'permanent',
  });
}

export function presetInUseError(uses: number): AncileError {
  return new AncileError({
    code: 'tool_preset.in_use',
    title: 'This tool preset is still in use',
    hint: `${uses} ${uses === 1 ? 'notebook or thread uses' : 'notebooks and threads use'} it. Choose another preset there first, then delete it.`,
    status: 409,
    errorClass: 'permanent',
    context: { uses },
  });
}

const names = (fields: ScopeField[]) => fields.map((f) => FIELD_NAMES[f]).join(', ');

export function widenError(fields: ScopeField[]): AncileError {
  return new AncileError({
    code: 'scope.widen',
    title: 'A thread can only narrow its notebook',
    hint: `This would allow more than the notebook does (${names(fields)}). Change the notebook's scope first, or choose less.`,
    status: 422,
    errorClass: 'permanent',
    context: { fields },
  });
}

export function privateError(fields: ScopeField[]): AncileError {
  return new AncileError({
    code: 'scope.private_conflict',
    title: 'A private notebook keeps everything on this machine',
    hint: `Turn off "Private" for this notebook first if it should use ${names(fields)}.`,
    status: 422,
    errorClass: 'permanent',
    context: { fields },
  });
}

export function scopeRoutes(deps: ScopeRouteDeps) {
  const r = new Hono<AppEnv>();
  const { store } = deps;

  const notebookOut = async (id: string): Promise<StoredScope> => {
    const [stored, priv, effective] = await Promise.all([
      store.getPatch('notebook', id),
      store.isPrivate(id),
      getEffectiveScope(store, { notebookId: id }),
    ]);
    return {
      level: 'notebook',
      id,
      private: priv,
      patch: stored.patch,
      effective,
      updated_at: stored.updated_at,
    };
  };

  const threadOut = async (id: string): Promise<StoredScope> => {
    const [stored, effective] = await Promise.all([
      store.getPatch('thread', id),
      getEffectiveScope(store, { threadId: id }),
    ]);
    return {
      level: 'thread',
      id,
      private: false,
      patch: stored.patch,
      effective,
      updated_at: stored.updated_at,
    };
  };

  const needNotebook = async (id: string) => {
    if (!(await store.notebookExists(id))) throw notFound('That notebook');
  };
  const needThread = async (id: string) => {
    const nb = await store.threadNotebook(id);
    if (nb === undefined) throw notFound('That thread');
    return nb;
  };
  /** A chosen preset must exist when it is chosen; one deleted later fails closed at resolve. */
  const needPreset = async (id: string | null | undefined) => {
    if (!id || isBuiltin(id)) return;
    if (!(await allPresets(store)).has(id)) throw presetNotFoundError(id);
  };
  const needOwnPreset = async (id: string): Promise<ToolPreset> => {
    if (isBuiltin(id)) throw presetBuiltinError();
    const p = (await store.listPresets()).find((x) => x.id === id);
    if (!p) throw notFound('That tool preset');
    return p;
  };

  r.get('/tool-presets', async (c) => {
    const out: ToolPresetList = { presets: await listPresets(store) };
    return c.json(out);
  });

  r.post('/tool-presets', async (c) => {
    const req = await body(c, CreateToolPresetRequest);
    const created = await store.putPreset({
      ...req,
      id: `tp_${ulid().toLowerCase()}`,
      builtin: false,
      updated_at: null,
    });
    deps.onChange?.({});
    return c.json(created, 201);
  });

  r.patch('/tool-presets/:id', async (c) => {
    const id = c.req.param('id');
    const patch = await body(c, UpdateToolPresetRequest);
    const cur = await needOwnPreset(id);
    const next = await store.putPreset({ ...cur, ...patch });
    deps.onChange?.({});
    return c.json(next);
  });

  r.delete('/tool-presets/:id', async (c) => {
    const id = c.req.param('id');
    await needOwnPreset(id);
    const uses = await store.presetUsage(id);
    if (uses > 0) throw presetInUseError(uses);
    await store.deletePreset(id);
    deps.onChange?.({});
    return c.body(null, 204);
  });

  r.get('/notebooks/:id/scope', async (c) => {
    const id = c.req.param('id');
    await needNotebook(id);
    return c.json(await notebookOut(id));
  });

  r.patch('/notebooks/:id/scope', async (c) => {
    const id = c.req.param('id');
    await needNotebook(id);
    const { private: priv, ...patch } = await body(c, PatchNotebookScopeRequest);
    await needPreset(patch.tool_preset);
    const willBePrivate = priv ?? (await store.isPrivate(id));
    if (willBePrivate) {
      const conflicts = privateConflicts(patch);
      if (conflicts.length) throw privateError(conflicts);
    }
    if (priv !== undefined) await store.setPrivate(id, priv);
    if (Object.keys(patch).length) await store.mergePatch('notebook', id, patch);
    deps.onChange?.({ notebookId: id });
    return c.json(await notebookOut(id));
  });

  r.get('/threads/:id/scope', async (c) => {
    const id = c.req.param('id');
    await needThread(id);
    return c.json(await threadOut(id));
  });

  r.get('/threads/:id/scope/effective', async (c) => {
    const id = c.req.param('id');
    await needThread(id);
    return c.json(await getEffectiveScope(store, { threadId: id }));
  });

  r.patch('/threads/:id/scope', async (c) => {
    const id = c.req.param('id');
    const notebookId = await needThread(id);
    const patch = await body(c, PatchThreadScopeRequest);
    // A preset only narrows, so a thread may always choose one; it must exist.
    await needPreset(patch.tool_preset);
    // Narrowing is checked against the notebook alone, so the thread's own
    // earlier choices never block widening back up to the notebook.
    const parent = await getEffectiveScope(store, { notebookId });
    const wider = widenedFields(parent.scope, patch);
    if (wider.length) throw widenError(wider);
    await store.mergePatch('thread', id, patch);
    deps.onChange?.({ threadId: id });
    return c.json(await threadOut(id));
  });

  return r;
}
