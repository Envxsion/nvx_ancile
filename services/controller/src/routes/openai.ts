/**
 * ------------------------------------------------------------------
 *  Title    |  /v1: the OpenAI-compatible data plane
 *  Ref      |  DESIGN.md §4.3, §7.3
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Any OpenAI client can call a route alias as a model.
 *           |  The Controller decides *where* it runs: a running node,
 *           |  an upstream, or the queue while a node wakes.
 *  How      |  cost cap blocking → 402 cost_cap (Core falls back)
 *           |  node not running  → record the request, wake the node
 *           |                      once, then either hold the request
 *           |                      (x-controller-wait: seconds) until
 *           |                      the node is up, or answer at once
 *           |                      503 node_waking + Retry-After so
 *           |                      the caller can show it and decide
 *           |                      (Core does this, with "Use a cloud
 *           |                      model instead")
 *           |  node running      → stream-through proxy, and the node's
 *           |                      last activity is noted for the idle
 *           |                      rule
 *           |  upstream target   → proxied as is (a box on your LAN,
 *           |                      another OpenAI-compatible server)
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { type AppEnv, apiError } from '../http';
import { FAKE_SCHEME } from '../providers/fake';
import type { ComputeProvider } from '../providers/types';
import type { NodeRecord, Store, StoreEvent } from '../store';

export interface DataPlaneDeps {
  store: Store;
  routingBlocked: () => boolean;
  queueDeadlineS: number;
  /** Ask the control plane to start a node (idempotent). */
  wake: (nodeId: string) => Promise<void>;
  nodeToken?: string;
  fetch?: typeof fetch;
  /** For sample nodes that answer themselves (fake://). */
  provider?: ComputeProvider;
  now?: () => Date;
}

/** Activity is written at most this often per node, to spare the database. */
const ACTIVITY_EVERY_MS = 15_000;
/** The longest a caller may ask us to hold a request open. */
const MAX_HOLD_S = 600;

function routingError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

/** A rough wait, from where the node is in its life. */
export function etaFor(state: NodeRecord['observed_state']): number {
  switch (state) {
    case 'starting':
      return 60;
    case 'creating':
      return 240;
    case 'stopping':
      return 150;
    default:
      return 120;
  }
}

