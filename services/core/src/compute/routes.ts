/**
 * ------------------------------------------------------------------
 *  Title    |  /compute: remote compute through the Controller
 *  Ref      |  DESIGN.md §4.1 (Compute), §4.3, §7.3, §13.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What Admin → Compute needs: nodes and their recent
 *           |  operations, actions with a live confirmation chain,
 *           |  costs, rules, adding and forgetting a node; and "Use a
 *           |  cloud model instead" for a turn waiting on a node.
 *  How      |  A thin, validated proxy over the Controller's control
 *           |  plane. Actions get an idempotency key here when the
 *           |  Cockpit did not send one; the operation stream is
 *           |  relayed byte for byte.
 * ------------------------------------------------------------------
 */

import { NodeAction } from '@nvx/contracts/controller';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { useCloud } from '../gateway/compute';
import { body } from '../http/body';
import { featureRequired } from '../pro/routes';
import type { ControllerClient } from './controller';

const enc = encodeURIComponent;

const ActionBody = z
  .object({
    action: NodeAction,
    idempotency_key: z.string().min(8).max(200).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

const AddNodeBody = z
  .object({
    provider_ref: z.string().min(1).max(500),
    name: z.string().min(1).max(120).optional(),
    served_models: z.array(z.string().min(1).max(200)).max(50).optional(),
    storage_rate_month: z.number().nonnegative().max(100_000).optional(),
  })
  .strict();

const RuleBody = z.object({
  id: z.string().max(64).optional(),
  kind: z.enum(['idle_timeout', 'schedule', 'cost_cap']),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
});

/**
 * The free edition runs one GPU node; GPU fleet (Pro) runs many. Sample
 * nodes never count, and nodes added before are never switched off.
 */
async function assertRoomForNode(client: ControllerClient, hasFleet: boolean) {
  if (hasFleet) return;
  const { items } = await client.get<{ items: { provider: string }[] }>('/nodes');
  if (items.filter((n) => n.provider !== 'fake').length >= 1) throw featureRequired('fleet');
}

export function computeRoutes(deps: {
  client: ControllerClient;
  /** Pro's licence check; absent (tests, older wiring) means no limit. */
  hasFeature?: (f: 'fleet') => boolean;
}) {
  const r = new Hono<AppEnv>();
  const { client } = deps;

  r.get('/compute/status', async (c) => {
    if (!client.configured)
      return c.json({ configured: false, reachable: false, sample: false, provider: null });
    try {
      const { items } = await client.get<{ items: { provider: string }[] }>('/nodes');
      const providers = [...new Set(items.map((n) => n.provider))];
      return c.json({
        configured: true,
        reachable: true,
        sample: providers.length > 0 && providers.every((p) => p === 'fake'),
        provider: providers[0] ?? null,
      });
    } catch {
      return c.json({ configured: true, reachable: false, sample: false, provider: null });
    }
  });

  r.get('/compute/nodes', async (c) => c.json(await client.get('/nodes')));
  r.post('/compute/nodes', async (c) => {
    const req = await body(c, AddNodeBody);
    if (deps.hasFeature) await assertRoomForNode(client, deps.hasFeature('fleet'));
    return c.json(await client.send('POST', '/nodes', req), 201);
  });
  r.delete('/compute/nodes/:id', async (c) => {
    await client.send('DELETE', `/nodes/${enc(c.req.param('id'))}`);
    return c.body(null, 204);
  });
  r.get('/compute/nodes/:id/operations', async (c) =>
    c.json(await client.get(`/nodes/${enc(c.req.param('id'))}/operations?limit=10`)),
  );
  r.post('/compute/nodes/:id/actions', async (c) => {
    const req = await body(c, ActionBody);
    const out = await client.send('POST', `/nodes/${enc(c.req.param('id'))}/actions`, {
      action: req.action,
      idempotency_key: req.idempotency_key ?? `ui-${ulid()}`,
      reason: req.reason ?? 'Asked in Admin → Compute',
    });
    return c.json(out, 202);
  });

  r.get('/compute/operations/:id', async (c) =>
    c.json(await client.get(`/operations/${enc(c.req.param('id'))}`)),
  );
  r.get('/compute/operations/:id/stream', async (c) => {
    const res = await client.raw(`/operations/${enc(c.req.param('id'))}/stream`, c.req.raw.signal);
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  });

  r.get('/compute/costs', async (c) => {
    const month = c.req.query('month');
    return c.json(await client.get(`/costs${month ? `?month=${enc(month)}` : ''}`));
  });

  r.get('/compute/rules', async (c) => c.json(await client.get('/rules')));
  r.post('/compute/rules', async (c) =>
    c.json(await client.send('POST', '/rules', await body(c, RuleBody)), 201),
  );
  r.delete('/compute/rules/:id', async (c) => {
    await client.send('DELETE', `/rules/${enc(c.req.param('id'))}`);
    return c.body(null, 204);
  });

  // A turn waiting for a GPU node: stop waiting and let the next model answer.
  r.post('/runs/:id/use-cloud', (c) => {
    useCloud(c.req.param('id'));
    return c.json({ ok: true });
  });

  return r;
}
