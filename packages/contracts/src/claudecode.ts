/**
 * ------------------------------------------------------------------
 *  Title    |  Works with Claude Code
 *  Ref      |  docs/claude-code.md · DESIGN.md (agents and engines)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes for using the person's own installed Claude
 *           |  Code from NVX Ancile: whether it is installed and signed
 *           |  in, the sessions it has on this computer, and bringing
 *           |  those sessions in as threads that keep going.
 *  How      |  Core reads Claude Code through its official Agent SDK and
 *           |  CLI subcommands (`claude --version`, `claude auth status`),
 *           |  never its credential files. A session imported once is
 *           |  bound to its thread; syncing again adds only what is new.
 *  Note     |  Ancile never offers Claude sign-in itself: signing in is
 *           |  Claude Code's own flow, in its own window.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Where installing Claude Code got to. */
export const ClaudeCodeInstallState = z.enum(['idle', 'installing', 'installed', 'failed']);
export type ClaudeCodeInstallState = z.infer<typeof ClaudeCodeInstallState>;

/** Settings → Claude Code. */
export const ClaudeCodeSettings = z.object({
  /** Install Claude Code with Anthropic's official installer when it is missing. */
  auto_install: z.boolean().default(true),
  /** Bring every session in as a thread by itself, and keep it in step (on by default). */
  auto_import: z.boolean().default(true),
  /**
   * Folders whose sessions are never brought in: other tools' automated
   * sessions, e.g. the claude-mem plugin's observer sessions. "~" is home.
   */
  exclude_folders: z.array(z.string().min(1).max(500)).max(100).default(['~/.claude-mem', '<temp>']),
  /** Claude Code's own usage reporting to Anthropic (DISABLE_TELEMETRY when off). */
  claude_telemetry: z.boolean().default(true),
});
export type ClaudeCodeSettings = z.infer<typeof ClaudeCodeSettings>;
export const PatchClaudeCodeSettings = ClaudeCodeSettings.partial().strict();

/** GET /claude-code/status */
export const ClaudeCodeStatus = z.object({
  installed: z.boolean(),
  /** e.g. "2.1.286"; null when not installed. */
  version: z.string().nullable(),
  /** The executable Ancile runs. */
  path: z.string().nullable(),
  /** False when the installed version is older than Ancile supports. */
  version_ok: z.boolean(),
  min_version: z.string(),
  signed_in: z.boolean(),
  /** As Claude Code reports it, e.g. "claude.ai", "api_key", "bedrock". Never a secret. */
  auth_method: z.string().nullable(),
  /** e.g. "pro", "max", "team"; null when not reported. */
  plan: z.string().nullable(),
  /** Claude Code's own folders, as it reports them. */
  projects_dir: z.string().nullable(),
  config_dir: z.string().nullable(),
  install: z.object({
    state: ClaudeCodeInstallState,
    /** What went wrong, in words, when state is "failed". */
    error: z.string().nullable(),
  }),
  /**
   * Whether the installed Claude Code is Anthropic's published build (its
   * checksum against Anthropic's release manifest, and its code signature on
   * Windows and macOS). Sessions are not run through one that failed.
   */
  verification: z
    .object({
      state: z.enum(['unchecked', 'checking', 'verified', 'failed']),
      error: z.string().nullable(),
    })
    .default({ state: 'unchecked', error: null }),
  /** The Agent SDK Ancile drives sessions through: ready, or why not. */
  sdk: z.object({ ready: z.boolean(), version: z.string().nullable(), error: z.string().nullable() }),
  settings: ClaudeCodeSettings,
});
export type ClaudeCodeStatus = z.infer<typeof ClaudeCodeStatus>;

/** One Claude Code session on this computer: GET /claude-code/sessions */
export const ClaudeCodeSession = z.object({
  session_id: z.string(),
  /** Its title (custom title, summary, or first prompt), as Claude Code gives it. */
  title: z.string(),
  /** The folder it ran in. */
  cwd: z.string().nullable(),
  /** The folder's last part, for display. */
  project: z.string(),
  /** The cwd no longer exists on disk. */
  cwd_missing: z.boolean(),
  updated_at: z.string(),
  created_at: z.string().nullable(),
  git_branch: z.string().nullable(),
  /** Bytes on disk, a cheap size hint. */
  size_bytes: z.number().int().nonnegative().nullable(),
  /** The thread it was brought into, if any. */
  thread_id: z.string().nullable(),
  /** New messages since the last sync into that thread. */
  behind: z.boolean(),
  /** Written to within the last minute: probably open in a terminal right now. */
  active_elsewhere: z.boolean(),
});
export type ClaudeCodeSession = z.infer<typeof ClaudeCodeSession>;

/** POST /claude-code/sessions/import */
export const ImportClaudeCodeSessionsRequest = z
  .object({
    session_ids: z.array(z.string().min(1).max(200)).min(1).max(500),
    /**
     * Where the threads go. Absent: the notebook already bound to the
     * session's folder, else a new notebook named after the folder.
     */
    notebook_id: z.string().nullable().optional(),
  })
  .strict();
export type ImportClaudeCodeSessionsRequest = z.infer<typeof ImportClaudeCodeSessionsRequest>;

export const ImportClaudeCodeSessionsResult = z.object({
  imported: z.array(
    z.object({
      session_id: z.string(),
      thread_id: z.string(),
      /** Messages added by this import (0 when already up to date). */
      added: z.number().int().nonnegative(),
      notebook_id: z.string().nullable(),
    }),
  ),
  failed: z.array(z.object({ session_id: z.string(), title: z.string(), hint: z.string() })),
});
export type ImportClaudeCodeSessionsResult = z.infer<typeof ImportClaudeCodeSessionsResult>;

