/**
 * ------------------------------------------------------------------
 *  Title    |  Controller app
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Assemble health, the control plane and the data plane
 *           |  from injected dependencies, so production, tests and the
 *           |  contract suite build the same app.
 *  How      |  /health is open (liveness only). Everything else needs
 *           |  the Controller token.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { CONTROLLER_CONTRACT_VERSION, type ProviderStatus } from '@nvx/contracts/controller';
import { Hono } from 'hono';
import { type AppEnv, apiError, bearer, trace } from './http';
import { componentLogger } from './logger';
import type { ExecutorDeps } from './operations/executor';
import { controlRoutes } from './routes/control';
import { heartbeatRoutes } from './routes/heartbeat';
import { openaiRoutes } from './routes/openai';

export const VERSION = '0.1.0';

export interface AppDeps extends ExecutorDeps {
  token: string;
  costCapUsd: number;
  queueDeadlineS: number;
  nodeToken?: string;
  routingBlocked?: () => boolean;
  /** Connect RunPod with a key (checked first), or go back to sample nodes with null. */
  connectProvider?: (apiKey: string | null) => Promise<ProviderStatus & { ok: boolean }>;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const log = componentLogger('http');
  app.use('*', trace);

  app.onError((err, c) => {
    log.error({ err, trace_id: c.get('traceId') }, 'unhandled error');
    return apiError(
      c,
      500,
      'controller.internal',
      'The Controller hit an unexpected error',
      'Retry. If it keeps happening, check Admin → Logs for this trace id.',
    );
  });
  app.notFound((c) =>
    apiError(
      c,
      404,
      'route.not_found',
      'No such endpoint',
      `See services/controller/README.md for the contract (v${CONTROLLER_CONTRACT_VERSION}).`,
    ),
  );

  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'controller', version: VERSION, contract: CONTROLLER_CONTRACT_VERSION }),
  );

  const checks = async () => {
    const db = await deps.store.ping().catch(() => false);
    const provider = await deps.provider.ping().catch((e: unknown) => ({ ok: false, detail: String(e) }));
    return [
      {
        name: 'store',
        ok: db,
        detail: db ? 'Store reachable.' : 'Cannot reach the database.',
        fix: db ? null : 'Check DATABASE_URL and that Postgres is up.',
      },
      {
        name: `provider:${deps.provider.id}`,
        ok: provider.ok,
        detail: provider.detail,
        fix: provider.ok ? null : 'Check the provider API key and network.',
      },
    ];
  };

  // Public on purpose: supervisors, the desktop shell and container health
  // checks probe it without credentials. It answers only ready or not, and
  // checks only the store, which is what readiness depends on (a provider
  // outage leaves the Controller able to queue and report). Details, and the
  // remote provider ping, stay behind the token on /selftest.
  app.get('/ready', async (c) => {
    const ready = await deps.store.ping().catch(() => false);
    return c.json({ ready }, ready ? 200 : 503);
  });

  app.use('/selftest', bearer(deps.token));
  app.get('/selftest', async (c) => {
    const results = await checks();
    return c.json({ ok: results.every((r) => r.ok), checks: results });
  });

  const control = controlRoutes({ ...deps });
  // Pods report with their own node token, so this is mounted before the
  // Controller-token guard on the rest of the control plane.
  app.route(
    '/control/v1/nodes/heartbeat',
    heartbeatRoutes({ store: deps.store, nodeToken: deps.nodeToken, ...(deps.now && { now: deps.now }) }),
  );
  app.use('/control/v1/*', async (c, next) =>
    c.req.path === '/control/v1/nodes/heartbeat' ? next() : bearer(deps.token)(c, next),
  );
  app.route('/control/v1', control);

  app.use('/v1/*', bearer(deps.token));
  app.route(
    '/v1',
    openaiRoutes({
      store: deps.store,
      routingBlocked: deps.routingBlocked ?? (() => false),
      queueDeadlineS: deps.queueDeadlineS,
      nodeToken: deps.nodeToken,
      provider: deps.provider,
      ...(deps.now && { now: deps.now }),
      wake: async (nodeId) => {
        // One wake per node: a second queued request joins the first.
        const node = await deps.store.getNode(nodeId);
        if (!node || ['running', 'starting', 'creating'].includes(node.observed_state)) return;
        if (await deps.store.liveOperationFor(nodeId)) return;
        // Reuse the control plane so the wake shows up as a normal confirmation chain.
        await control.request(`/nodes/${nodeId}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'start',
            idempotency_key: `wake-${nodeId}-${randomUUID()}`,
            reason: 'queued request',
          }),
        });
      },
    }),
  );

  return app;
}
