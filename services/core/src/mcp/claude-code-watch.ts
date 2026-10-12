/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's own MCP servers, watched for changes
 *  Ref      |  docs/plugins.md (When a server changes its tools)
 *           |  · docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A live Claude Code session uses your Claude Code MCP
 *           |  servers as well as NVX Ancile's own. Give those the
 *           |  same rug-pull guard: their tool lists are fingerprinted
 *           |  the first time a session starts with them, and a later
 *           |  session that sees a different list marks the server
 *           |  changed, so its new tools are refused in the gate (the
 *           |  same PreToolUse check every Claude Code call passes).
 *  How      |  Listens to the bridge's events (its own listener, so the
 *           |  live session code is untouched). A session's
 *           |  `system/init` message names its MCP servers with their
 *           |  status and every tool it has (`mcp__<server>__<tool>`).
 *           |  Each connected server with tools in that list is
 *           |  observed by name. NVX Ancile's own server ("ancile") is
 *           |  not: its tools are checked as the tools they host.
 *  Note     |  Claude Code reports tool names only, so its servers are
 *           |  compared on names (coverage "names"): a new tool is
 *           |  caught, a changed description is not. A session started
 *           |  with no MCP tools at all (a model call with tools off)
 *           |  says nothing about the servers and is skipped.
 * ------------------------------------------------------------------
 */

import type { LiveEvent } from '../claudecode/bridge-protocol';
import { logFor } from '../obs/logger';
import type { McpToolGuard } from './guard';

const log = logFor('mcp');

/** NVX Ancile's own server in a session (claudecode/permission-map.ts ANCILE_MCP_SERVER). */
const ANCILE_SERVER = 'ancile';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Servers and their tools from a session's init message, or null when it says nothing about them. */
export function serversFromInit(m: Record<string, unknown>): Map<string, string[]> | null {
  if (m.type !== 'system' || m.subtype !== 'init' || !Array.isArray(m.tools)) return null;
  const byServer = new Map<string, string[]>();
  for (const t of m.tools) {
    if (typeof t !== 'string') continue;
    const x = /^mcp__(.+?)__(.+)$/.exec(t);
    if (!x) continue;
    const [, server = '', tool = ''] = x;
    if (server === ANCILE_SERVER) continue;
    byServer.set(server, [...(byServer.get(server) ?? []), tool]);
  }
  if (!byServer.size) return null;
  // Only servers the session reports connected: one still starting has not listed its tools yet.
  const status = new Map<string, string>();
  if (Array.isArray(m.mcp_servers))
    for (const s of m.mcp_servers)
      if (isObj(s) && typeof s.name === 'string' && typeof s.status === 'string')
        status.set(s.name, s.status);
  for (const server of [...byServer.keys()]) {
    const st = status.get(server);
    if (st !== undefined && st !== 'connected') byServer.delete(server);
  }
  return byServer;
}

/** Watch live sessions' init messages; returns the unsubscribe. */
export function watchClaudeCodeMcp(
  bridge: { onEvent(fn: (e: LiveEvent) => void): () => void },
  guard: Pick<McpToolGuard, 'observe'>,
): () => void {
  return bridge.onEvent((e) => {
    if (e.event !== 'session.message') return;
    const servers = serversFromInit(e.data.message);
    if (!servers) return;
    for (const [server, tools] of servers)
      void guard
        .observe(
          'claude_code',
          server,
          tools.map((name) => ({ name })),
          'names',
        )
        .catch((err: unknown) =>
          log.warn({ server, err: (err as Error).message }, "could not check Claude Code's MCP tools"),
        );
  });
}
