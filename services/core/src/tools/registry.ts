/**
 * ------------------------------------------------------------------
 *  Title    |  Tool registry
 *  Ref      |  DESIGN.md §5.2, §12
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One list of every tool a model may call: built-ins, MCP
 *           |  servers and plugins, each with its permission metadata
 *           |  already resolved (default tier, overrides from
 *           |  config/tools.yaml, destructive floor).
 *  How      |  Tools never run themselves: the conductor calls execute()
 *           |  only after the permission gate allowed the call (or a
 *           |  person approved it). Built-ins live in tools/builtin.
 *           |  onChange() tells listeners the list changed (an MCP
 *           |  server connected or went away), so the lab's view of
 *           |  hosted tools (lab/mcp-server.ts) stays live.
 *  Note     |  TODO(phase-3): notebook.search, note.create, web.fetch.
 *           |  TODO(phase-5): embedding-based tool selection so small
 *           |  models are not handed fifty schemas.
 * ------------------------------------------------------------------
 */

import type { Tier } from '@nvx/contracts';

export interface ToolSpec {
  /** Unique name as the model sees it, e.g. "fs_read" or "github__create_issue". */
  name: string;
  description: string;
  inputSchema: unknown;
  action: string;
  tier: Tier;
  destructive: boolean;
  /** No side effects: safe to run again after a crash left it unfinished. */
  readOnly?: boolean;
  /**
   * A tool that is polled and may fail a few times on purpose (waiting for a job).
   * The repeated-failure guard (conductor/loopguard.ts) allows it more attempts.
   */
  polls?: boolean;
  /** How long one call may take, when it needs longer than the conductor's default (python_run). */
  timeoutMs?: number;
  source: { kind: 'builtin' } | { kind: 'mcp'; server: string } | { kind: 'plugin'; plugin: string };
  /**
   * CA3: a tool that exists for one notebook only (a per-notebook extension).
   * Absent: every notebook, and threads outside one, are offered it. A notebook
   * never sees another notebook's tool, in a tools block or in a bridge note.
   */
  notebookId?: string | null;
  /**
   * Arguments → the resource URI the permission check runs on. `scope` is
   * where the call happens (thread, notebook), for tools whose target
   * depends on it, like the repository a thread is linked to.
   */
  resource(args: unknown, scope?: ToolScope): string;
  execute(
    args: unknown,
    ctx: { idempotencyKey: string; signal: AbortSignal; scope?: ToolScope; callId?: string },
  ): Promise<unknown>;
  /**
   * What the approval shows instead of the raw arguments: the resolved
   * target and exactly what will happen (a commit's files and message,
   * the branch a push goes to). Read-only; a failure falls back to the
   * arguments.
   */
  preview?(args: unknown, scope?: ToolScope): Promise<unknown>;
}

export interface ToolScope {
  threadId?: string | null;
  notebookId?: string | null;
  /** A repository @-mentioned on this message: git tools act on it. */
  repoId?: string | null;
  workspaceId?: string;
}

export interface ToolOverride {
  tier?: Tier;
  disabled?: boolean;
  destructive?: boolean;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();
  private readonly listeners = new Set<() => void>();

  register(tool: ToolSpec, override?: ToolOverride): void {
    if (override?.disabled) return;
    const destructive = override?.destructive ?? tool.destructive;
    let tier = override?.tier ?? tool.tier;
    if (destructive && tier === 'auto') tier = 'gated'; // the floor holds even against config
    this.tools.set(tool.name, { ...tool, tier, destructive });
    this.changed();
  }

  unregisterSource(match: (s: ToolSpec['source']) => boolean): void {
    let removed = false;
    for (const [name, t] of this.tools)
      if (match(t.source)) {
        this.tools.delete(name);
        removed = true;
      }
    if (removed) this.changed();
  }

  /**
   * Called after every change to the list (synchronously, so a burst of
   * registrations calls it once per tool: debounce on the listener's side).
   * Returns the function that stops listening.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // A listener's failure is its own; the registry has changed regardless.
      }
    }
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }
}

/** The override config/tools.yaml sets for an action like "fs.write" (tools.fs.write). */
export function overrideFor(
  tools: Record<string, Record<string, ToolOverride>> | undefined,
  action: string,
): ToolOverride | undefined {
  const i = action.indexOf('.');
  if (i < 0) return undefined;
  return tools?.[action.slice(0, i)]?.[action.slice(i + 1)];
}

/** MCP annotations → default tier (DESIGN.md §5.2). */
export function tierFromMcpAnnotations(
  a: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
): Tier {
  if (a?.destructiveHint) return 'critical';
  if (a?.readOnlyHint) return 'auto';
  return 'gated';
}
