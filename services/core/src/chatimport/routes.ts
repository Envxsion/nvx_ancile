/**
 * ------------------------------------------------------------------
 *  Title    |  Chat import routes
 *  Ref      |  ROADMAP SU1 · docs/api.md (Chat imports)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What "Bring my chats" on first run reads and does.
 *  How      |  POST /imports/chats (multipart: file, optional
 *           |  notebook_id) answers a ChatImport at once with 202.
 *           |  GET /imports/chats lists the newest; GET
 *           |  /imports/chats/:id follows one; POST
 *           |  /imports/chats/:id/cancel stops it after the
 *           |  conversation in hand.
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { notFound } from '../obs/errors';
import type { ChatImportService } from './service';

const noFile = () =>
  new AncileError({
    code: 'request.invalid',
    title: 'No file came with that request',
    hint: 'Choose the export file and try again.',
    status: 400,
    errorClass: 'permanent',
  });

export function chatImportRoutes(deps: {
  imports: ChatImportService;
  /** True when the notebook exists in this workspace. */
  notebookExists: (id: string) => Promise<boolean>;
}) {
  const r = new Hono<AppEnv>();
  const { imports } = deps;

  r.post('/imports/chats', async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw noFile();
    const nb = typeof form.notebook_id === 'string' && form.notebook_id ? form.notebook_id : null;
    if (nb && !(await deps.notebookExists(nb))) throw notFound('That notebook');
    const job = await imports.start({
      file: Buffer.from(await file.arrayBuffer()),
      fileName: file.name || null,
      notebookId: nb,
    });
    return c.json(job, 202);
  });
  r.get('/imports/chats', async (c) => c.json({ items: await imports.list() }));
  r.get('/imports/chats/:id', async (c) => c.json(await imports.get(c.req.param('id'))));
  r.post('/imports/chats/:id/cancel', async (c) => c.json(await imports.cancel(c.req.param('id'))));
  return r;
}
