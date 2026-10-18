/**
 * ------------------------------------------------------------------
 *  Title    |  Model watch routes
 *  Ref      |  roadmap MD4, MD5 · docs/api.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the daily checks found, check now, and the
 *           |  controls for each model line: follow latest, use a
 *           |  model now, go back.
 *  How      |  Thin: bodies are parsed against contracts/modelwatch,
 *           |  the work is ModelWatch's. Mount before the general
 *           |  /models/:id routes, which would otherwise take
 *           |  PUT /models/lines/... and PUT /models/watch/settings.
 * ------------------------------------------------------------------
 */
import {
  ModelChangesSeen,
  ModelLineUpdate,
  ModelWatchAdd,
  ModelWatchCheckRequest,
  ModelWatchSettings,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../app';
import { body } from '../../http/body';
import type { ModelWatch } from './service';

export function modelWatchRoutes(watch: ModelWatch): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/models/watch', async (c) => c.json(await watch.report()));

  r.post('/models/watch/check', async (c) => {
    const req = await body(c, ModelWatchCheckRequest);
    return c.json(await watch.check(req.provider));
  });

  r.put('/models/watch/settings', async (c) => {
    const req = await body(c, ModelWatchSettings);
    return c.json(await watch.setOpenrouterPrices(req.openrouter_prices));
  });

  r.post('/models/watch/seen', async (c) => {
    const req = await body(c, ModelChangesSeen);
    await watch.markSeen(req.ids);
    return c.body(null, 204);
  });

  r.post('/models/watch/add', async (c) => {
    const req = await body(c, ModelWatchAdd);
    return c.json(await watch.add(req.model_id), 201);
  });

  r.put('/models/lines/:provider/:line', async (c) => {
    const req = await body(c, ModelLineUpdate);
    return c.json(await watch.updateLine(`${c.req.param('provider')}/${c.req.param('line')}`, req));
  });

  r.post('/models/lines/:provider/:line/back', async (c) =>
    c.json(await watch.back(`${c.req.param('provider')}/${c.req.param('line')}`)),
  );

  return r;
}
