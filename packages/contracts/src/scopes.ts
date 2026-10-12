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
 *           |  reviewer work inside them and never past them. A tool
 *           |  preset (Research, Coding, Read only, or your own) is a
 *           |  named set of tool rules a level can choose; every preset
 *           |  in force narrows the tools further (docs/scopes.md).
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

/* ---- Tool presets ---------------------------------------------------------- */

/** A tool preset's id: the built-in ones (research, coding, read_only) or tp_… for your own. */
export const ToolPresetId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export type ToolPresetId = z.infer<typeof ToolPresetId>;

/**
 * What a tool preset allows. It can only narrow: an allow list of `null` is
 * "whatever the scope allows", deny lists add to the scope's, and `network`
 * false switches tool network access off.
 */
export const ToolPresetRules = z.object({
  tools_allow: z.array(Glob).max(200).nullable(),
  tools_deny: z.array(Glob).max(200),
  mcp_servers_allow: z.array(Glob).max(100).nullable(),
  mcp_servers_deny: z.array(Glob).max(100),
  network: z.boolean(),
});
export type ToolPresetRules = z.infer<typeof ToolPresetRules>;

export const ToolPreset = ToolPresetRules.extend({
  id: ToolPresetId,
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300),
  /** Built-in presets ship with NVX Ancile and cannot be changed or deleted. */
  builtin: z.boolean(),
  updated_at: z.string().nullable(),
});
export type ToolPreset = z.infer<typeof ToolPreset>;

/** GET /tool-presets: built-in presets first, then your own by name. */
export const ToolPresetList = z.object({ presets: z.array(ToolPreset) });
export type ToolPresetList = z.infer<typeof ToolPresetList>;

/** POST /tool-presets. Rules left out allow whatever the scope allows. */
export const CreateToolPresetRequest = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(''),
    tools_allow: ToolPresetRules.shape.tools_allow.default(null),
    tools_deny: ToolPresetRules.shape.tools_deny.default([]),
    mcp_servers_allow: ToolPresetRules.shape.mcp_servers_allow.default(null),
    mcp_servers_deny: ToolPresetRules.shape.mcp_servers_deny.default([]),
    network: z.boolean().default(true),
  })
  .strict();
export type CreateToolPresetRequest = z.input<typeof CreateToolPresetRequest>;

/** PATCH /tool-presets/:id: any subset. */
export const UpdateToolPresetRequest = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300),
    tools_allow: ToolPresetRules.shape.tools_allow,
    tools_deny: ToolPresetRules.shape.tools_deny,
    mcp_servers_allow: ToolPresetRules.shape.mcp_servers_allow,
    mcp_servers_deny: ToolPresetRules.shape.mcp_servers_deny,
    network: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateToolPresetRequest = z.infer<typeof UpdateToolPresetRequest>;

/**
 * A preset in force on an effective scope, with the level that chose it.
 * `missing`: the chosen preset no longer exists, so no tool may run until
 * another is chosen (it fails closed).
 */
export const AppliedToolPreset = ToolPresetRules.extend({
  level: z.enum(['notebook', 'thread']),
  id: ToolPresetId,
  name: z.string(),
  missing: z.boolean(),
});
export type AppliedToolPreset = z.infer<typeof AppliedToolPreset>;

/** Claude Code's own bookkeeping (TodoWrite, Task, …): every built-in preset allows it. */
const CLAUDE_CODE_BOOKKEEPING = 'claude_code.*';

/**
 * The presets that ship with NVX Ancile. The rules only ever narrow the scope
 * they sit in; permissions still decide every call they let through.
 */
