/**
 * ------------------------------------------------------------------
 *  Title    |  Connected apps (MCP clients)
 *  Ref      |  DESIGN.md §4.4 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Connect an app to NVX Ancile's MCP server: name it, pick
 *           |  what it may do, get its token once with a ready-made
 *           |  config; see when it was last used; disconnect it.
 * ------------------------------------------------------------------
 */

import { CreateMcpClientRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import { clientViews, connectClient, disconnectClient, SERVED_TOOLS, type ServerDeps } from './server';

export function mcpClientRoutes(
  deps: Pick<ServerDeps, 'clients' | 'permissions' | 'userId'> & { publicUrl: string },
) {
  const r = new Hono<AppEnv>();
  const endpoint = `${deps.publicUrl.replace(/\/$/, '')}/mcp`;

  r.get('/mcp/server', (c) =>
    c.json({
      url: endpoint,
      tools: Object.entries(SERVED_TOOLS).map(([name, s]) => ({ name, title: s.title, action: s.action })),
    }),
  );

  r.get('/mcp/clients', async (c) => c.json({ items: await clientViews(deps), next_cursor: null }));

  r.post('/mcp/clients', async (c) => {
    const req = await body(c, CreateMcpClientRequest);
    const { client, token } = await connectClient(deps, req.name, req.tools);
    const views = await clientViews(deps);
    return c.json(
      {
        client: views.find((v) => v.id === client.id),
        token,
        url: endpoint,
        // Ready to paste into a client that reads the common mcpServers format.
        config: {
          mcpServers: {
            'nvx-ancile': { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } },
          },
        },
      },
      201,
    );
  });

  r.delete('/mcp/clients/:id', async (c) => {
    if (!(await disconnectClient(deps, c.req.param('id')))) throw notFound('That app');
    return c.body(null, 204);
  });

  return r;
}
