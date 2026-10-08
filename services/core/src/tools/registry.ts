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
  source: { kind: 'builtin' } | { kind: 'mcp'; server: string } | { kind: 'plugin'; plugin: string };
  /**
   * Arguments → the resource URI the permission check runs on. `scope` is
   * where the call happens (thread, notebook), for tools whose target
   * depends on it, like the repository a thread is linked to.
   */
  resource(args: unknown, scope?: ToolScope): string;
  execute(
    args: unknown,
    ctx: { idempotencyKey: string; signal: AbortSignal; scope?: ToolScope },
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

  register(tool: ToolSpec, override?: ToolOverride): void {
    if (override?.disabled) return;
    const destructive = override?.destructive ?? tool.destructive;
    let tier = override?.tier ?? tool.tier;
    if (destructive && tier === 'auto') tier = 'gated'; // the floor holds even against config
    this.tools.set(tool.name, { ...tool, tier, destructive });
  }

  unregisterSource(match: (s: ToolSpec['source']) => boolean): void {
    for (const [name, t] of this.tools) if (match(t.source)) this.tools.delete(name);
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