/**
 * What a thread knows about the Claude Code session behind it. Kept in
 * ThreadSettings.claude_code (see api.ts) and in each mirrored message's
 * provenance as { claude_code: { session_id, uuid } }.
 */
export const ClaudeCodeBinding = z.object({
  session_id: z.string(),
  cwd: z.string().nullable(),
  /** The last Claude Code message uuid mirrored into the thread. */
  last_uuid: z.string().nullable(),
  synced_at: z.string(),
});
export type ClaudeCodeBinding = z.infer<typeof ClaudeCodeBinding>;

/**
 * POST /claude-code/projects/exclude: "Don't bring in this folder". The
 * folder joins exclude_folders, and what already came from it is put
 * away (threads archived, never deleted). Answers ClaudeCodeSettings.
 */
export const ExcludeClaudeCodeFolderRequest = z.object({ cwd: z.string().min(1).max(500) }).strict();
export type ExcludeClaudeCodeFolderRequest = z.infer<typeof ExcludeClaudeCodeFolderRequest>;

/** A folder → notebook binding, so a project's sessions land together. */
export const ClaudeCodeProject = z.object({
  cwd: z.string(),
  notebook_id: z.string(),
});
export type ClaudeCodeProject = z.infer<typeof ClaudeCodeProject>;

/* ---- Live sessions (phase 2) ------------------------------------------------ */

/** Where a command comes from, so the composer can group and explain it. */
export const ClaudeCodeCommandSource = z.enum(['builtin', 'skill', 'plugin', 'mcp', 'custom', 'ancile']);

/**
 * One entry in the composer's "/" list for a Claude Code thread:
 * GET /claude-code/threads/:id/commands. Built from Claude Code's own
 * list for that session (built-ins, skills, plugins, MCP prompts,
 * custom commands), so new commands appear without an Ancile update.
 */
export const ClaudeCodeCommand = z.object({
  /** Without the slash, e.g. "compact", "mcp", "review", "my-skill". */
  name: z.string(),
  description: z.string(),
  /** e.g. "[instructions]" or "low|medium|high|xhigh|max". */
  argument_hint: z.string().nullable(),
  /** Known subcommands or values, for a second level of completion. */
  arguments: z.array(z.object({ value: z.string(), description: z.string().nullable() })).default([]),
  source: ClaudeCodeCommandSource,
  /**
   * "claude": sent to Claude Code as typed. "ancile": NVX Ancile does it
   * better itself (e.g. /mcp opens the MCP screen, /branch branches the
   * thread); `ancile_action` says what.
   */
  handled_by: z.enum(['claude', 'ancile']),
  ancile_action: z
    .enum([
      'open_mcp',
      'open_permissions',
      'open_usage',
      'branch',
      'rewind',
      'new_thread',
      'open_threads',
      'sign_in',
      'open_memory',
      'open_settings',
      'set_model',
      'set_effort',
      'unsupported',
    ])
    .nullable()
    .default(null),
});
export type ClaudeCodeCommand = z.infer<typeof ClaudeCodeCommand>;

/**
 * GET /claude-code/threads/:id/commands. Answers at once: until Claude
 * Code's own list has been read for that folder, `items` holds the
 * built-ins and `partial` is true; ask again shortly for the whole list.
 */
export const ClaudeCodeCommandList = z.object({
  items: z.array(ClaudeCodeCommand),
  partial: z.boolean(),
});
export type ClaudeCodeCommandList = z.infer<typeof ClaudeCodeCommandList>;

/** POST /claude-code/threads/:id/send — one turn in the live session. */
export const SendClaudeCodeRequest = z
  .object({
    text: z.string().min(1).max(200_000),
    /** The message this turn answers from; absent: the thread's active head. */
    parent_id: z.string().nullable().optional(),
    /** Source ids to ground this turn on (the notebook's sources by default). */
    source_ids: z.array(z.string()).max(50).optional(),
    model: z.string().nullable().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    /**
     * "Continue as a branch": fork the session at the parent even when the
     * parent is its latest message, so a session open in Claude Code
     * somewhere else is never written to.
     */
    as_branch: z.boolean().optional(),
    idempotency_key: z.string().min(8).max(200),
  })
  .strict();
export type SendClaudeCodeRequest = z.infer<typeof SendClaudeCodeRequest>;

/** The answer: the run that streams the turn on the thread's usual event stream. */
export const SendClaudeCodeResult = z.object({ run_id: z.string(), user_message_id: z.string() });

/** GET /claude-code/threads/:id/live */
export const ClaudeCodeLiveState = z.object({
  /** idle: no process; starting; ready; working: a turn is running. */
  state: z.enum(['idle', 'starting', 'ready', 'working']),
  /** Another Claude Code process has the session open; Ancile will not write to it. */
  locked_elsewhere: z.boolean(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permission_mode: z.string().nullable(),
  cwd: z.string().nullable(),
  /** Claude Code's own count of its context, not Ancile's estimate. */
  context: z
    .object({
      used_tokens: z.number().int(),
      max_tokens: z.number().int(),
      percent: z.number(),
      /** Where Claude Code compacts by itself, as a percent of the window; null when it will not. */
      compacts_at: z.number().nullable().optional(),
    })
    .nullable(),
});
export type ClaudeCodeLiveState = z.infer<typeof ClaudeCodeLiveState>;