export const BUILTIN_TOOL_PRESETS: readonly ToolPreset[] = [
  {
    id: 'research',
    name: 'Research',
    description:
      'Search the web, sources and memory, read files, and run Python in its sandbox. Nothing is written.',
    builtin: true,
    updated_at: null,
    tools_allow: [
      'web.*',
      'knowledge.*',
      'notebooks.read',
      'memory.read',
      'memory.propose',
      'fs.read',
      'fs.list',
      'flow.ask',
      'code.run',
      'mcp.**',
      CLAUDE_CODE_BOOKKEEPING,
    ],
    tools_deny: [],
    mcp_servers_allow: null,
    mcp_servers_deny: [],
    network: true,
  },
  {
    id: 'coding',
    name: 'Coding',
    description: 'Files, the shell, git and GitHub, plus search. Force pushes are never allowed.',
    builtin: true,
    updated_at: null,
    tools_allow: [
      'fs.*',
      'shell.*',
      'git.*',
      'github.*',
      'knowledge.search',
      'memory.read',
      'memory.propose',
      'web.search',
      'web.fetch',
      'code.run',
      'mcp.**',
      CLAUDE_CODE_BOOKKEEPING,
    ],
    tools_deny: ['git.push_force'],
    mcp_servers_allow: null,
    mcp_servers_deny: [],
    network: true,
  },
  {
    id: 'read_only',
    name: 'Read only',
    description:
      'Read files, git history, sources and memory. No writes, no shell, no MCP servers, no network.',
    builtin: true,
    updated_at: null,
    tools_allow: [
      'fs.read',
      'fs.list',
      'git.status',
      'git.log',
      'git.diff',
      'git.branches',
      'knowledge.search',
      'notebooks.read',
      'memory.read',
      CLAUDE_CODE_BOOKKEEPING,
    ],
    tools_deny: [],
    mcp_servers_allow: [],
    mcp_servers_deny: [],
    network: false,
  },
];

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
  /**
   * The tool preset chosen at the most specific level; null is none. Every
   * preset in force (EffectiveScope.tool_presets) applies, not just this one.
   */
  tool_preset: ToolPresetId.nullable(),
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
    /** A tool preset for this level. It only narrows, so a thread may always choose one. */
    tool_preset: ToolPresetId.nullable(),
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
  /** Every tool preset in force, notebook first; each one narrows the tools further. */
  tool_presets: z.array(AppliedToolPreset),
});
export type EffectiveScope = z.infer<typeof EffectiveScope>;

/**
 * Where answers came from when they were made off this machine: a closed set
 * of engines and providers, never a model's full id and never content.
 */
export const SharedDestination = z.enum([
  'claude_code',
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'mistral',
  'groq',
  'deepseek',
  'xai',
  'other_cloud',
]);
export type SharedDestination = z.infer<typeof SharedDestination>;

/**
 * What had already left this machine when a notebook became private, or a
 * notebook or thread became local only. Recorded once, at the change, from
 * the answers' own records (model and engine per message). It cannot be
 * recalled: it is shown so you know.
 */
export const SharedBeforeLocal = z.object({
  id: z.string(),
  level: z.enum(['notebook', 'thread']),
  ref_id: z.string(),
  /** `private`: the notebook was made private. `local_only`: data leaving the machine was switched off. */
  change: z.enum(['private', 'local_only']),
  changed_at: z.string(),
  /** Answers made by engines or models off this machine, before the change. */
  turns: z.number().int().nonnegative(),
  first_at: z.string().nullable(),
  last_at: z.string().nullable(),
  destinations: z.array(z.object({ destination: SharedDestination, turns: z.number().int().nonnegative() })),
});
export type SharedBeforeLocal = z.infer<typeof SharedBeforeLocal>;

/** GET /notebooks/:id/scope and GET /threads/:id/scope: what that level stores. */
export const StoredScope = z.object({
  level: z.enum(['notebook', 'thread']),
  id: z.string(),
  /** Notebooks only (false for threads): see EffectiveScope.private. */
  private: z.boolean(),
  patch: ScopePatch,
  effective: EffectiveScope,
  updated_at: z.string().nullable(),
  /**
   * Each time this level (or, for a thread, its notebook) stopped letting data
   * leave the machine: what had already gone. Newest first.
   */
  shared_before_local: z.array(SharedBeforeLocal).optional(),
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
  'scope.context_links_off',
]);
export type ScopeDenyCode = z.infer<typeof ScopeDenyCode>;

export type ScopeCheck = { ok: true } | { ok: false; reason: string; code: ScopeDenyCode; field: ScopeField };
