/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's tools, in Ancile's terms
 *  Ref      |  docs/claude-code.md (Approvals) · DESIGN.md §5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every tool call a live Claude Code session makes is
 *           |  decided by Ancile's gate, in the same vocabulary as chat
 *           |  and the lab, so the same grants, policies and tiers
 *           |  apply: Read is fs.read on fs:<path>, Edit is fs.write,
 *           |  Bash is shell.exec on shell:<command>.
 *  How      |  The gate for a session is made with the session's
 *           |  folder as its root (claudecode/live.ts), so a write
 *           |  inside the folder stays gated and one outside it is
 *           |  critical (base.cedar). Reads inside the folder run;
 *           |  reads outside it ask. Paths become posix resources
 *           |  ("C:\a\b" → fs:/C:/a/b). Claude Code's own bookkeeping
 *           |  tools (Agent, TodoWrite, Skill, ToolSearch, …) run.
 *           |  mcp__<server>__<tool> is mcp.<server>.<tool> on
 *           |  mcp:<server>/<tool>, except Ancile's own server
 *           |  ("ancile"): its knowledge tools read the notebook, and
 *           |  a hosted MCP tool is checked as that tool, on its real
 *           |  arguments.
 * ------------------------------------------------------------------
 */

import { isAbsolute, resolve } from 'node:path';
import type { Tier } from '@nvx/contracts';
import type { ToolSpec } from '../tools/registry';
import { cwdWithin } from './store';

export const CLAUDE_CODE_PRINCIPAL = 'agent:claude-code';
/** The key of Ancile's own MCP server in a session's config. */
export const ANCILE_MCP_SERVER = 'ancile';
/** Ancile's knowledge tools on that server. */
export const ANCILE_TOOLS = ['search', 'read_source', 'memory_search'] as const;

export interface MappedTool {
  action: string;
  resource: string;
  tier: Tier;
  destructive: boolean;
  /** A hosted MCP tool's own name, when the call is one. */
  hosted?: string;
}

export interface MapContext {
  /** The session's folder, as the OS writes it. */
  cwd: string;
  notebookId: string | null;
  workspaceId: string;
  /** The hosted tool behind a name on Ancile's server. */
  hosted?: (name: string) => ToolSpec | undefined;
  platform?: NodeJS.Platform;
}

const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELLS = new Set(['Bash', 'PowerShell']);
/** Claude Code's own bookkeeping: no effect outside the session. */
const AUTO = new Set([
  'Agent',
  'Task',
  'TodoWrite',
  'TodoRead',
  'Skill',
  'ToolSearch',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'SlashCommand',
  'BashOutput',
  'TaskOutput',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'KillShell',
  'KillBash',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Monitor',
  'SendMessage',
]);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** A real path (relative to the session folder when not absolute) as a posix resource path. */
export function resourcePath(raw: string | undefined, cwd: string): string {
  const abs = raw ? (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) ? raw : resolve(cwd, raw)) : cwd;
  const p = abs.replace(/\\/g, '/');
  return p.startsWith('/') ? p : `/${p}`;
}

/** The session folder as the gate's root (same form as resourcePath). */
export const gateRoot = (cwd: string) => resourcePath(cwd, cwd);

function pathOf(input: Record<string, unknown>): string | undefined {
  return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
}

export function mapTool(name: string, input: unknown, ctx: MapContext): MappedTool {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const platform = ctx.platform ?? process.platform;
  if (READS.has(name)) {
    const raw = pathOf(args);
    const inside = !raw || cwdWithin(resourcePathNative(raw, ctx.cwd), ctx.cwd, platform);
    return {
      action: 'fs.read',
      resource: `fs:${resourcePath(raw, ctx.cwd)}`,
      tier: inside ? 'auto' : 'gated',
      destructive: false,
    };
  }
  if (WRITES.has(name))
    return {
      action: 'fs.write',
      resource: `fs:${resourcePath(pathOf(args), ctx.cwd)}`,
      // Outside the session folder base.cedar raises this to critical.
      tier: 'gated',
      destructive: false,
    };
  if (SHELLS.has(name))
    return {
      action: 'shell.exec',
      resource: `shell:${str(args.command) ?? ''}`,
      tier: 'gated',
      destructive: true,
    };
  if (name === 'WebFetch')
    return {
      action: 'web.fetch',
      resource: `http:${str(args.url) ?? ''}`,
      tier: 'gated',
      destructive: false,
    };
  if (name === 'WebSearch')
    return {
      action: 'web.search',
      resource: `web:search/${str(args.query) ?? ''}`,
      tier: 'gated',
      destructive: false,
    };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = '', tool = ''] = mcp;
    if (server === ANCILE_MCP_SERVER) {
      if (tool === 'memory_search')
        return { action: 'memory.read', resource: 'memory:all', tier: 'auto', destructive: false };
      if ((ANCILE_TOOLS as readonly string[]).includes(tool))
        return {
          action: 'knowledge.search',
          resource: ctx.notebookId ? `notebook:${ctx.notebookId}` : `workspace:${ctx.workspaceId}`,
          tier: 'auto',
          destructive: false,
        };
      const spec = ctx.hosted?.(tool);
      if (spec)
        return {
          action: spec.action,
          resource: spec.resource(args, { workspaceId: ctx.workspaceId }),
          tier: spec.tier,
          destructive: spec.destructive,
          hosted: spec.name,
        };
    }
    return {
      action: `mcp.${server}.${tool}`,
      resource: `mcp:${server}/${tool}`,
      tier: 'gated',
      destructive: false,
    };
  }
  if (AUTO.has(name))
    return {
      action: `claude_code.${name}`,
      resource: `claude_code:${name}`,
      tier: 'auto',
      destructive: false,
    };
  return {
    action: `claude_code.${name}`,
    resource: `claude_code:${name}`,
    tier: 'gated',
    destructive: false,
  };
}

/** The native form of a path, for comparing with the session folder. */
function resourcePathNative(raw: string, cwd: string): string {
  return isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) ? raw : resolve(cwd, raw);
}
