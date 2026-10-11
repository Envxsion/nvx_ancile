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

import { NodeAction, type ProviderStatus } from '@nvx/contracts/controller';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { useCloud } from '../gateway/compute';
import { body } from '../http/body';
import { featureRequired } from '../pro/routes';
import type { SecretStore } from '../secrets';
import type { ControllerClient } from './controller';

/** The RunPod key, encrypted in Core's secret store; the Controller holds it only in memory. */
export const RUNPOD_KEY_SECRET = 'compute.runpod_api_key';

/**
 * Give the Controller the saved RunPod key whenever it has none (it restarted,
 * or was down when the key was saved). Safe to call often: one at a time,
 * and only a GET when nothing is needed.
 */
export function providerSync(client: ControllerClient, secrets: SecretStore) {
  let running: Promise<void> | null = null;
  const once = async () => {
    if (!client.configured) return;
    const key = await secrets.get(RUNPOD_KEY_SECRET);
    if (!key) return;
    const now = await client.get<ProviderStatus>('/provider');
    if (now.kind === 'fake') await client.send('PUT', '/provider', { kind: 'runpod', api_key: key });
  };
  return (): Promise<void> => {
    running ??= once()
      .catch(() => undefined)
      .finally(() => {
        running = null;
      });
    return running;
  };
}

/** Connect RunPod: the Controller checks the key with RunPod first; only then is it saved here. */
export async function connectRunPod(
  client: ControllerClient,
  secrets: SecretStore | undefined,
  apiKey: string,
): Promise<ProviderStatus> {
  const status = await client.send<ProviderStatus>('PUT', '/provider', { kind: 'runpod', api_key: apiKey });
  await secrets?.set(RUNPOD_KEY_SECRET, apiKey);
  return status;
}

/** Back to sample nodes, and the saved key removed. */
export async function disconnectRunPod(
  client: ControllerClient,
  secrets: SecretStore | undefined,
): Promise<ProviderStatus> {
  const status = await client.send<ProviderStatus>('DELETE', '/provider');
  await secrets?.delete(RUNPOD_KEY_SECRET);
  return status;
}

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
  /** Where the RunPod key is kept; absent (tests) means it cannot be connected from the app. */
  secrets?: SecretStore;
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

  const sync = deps.secrets ? providerSync(client, deps.secrets) : null;

  // Which provider manages nodes, and connecting RunPod from the app (the key
  // is checked by the Controller against RunPod before it is saved here).
  r.get('/compute/provider', async (c) => {
    await sync?.();
    const status = await client.get<ProviderStatus>('/provider');
    return c.json({ ...status, key_saved: !!(await deps.secrets?.get(RUNPOD_KEY_SECRET)) });
  });
  r.put('/compute/provider', async (c) => {
    const { api_key } = await body(c, z.object({ api_key: z.string().trim().min(8).max(400) }));
    const status = await connectRunPod(client, deps.secrets, api_key);
    return c.json({ ...status, key_saved: !!deps.secrets });
  });
  r.delete('/compute/provider', async (c) => {
    const status = await disconnectRunPod(client, deps.secrets);
    return c.json({ ...status, key_saved: false });
  });

  r.get('/compute/nodes', async (c) => c.json(await client.get('/nodes')));
  // The settings for a pod set up by hand, its key included (shown to you, never logged).
  r.get('/compute/node-setup', async (c) => c.json(await client.get('/node-setup')));
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
