/**
 * ------------------------------------------------------------------
 *  Title    |  Activity routes
 *  Ref      |  docs/activity.md · docs/api.md (Activity)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  GET /activity: what is running, read-only. POST
 *           |  /activity/typing: the person is typing, so background
 *           |  imports wait for them.
 *  How      |  Behind the normal /api/v1 guard. Nothing here starts,
 *           |  stops or signals anything.
 * ------------------------------------------------------------------
 */

import { ActivityResponse, ActivityTypingRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { ActivityService } from './service';

export function activityRoutes(deps: { activity: ActivityService }) {
  const r = new Hono<AppEnv>();
  r.get('/activity', async (c) => c.json(ActivityResponse.parse(await deps.activity.list())));
  r.post('/activity/typing', async (c) => {
    const req = await body(c, ActivityTypingRequest);
    deps.activity.typing(req.ms);
    return c.body(null, 204);
  });
  return r;
}
