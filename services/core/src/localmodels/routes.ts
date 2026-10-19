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
 *           |  a cancel or a failure resumes. LM1: GET
 *           |  /local-models/loaded · POST /local-models/loaded/unload
 *           |  {name} · POST /local-models/loaded/keep {name, keep} ·
 *           |  POST /local-models/warm {model}.
 * ------------------------------------------------------------------
 */

import { KeepLoadedRequest, LocalDownloadRequest, UnloadRequest, WarmRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { LoadedModels } from './loaded';
import type { LocalModels } from './service';

export function localModelRoutes(deps: { models: LocalModels; loaded?: LoadedModels }) {
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

  // LM1: what Ollama has in memory, and what you can do about it.
  const { loaded } = deps;
  if (loaded) {
    r.get('/local-models/loaded', async (c) => c.json(await loaded.view()));
    r.post('/local-models/loaded/unload', async (c) =>
      c.json(await loaded.unload((await body(c, UnloadRequest)).name)),
    );
    r.post('/local-models/loaded/keep', async (c) => {
      const req = await body(c, KeepLoadedRequest);
      return c.json(await loaded.keep(req.name, req.keep));
    });
    r.post('/local-models/warm', async (c) => c.json(await loaded.warm((await body(c, WarmRequest)).model)));
  }

  return r;
}
