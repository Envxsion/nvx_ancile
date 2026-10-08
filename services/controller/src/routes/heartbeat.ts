/**
 * ------------------------------------------------------------------
 *  Title    |  Node heartbeats
 *  Ref      |  infra/node/bootstrap.sh · DESIGN.md §7.3
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  A node's own account of how its start is going
 *           |  ("fetching weights", "loading into GPU memory"), so the
 *           |  confirmation chain says more than "in progress", and
 *           |  the model it serves is known as soon as it is up.
 *  How      |  POST /control/v1/nodes/heartbeat with the node token
 *           |  (CONTROLLER_NODE_TOKEN), not the Controller's own: a pod
 *           |  can report, but cannot act on anything. Progress lands
 *           |  on the live operation as a note; "error" becomes a
 *           |  notice; a served model gets its route.
 * ------------------------------------------------------------------
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, apiError, safeEqual } from '../http';
import { aliasFor } from '../nodes';
import { advance, isTerminal } from '../operations/machine';
import type { Store } from '../store';

const Beat = z.object({
  provider_ref: z.string().min(1).max(200),
  state: z.enum(['starting', 'running', 'error', 'stopping']),
  detail: z.string().max(500).default(''),
  model: z.string().max(200).optional(),
  port: z.number().int().optional(),
});

export function heartbeatRoutes(deps: { store: Store; nodeToken?: string; now?: () => Date }) {
  const app = new Hono<AppEnv>();
  const now = deps.now ?? (() => new Date());

  app.post('/', async (c) => {
    const presented = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!deps.nodeToken || !presented || !safeEqual(presented, deps.nodeToken))
      return apiError(
        c,
        401,
        'auth.node_token_invalid',
        'The heartbeat did not carry a valid node token',
        'Set CONTROLLER_NODE_TOKEN on the pod to the value the Controller uses.',
      );
    const parsed = Beat.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return apiError(
        c,
        422,
        'request.invalid',
        'The heartbeat was not readable',
        'Send {provider_ref, state, detail}.',
      );
    const beat = parsed.data;
    const node = (await deps.store.listNodes()).find((n) => n.provider_ref === beat.provider_ref);
    if (!node) return c.body(null, 204); // a pod we do not manage: nothing to say

    const live = await deps.store.liveOperationFor(node.id);
    if (live && !isTerminal(live.status) && beat.detail) {
      // A same-state note: the chain stays on its link and gains a line.
      await deps.store.putOperation(advance(live, live.status, `Node: ${beat.detail}`, now()));
    }
    if (beat.state === 'error')
      deps.store.events.emit('event', {
        type: 'notice',
        level: 'error',
        title: `${node.name} reported a problem`,
        body: beat.detail || 'The node could not start its model server.',
      });
    if (beat.model && !node.served_models.includes(beat.model)) {
      await deps.store.putNode({ ...node, served_models: [...node.served_models, beat.model] });
      await deps.store.putRoute({ alias: aliasFor(beat.model), targets: [{ node_id: node.id }], policy: {} });
    }
    return c.body(null, 204);
  });

  return app;
}
