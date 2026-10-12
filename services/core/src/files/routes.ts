/**
 * ------------------------------------------------------------------
 *  Title    |  File routes
 *  Ref      |  docs/api.md (Files) · packages/contracts/src/files.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The code editor's two calls: read a file, save a file.
 *  How      |  GET /files?path=…&thread_id=…  → FileContent
 *           |  PUT /files (FileWriteRequest)  → FileWriteResult
 *           |  Both through FileService, which runs the permission
 *           |  gate on the real path (service.ts).
 * ------------------------------------------------------------------
 */

import { FileWriteRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { badRequest } from '../obs/errors';
import type { FileService } from './service';

export function fileRoutes(deps: { files: FileService }) {
  const r = new Hono<AppEnv>();

  r.get('/files', async (c) => {
    const path = c.req.query('path');
    if (!path) throw badRequest('path: the file to open');
    const thread = c.req.query('thread_id') || null;
    return c.json(await deps.files.read(path, thread, c.get('traceId') ?? '0'.repeat(32)));
  });

  r.put('/files', async (c) => {
    const req = await body(c, FileWriteRequest);
    return c.json(await deps.files.write(req, c.get('traceId') ?? '0'.repeat(32)));
  });

  return r;
}
