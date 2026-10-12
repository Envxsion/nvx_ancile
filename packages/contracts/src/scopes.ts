/**
 * ------------------------------------------------------------------
 *  Title    |  Scopes: what a notebook or a thread may use
 *  Ref      |  docs/scopes.md · DESIGN.md §5 (permissions)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  One set of limits per notebook and per thread: which
 *           |  engines and models may answer, whether anything may
 *           |  leave this machine, which sources, memory, tools, MCP
 *           |  servers and folders are in reach, and the network.
 *  How      |  Each level stores a partial patch. The effective scope
 *           |  is defaults, then the notebook, then the thread, where
 *           |  the thread can only narrow. Every field says which level
 *           |  set it, so the Cockpit can explain a refusal.
 *  Note     |  Scopes are floors. Permissions, presets and Auto mode's
 *           |  reviewer work inside them and never past them.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/**
 * An engine a scope can allow. The three built-in ones, or another engine's
 * id (a future CLI) in the same lowercase shape.
 */
export const ScopeEngine = z.union([
  z.enum(['gateway_cloud', 'gateway_local', 'claude_code']),
  z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
]);
export type ScopeEngine = z.infer<typeof ScopeEngine>;

/** A glob over model ids, tool actions or MCP server names (`*` and `**`). */
const Glob = z.string().trim().min(1).max(300);
/** An absolute folder, posix style. */
const Folder = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((p) => p.replace(/\\/g, '/').startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), {
    message: 'must be an absolute path',
  });

/**
 * Every field of a scope, fully resolved. Lists that are `null` mean "no
 * limit"; deny lists add up across levels; booleans are "allowed".
 */
export const ScopeValues = z.object({
  /** Engines that may answer here; null is any. */
  engines: z.array(ScopeEngine).nullable(),
  /** Model ids (globs) that may answer; null is any. */
  models_allow: z.array(Glob).nullable(),
  /** Model ids (globs) that never answer here. */
  models_deny: z.array(Glob),
  /** False: only local models, local reviewers and local tools; nothing goes to the cloud. */
  data_leaves_machine: z.boolean(),
  /** Source ids retrieval may read; null is every source in the notebook. */
  sources: z.array(z.string().min(1).max(100)).nullable(),
  /** May context links from other threads and notebooks be pulled in? */
  context_links: z.boolean(),
  memory_read: z.boolean(),
  memory_write: z.boolean(),
  /** Tool actions (globs, e.g. "fs.*") that may run; null is any. */
  tools_allow: z.array(Glob).nullable(),
  tools_deny: z.array(Glob),
  /** MCP server names that may be called; null is any. */
  mcp_servers_allow: z.array(Glob).nullable(),
  mcp_servers_deny: z.array(Glob),
  /** Folders tools may touch; null is the workspace as permissions allow. */
  folders: z.array(Folder).nullable(),
  /** May tools reach the network at all? */
  network: z.boolean(),
});
export type ScopeValues = z.infer<typeof ScopeValues>;

export const ScopeField = ScopeValues.keyof();
export type ScopeField = z.infer<typeof ScopeField>;

/**
 * What a level stores, and what PATCH takes: any subset of the fields. A
 * field sent as `null` goes back to inheriting from the level above; an
 * empty list is a real value ("none").
 */
export const ScopePatch = z
  .object({
    engines: z.array(ScopeEngine).max(20).nullable(),
    models_allow: z.array(Glob).max(100).nullable(),
    models_deny: z.array(Glob).max(100).nullable(),
    data_leaves_machine: z.boolean().nullable(),
    sources: z.array(z.string().min(1).max(100)).max(500).nullable(),
    context_links: z.boolean().nullable(),
    memory_read: z.boolean().nullable(),
    memory_write: z.boolean().nullable(),
    tools_allow: z.array(Glob).max(200).nullable(),
    tools_deny: z.array(Glob).max(200).nullable(),
    mcp_servers_allow: z.array(Glob).max(100).nullable(),
    mcp_servers_deny: z.array(Glob).max(100).nullable(),
    folders: z.array(Folder).max(50).nullable(),
    network: z.boolean().nullable(),
  })
  .partial()
  .strict();
export type ScopePatch = z.infer<typeof ScopePatch>;

/** Where a field's effective value came from. */
export const ScopeLevel = z.enum(['default', 'private', 'notebook', 'thread']);
export type ScopeLevel = z.infer<typeof ScopeLevel>;

export const ScopeProvenance = z.object({
  level: ScopeLevel,
  /** A sentence for the Cockpit ("Private notebook: nothing leaves this machine"). */
  note: z.string().nullable(),
});
export type ScopeProvenance = z.infer<typeof ScopeProvenance>;

export const EffectiveScope = z.object({
  notebook_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  /** The notebook is private: local only, nothing leaves this machine, never Claude Code. */
  private: z.boolean(),
  scope: ScopeValues,
  provenance: z.record(ScopeField, ScopeProvenance),
  /**
   * Thread fields that asked for more than the notebook allows (the notebook
   * was narrowed after the thread was set). They are clamped to the notebook.
   */
  clamped: z.array(ScopeField),
});
export type EffectiveScope = z.infer<typeof EffectiveScope>;

/** GET /notebooks/:id/scope and GET /threads/:id/scope: what that level stores. */
export const StoredScope = z.object({
  level: z.enum(['notebook', 'thread']),
  id: z.string(),
  /** Notebooks only (false for threads): see EffectiveScope.private. */
  private: z.boolean(),
  patch: ScopePatch,
  effective: EffectiveScope,
  updated_at: z.string().nullable(),
});
export type StoredScope = z.infer<typeof StoredScope>;

/** PATCH /notebooks/:id/scope: a patch, plus the notebook's private switch. */
export const PatchNotebookScopeRequest = ScopePatch.extend({ private: z.boolean().optional() }).strict();
export type PatchNotebookScopeRequest = z.infer<typeof PatchNotebookScopeRequest>;

/** PATCH /threads/:id/scope: may only narrow what the notebook allows. */
export const PatchThreadScopeRequest = ScopePatch;
export type PatchThreadScopeRequest = z.infer<typeof PatchThreadScopeRequest>;

/** Why a scope said no: one closed set, documented in docs/errors.md. */
export const ScopeDenyCode = z.enum([
  'scope.engine_not_allowed',
  'scope.model_not_allowed',
  'scope.data_stays_local',
  'scope.private_notebook',
  'scope.tool_not_allowed',
  'scope.mcp_server_not_allowed',
  'scope.folder_not_allowed',
  'scope.network_off',
  'scope.memory_read_off',
  'scope.memory_write_off',
  'scope.source_not_allowed',
]);
export type ScopeDenyCode = z.infer<typeof ScopeDenyCode>;

export type ScopeCheck = { ok: true } | { ok: false; reason: string; code: ScopeDenyCode; field: ScopeField };