export function openaiRoutes(deps: DataPlaneDeps) {
  const app = new Hono<AppEnv>();
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const lastActivity = new Map<string, number>();

  const noteActivity = async (node: NodeRecord) => {
    const t = now().getTime();
    if (t - (lastActivity.get(node.id) ?? 0) < ACTIVITY_EVERY_MS) return;
    lastActivity.set(node.id, t);
    const fresh = (await deps.store.getNode(node.id)) ?? node;
    await deps.store.putNode({ ...fresh, last_activity_at: new Date(t).toISOString() });
  };

  /** Resolve when the node is running with an endpoint, or null at the deadline. */
  const waitForNode = (nodeId: string, seconds: number, signal: AbortSignal) =>
    new Promise<NodeRecord | null>((resolve) => {
      const done = (n: NodeRecord | null) => {
        clearTimeout(timer);
        deps.store.events.off('event', onEvent);
        signal.removeEventListener('abort', onAbort);
        resolve(n);
      };
      const onEvent = (e: StoreEvent) => {
        if (
          e.type === 'node' &&
          e.node.id === nodeId &&
          e.node.observed_state === 'running' &&
          e.node.endpoint_url
        )
          done(e.node);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), seconds * 1000);
      deps.store.events.on('event', onEvent);
      signal.addEventListener('abort', onAbort);
    });

  app.get('/models', async (c) => {
    const routes = await deps.store.listRoutes();
    return c.json({
      object: 'list',
      data: routes.map((r) => ({ id: r.alias, object: 'model', owned_by: 'nvx-ancile-controller' })),
    });
  });

  const forward = async (
    url: string,
    path: string,
    body: Record<string, unknown>,
    traceparent: string | undefined,
    signal: AbortSignal,
    auth?: string,
  ) =>
    f(`${url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(traceparent ? { traceparent } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

  const proxy = (path: string) =>
    app.post(path, async (c) => {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body?.model)
        return apiError(
          c,
          400,
          'request.invalid',
          'model is required',
          'Use a route alias from GET /v1/models.',
        );
      const route = (await deps.store.listRoutes()).find((r) => r.alias === body.model);
      if (!route) return c.json(routingError('route_unknown', `No route named ${body.model}.`), 404);

      const nodeTarget = route.targets.find((t) => t.node_id);
      const upstream = route.targets.find((t) => t.upstream);
      if (!nodeTarget?.node_id) {
        if (!upstream?.upstream)
          return c.json(routingError('route_unknown', `Route ${route.alias} has no target.`), 404);
        const res = await forward(
          upstream.upstream,
          path,
          body,
          c.req.header('traceparent'),
          c.req.raw.signal,
        );
        const headers = new Headers(res.headers);
        headers.set('x-controller-upstream', new URL(upstream.upstream).host);
        return new Response(res.body, { status: res.status, headers });
      }

      if (deps.routingBlocked()) {
        return c.json(
          routingError('cost_cap', 'The monthly GPU cost cap has been reached; routing to nodes is paused.'),
          402,
        );
      }
      let node = await deps.store.getNode(nodeTarget.node_id);
      if (!node)
        return c.json(routingError('node_failed', 'The route points at a node that no longer exists.'), 503);
      if (node.observed_state === 'terminated' || node.observed_state === 'error')
        return c.json(
          routingError('node_failed', `${node.name} is ${node.observed_state}. Fix it in Admin → Compute.`, {
            node_id: node.id,
          }),
          503,
        );

      let queuedMs = 0;
      if (node.observed_state !== 'running' || !node.endpoint_url) {
        const startedAt = Date.now();
        const deadline = new Date(now().getTime() + deps.queueDeadlineS * 1000);
        await deps.store.enqueue({
          id: `req_${randomUUID()}`,
          routeAlias: route.alias,
          nodeId: node.id,
          status: 'queued',
          attempts: 0,
          deadlineAt: deadline,
          createdAt: now(),
        });
        await deps.wake(node.id).catch(() => undefined);
        const hold = Math.min(
          Number(c.req.header('x-controller-wait') ?? 0) || 0,
          MAX_HOLD_S,
          deps.queueDeadlineS,
        );
        const ready = hold > 0 ? await waitForNode(node.id, hold, c.req.raw.signal) : null;
        if (!ready) {
          const fresh = (await deps.store.getNode(node.id)) ?? node;
          const eta = etaFor(fresh.observed_state);
          c.header('retry-after', String(Math.min(eta, 15)));
          return c.json(
            routingError('node_waking', `${fresh.name} is ${fresh.observed_state}; waking it now.`, {
              eta_s: eta,
              node_id: fresh.id,
            }),
            503,
          );
        }
        node = ready;
        queuedMs = Date.now() - startedAt;
      }

      await deps.store.settleQueued(node.id, 'dispatched');
      void noteActivity(node).catch(() => undefined);

      let res: Response;
      const endpoint = node.endpoint_url as string;
      if (endpoint.startsWith(FAKE_SCHEME) && deps.provider?.serve) {
        res = await deps.provider.serve(node.provider_ref, path, body);
      } else {
        res = await forward(
          endpoint,
          path,
          body,
          c.req.header('traceparent'),
          c.req.raw.signal,
          deps.nodeToken,
        );
      }
      const headers = new Headers(res.headers);
      headers.set('x-controller-node', node.id);
      headers.set('x-controller-queued-ms', String(queuedMs));
      return new Response(res.body, { status: res.status, headers });
    });

  proxy('/chat/completions');
  proxy('/embeddings');
  return app;
}
