/**
 * ------------------------------------------------------------------
 *  Title    |  Tools and MCP servers
 *  Ref      |  DESIGN.md §5.2, §12 · docs/plugins.md · docs/api.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the model can call, and from where: every tool with
 *           |  its tier and source, and the MCP servers people add,
 *           |  change, test and remove in Admin → Plugins, with per-tool
 *           |  settings.
 *  How      |  Bodies are checked against the contract schemas
 *           |  (packages/contracts/src/mcp.ts); McpService does the
 *           |  work and applies it at once. Servers in config/mcp.yaml
 *           |  are listed read-only, but their tools can be changed.
 *           |  /mcp/approvals lists each server's approved tool list
 *           |  (host and Claude Code's own) and approves a changed one
 *           |  once, by the fingerprint you were shown (guard.ts).
 *           |  /mcp/presets is the Add server catalogue (presets.ts).
 *  Note     |  TODO(phase-5): OAuth sign-in for remote servers from the
 *           |  app (the oauth flag in config/mcp.yaml is not used yet).
 * ------------------------------------------------------------------
 */

import {
  AddMcpPresetRequest,
  ApproveMcpToolsRequest,
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
  UpdateMcpToolRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import type { ToolRegistry } from '../tools/registry';
import type { McpToolGuard } from './guard';
import type { McpPresets } from './presets';
import type { McpService } from './service';

export function toolRoutes(deps: {
  tools: ToolRegistry;
  servers: McpService;
  guard?: McpToolGuard;
  presets?: McpPresets;
}) {
  const r = new Hono<AppEnv>();
  const { servers } = deps;

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

  r.get('/mcp/servers', async (c) => c.json({ items: await servers.list(), next_cursor: null }));

  r.post('/mcp/servers', async (c) =>
    c.json(await servers.create(await body(c, CreateMcpServerRequest)), 201),
  );

  // The Add server catalogue: GET lists presets with what is missing to run each; POST adds one
  // and answers with the server as it stands after its first connection attempt.
  r.get('/mcp/presets', async (c) =>
    c.json({ items: deps.presets ? await deps.presets.list() : [], next_cursor: null }),
  );

  r.post('/mcp/presets/:id/add', async (c) => {
    if (!deps.presets) throw notFound('That MCP preset');
    const req = await body(c, AddMcpPresetRequest);
    return c.json(await deps.presets.add(c.req.param('id'), req), 201);
  });

  r.get('/mcp/servers/:id', async (c) => c.json(await servers.view(c.req.param('id'))));

  r.patch('/mcp/servers/:id', async (c) =>
    c.json(await servers.update(c.req.param('id'), await body(c, UpdateMcpServerRequest))),
  );

  r.delete('/mcp/servers/:id', async (c) => {
    await servers.remove(c.req.param('id'));
    return c.body(null, 204);
  });

  r.post('/mcp/servers/:id/test', async (c) => c.json(await servers.test(c.req.param('id'))));

  r.get('/mcp/approvals', async (c) =>
    c.json({ items: deps.guard ? await deps.guard.list() : [], next_cursor: null }),
  );

  r.post('/mcp/approvals/:key/approve', async (c) => {
    const { fingerprint } = await body(c, ApproveMcpToolsRequest);
    if (!deps.guard) throw notFound('That MCP server');
    return c.json(await deps.guard.approve(c.req.param('key'), fingerprint));
  });

  r.patch('/mcp/servers/:id/tools/:tool', async (c) =>
    c.json(
      await servers.updateTool(c.req.param('id'), c.req.param('tool'), await body(c, UpdateMcpToolRequest)),
    ),
  );

  return r;
}
