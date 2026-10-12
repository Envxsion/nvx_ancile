/**
 * ------------------------------------------------------------------
 *  Title    |  Context link routes
 *  Ref      |  docs/api.md (Context links) · docs/notebooks.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  List, make and remove the links a thread or notebook
 *           |  reads through, and the ones that read from it.
 *  How      |  GET/POST /threads/:id/links, GET/POST
 *           |  /notebooks/:id/links, DELETE /context-links/:id. Making
 *           |  one is refused (403, the scope's own code) when the
 *           |  scopes say no now.
 * ------------------------------------------------------------------
 */

import { CreateContextLinkRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { LinkService } from './service';

export function linkRoutes(links: LinkService) {
  const r = new Hono<AppEnv>();
  for (const kind of ['thread', 'notebook'] as const) {
    const base = kind === 'thread' ? '/threads/:id/links' : '/notebooks/:id/links';
    r.get(base, async (c) => c.json(await links.list({ kind, id: c.req.param('id') })));
    r.post(base, async (c) => {
      const req = await body(c, CreateContextLinkRequest);
      return c.json(await links.create({ kind, id: c.req.param('id') }, req), 201);
    });
  }
  r.delete('/context-links/:id', async (c) => {
    await links.remove(c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}
