/**
 * ------------------------------------------------------------------
 *  Title    |  Local models routes
 *  Ref      |  docs/api.md (Local models) · contracts localmodels.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What Admin → Models → Download a local model reads and
 *           |  does: the list with what fits, Ollama's state, starting,
 *           |  following and cancelling a download.
 *  How      |  GET /local-models · POST /local-models/:id/download
 *           |  {anyway?} · GET /local-models/downloads/:id · POST
 *           |  /local-models/downloads/:id/cancel. Starting again after
 *           |  a cancel or a failure resumes.
 * ------------------------------------------------------------------
 */

import { LocalDownloadRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { LocalModels } from './service';

export function localModelRoutes(deps: { models: LocalModels }) {
  const r = new Hono<AppEnv>();
  const { models } = deps;

  r.get('/local-models', async (c) => c.json(await models.view()));
  r.post('/local-models/:id/download', async (c) => {
    const req = await body(c, LocalDownloadRequest);
    return c.json(
      await models.start(c.req.param('id'), { anyway: req.anyway, ...(req.quant && { quant: req.quant }) }),
      202,
    );
  });
  r.get('/local-models/downloads/:id', (c) => c.json(models.job(c.req.param('id'))));
  r.post('/local-models/downloads/:id/cancel', (c) => c.json(models.cancel(c.req.param('id'))));

  return r;
}
