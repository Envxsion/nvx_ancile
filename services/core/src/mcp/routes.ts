/**
 * ------------------------------------------------------------------
 *  Title    |  Tools and MCP servers
 *  Ref      |  DESIGN.md §5.2, §12
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the model can call, and from where: every tool with
 *           |  its tier and source, every MCP server with its health,
 *           |  and a way to reconnect one now.
 *  Note     |  Adding a server from the UI writes config/mcp.yaml;
 *           |  TODO(phase-5) with the config writer.
 * ------------------------------------------------------------------
 */

import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { notFound } from '../obs/errors';
import type { ToolRegistry } from '../tools/registry';
import type { McpManager } from './manager';

export function toolRoutes(deps: { tools: ToolRegistry; mcp: McpManager }) {
  const r = new Hono<AppEnv>();

  r.get('/tools', (c) =>
    c.json({
      items: deps.tools.list().map((t) => ({
        name: t.name,
        description: t.description,
        action: t.action,
        tier: t.tier,
        destructive: t.destructive,
        source: t.source,
      })),
      next_cursor: null,
    }),
  );

  r.get('/mcp/servers', (c) => c.json({ items: deps.mcp.status(), next_cursor: null }));

  r.post('/mcp/servers/:id/test', async (c) => {
    const h = await deps.mcp.test(c.req.param('id'));
    if (!h) throw notFound('That MCP server');
    return c.json(h);
  });

  return r;
}
