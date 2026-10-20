/**
 * ------------------------------------------------------------------
 *  Title    |  /decisions
 *  Ref      |  docs/decisions.md · docs/api.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read and change how decision models are used, for
 *           |  Settings → Decisions: the routes and their state, the
 *           |  free allowance meters, caps, and the order.
 *  How      |  GET /decisions answers the status. PUT /decisions/
 *           |  settings changes the settings (free first, order,
 *           |  switched-off routes, ceilings, caps, the local server).
 *  Note     |  No key or token is ever in an answer; keys are added
 *           |  in Settings → API keys.
 * ------------------------------------------------------------------
 */

import { PutDecisionSettingsRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { DecisionRouter } from './router';

export function decisionRoutes(router: DecisionRouter) {
  const r = new Hono<AppEnv>();
  r.get('/decisions', async (c) => c.json(await router.status()));
  r.put('/decisions/settings', async (c) => {
    await router.update(await body(c, PutDecisionSettingsRequest));
    return c.json(await router.status());
  });
  return r;
}
