/**
 * ------------------------------------------------------------------
 *  Title    |  Automation routes
 *  Ref      |  ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  List the automations, switch one on or off, run one now.
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import type { AutomationRunner } from './runner';

const Patch = z.object({ enabled: z.boolean() }).strict();

export function automationRoutes(deps: { runner: AutomationRunner }) {
  const r = new Hono<AppEnv>();

  r.get('/automations', async (c) => c.json({ items: await deps.runner.views(), next_cursor: null }));

  r.patch('/automations/:id', async (c) => {
    const req = await body(c, Patch);
    const id = c.req.param('id');
    const view = (await deps.runner.views()).find((v) => v.id === id);
    if (!view) throw notFound('That automation');
    if (view.trigger === 'event')
      throw new AncileError({
        code: 'automation.event_driven',
        title: `${view.title} runs as part of another feature`,
        hint: 'It has no schedule to switch off here.',
        status: 422,
        errorClass: 'permanent',
      });
    await deps.runner.setEnabled(id, req.enabled);
    return c.json((await deps.runner.views()).find((v) => v.id === id));
  });

  r.post('/automations/:id/run', async (c) => {
    const id = c.req.param('id');
    const status = await deps.runner.runNow(id);
    if (status === 'unknown') throw notFound('That automation');
    if (status === 'busy')
      throw new AncileError({
        code: 'automation.busy',
        title: 'It is running already',
        hint: 'Wait for it to finish.',
        status: 409,
        errorClass: 'permanent',
      });
    return c.json((await deps.runner.views()).find((v) => v.id === id));
  });

  return r;
}
