/**
 * ------------------------------------------------------------------
 *  Title    |  Hosted tools, as the lab sees them
 *  Ref      |  DESIGN.md §5, vendor/opencode/PATCHES.md (patch 5)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The MCP servers Core connects to are offered to the lab
 *           |  as one server, "ancile" (lab/mcp-server.ts). This file
 *           |  is what the endpoint and the permission bridge share:
 *           |  which tools are hosted, the name the engine gives each
 *           |  one, and the one-call passes a person's approval leaves.
 *  How      |  The engine names an MCP tool "<server>_<tool>", so a
 *           |  hosted "github__create_issue" asks as
 *           |  "ancile_github__create_issue". The bridge checks that
 *           |  ask on the hosted tool's own action and resource. When
 *           |  a person approves it once, the bridge leaves a pass, and
 *           |  the endpoint spends it on the call that follows: the
 *           |  endpoint still runs the gate first, and a deny always
 *           |  wins over a pass.
 *  Note     |  The engine's ask carries no arguments and no call id
 *           |  Core can match, so a pass is for "this tool, once, in
 *           |  the next two minutes", not for one exact call.
 * ------------------------------------------------------------------
 */

import type { ToolRegistry, ToolSpec } from '../tools/registry';

/** The key of Core's server in the lab's `mcp` config. */
export const LAB_MCP_SERVER = 'ancile';
/** What the engine puts before each of that server's tools. */
export const LAB_MCP_PREFIX = `${LAB_MCP_SERVER}_`;

/** Tools that came from an MCP server Core hosts (not built-ins). */
export function hostedTools(registry: Pick<ToolRegistry, 'list'>): ToolSpec[] {
  return registry.list().filter((t) => t.source.kind === 'mcp');
}

/** The hosted tool behind a name, or undefined for a built-in or unknown name. */
export function hostedTool(registry: Pick<ToolRegistry, 'get'>, name: string): ToolSpec | undefined {
  const t = registry.get(name);
  return t && t.source.kind === 'mcp' ? t : undefined;
}

/** The hosted tool behind an engine permission name like "ancile_github__create_issue". */
export function hostedToolForAsk(
  registry: Pick<ToolRegistry, 'get'>,
  permission: string,
): ToolSpec | undefined {
  if (!permission.startsWith(LAB_MCP_PREFIX)) return undefined;
  return hostedTool(registry, permission.slice(LAB_MCP_PREFIX.length));
}

export const PASS_TTL_MS = 2 * 60_000;

/** One-call passes left by a person's "approve once" in the lab. In memory: a restart drops them. */
export class LabPasses {
  private readonly passes = new Map<string, number[]>(); // tool → expiry times

  constructor(private readonly ttlMs = PASS_TTL_MS) {}

  grant(tool: string, now = Date.now()): void {
    const live = (this.passes.get(tool) ?? []).filter((t) => t > now);
    live.push(now + this.ttlMs);
    this.passes.set(tool, live);
  }

  /** Spend one pass for this tool; false when there is none left. */
  take(tool: string, now = Date.now()): boolean {
    const live = (this.passes.get(tool) ?? []).filter((t) => t > now);
    const ok = live.length > 0;
    if (ok) live.shift();
    if (live.length) this.passes.set(tool, live);
    else this.passes.delete(tool);
    return ok;
  }
}
