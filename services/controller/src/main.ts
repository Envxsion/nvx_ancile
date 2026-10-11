/**
 * ------------------------------------------------------------------
 *  Title    |  NVX Ancile Controller
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Boot: validate env, pick the store and provider, start
 *           |  the HTTP server, the rule loop and the reconcile loop.
 *  How      |  Postgres when DATABASE_URL is set (state survives a
 *           |  restart), memory otherwise. RunPod with a key; local
 *           |  network nodes from CONTROLLER_LOCAL_NODES; sample nodes
 *           |  (fake) when asked, or in development without a key.
 *  Note     |  A bad env exits 2 with the variable name and the fix;
 *           |  scripts/boot.mjs prints that verbatim.
 * ------------------------------------------------------------------
 */

import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { createApp } from './app';
import { EnvError, loadEnv } from './env';
import { logger } from './logger';
import { reconcile, register, seedSampleNodes } from './nodes';
import { recoverOperations } from './operations/executor';
import { PgStore } from './pgstore';
import { FAKE_SCHEME, FakeProvider } from './providers/fake';
import { LocalNetworkProvider, parseLocalNodes } from './providers/local';
import { RunPodProvider } from './providers/runpod';
import { providerSwitch, SwitchableProvider } from './providers/switch';
import type { ComputeProvider } from './providers/types';
import { evaluateAll, newRunnerState } from './rules/runner';
import { MemoryStore, type Store } from './store';

const LOCAL_NODES_FIX = 'Use a JSON list, e.g. [{"name":"Desk 3090","url":"http://192.168.1.20:11434/v1"}].';

async function boot() {
  let env: ReturnType<typeof loadEnv>;
  let localSpecs: ReturnType<typeof parseLocalNodes> = [];
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  try {
    localSpecs = parseLocalNodes(env.CONTROLLER_LOCAL_NODES);
  } catch (err) {
    process.stderr.write(
      `Controller configuration is invalid:\n  CONTROLLER_LOCAL_NODES: ${(err as Error).message}. ${LOCAL_NODES_FIX}\n`,
    );
    process.exit(2);
  }

  const sql =
    env.CONTROLLER_STORE === 'postgres' && env.DATABASE_URL
      ? postgres(env.DATABASE_URL, { max: 4, onnotice: () => {} })
      : null;
  const store: Store = sql ? new PgStore(sql) : new MemoryStore();

  // Without a RunPod key the Controller shows sample nodes, here as on the
  // desktop: RunPod is connected later from Admin → Compute (Core gives the
  // key, which is held only in memory here).
  const sampleMode =
    env.CONTROLLER_PROVIDER === 'fake' || (env.CONTROLLER_PROVIDER === 'runpod' && !env.RUNPOD_API_KEY);

  /** Sample nodes live in the provider's memory; put them back so the stored records have a machine behind them. */
  const samples = async () => {
    const fake = new FakeProvider(4_000);
    const seeded = await seedSampleNodes(store, fake);
    if (!seeded)
      for (const n of await store.listNodes())
        if (n.provider === 'fake')
          fake.add({
            ref: n.provider_ref,
            name: n.name,
            state: n.observed_state === 'running' ? 'running' : 'stopped',
            gpuType: n.gpu_type,
            hourlyRate: n.hourly_rate,
            endpointUrl: `${FAKE_SCHEME}${n.provider_ref}`,
            region: n.region,
          });
    logger.info({ seeded }, 'sample compute nodes in use: connect RunPod in Admin → Compute');
    return fake;
  };

  let first: ComputeProvider;
  if (env.CONTROLLER_PROVIDER === 'local') first = new LocalNetworkProvider(localSpecs);
  else if (sampleMode) first = await samples();
  else first = new RunPodProvider({ apiKey: env.RUNPOD_API_KEY, baseUrl: env.RUNPOD_API_BASE });
  const provider = new SwitchableProvider(first);

  /** Connect RunPod with a key (checked first; sample nodes are cleared), or go back to samples. */
  const connectProvider =
    env.CONTROLLER_PROVIDER === 'local'
      ? undefined
      : providerSwitch({
          store,
          provider,
          samples,
          connect: (apiKey) => new RunPodProvider({ apiKey, baseUrl: env.RUNPOD_API_BASE }),
          onConnected: () => logger.info('RunPod connected'),
        });
  if (provider instanceof LocalNetworkProvider)
    for (const spec of localSpecs)
      await register(store, provider, {
        provider_ref: spec.url,
        name: spec.name,
        served_models: spec.models,
      }).catch((err) => logger.warn({ err, node: spec.name }, 'local node not registered'));

  // Operations a previous run of the Controller was watching when it stopped.
  const resumed = await recoverOperations({ store, provider });
  if (resumed) logger.info({ resumed }, 'resumed operations interrupted by a restart');

  const runner = newRunnerState();
  const app = createApp({
    store,
    provider,
    token: env.CONTROLLER_TOKEN,
    costCapUsd: env.CONTROLLER_COST_CAP_USD,
    queueDeadlineS: env.CONTROLLER_QUEUE_DEADLINE_S,
    nodeToken: env.CONTROLLER_NODE_TOKEN || undefined,
    routingBlocked: () => runner.routingBlocked,
    ...(connectProvider && { connectProvider }),
  });

  const rules = setInterval(async () => {
    try {
      const outcome = await evaluateAll(store, runner, new Date(), env.CONTROLLER_COST_CAP_USD);
      for (const n of outcome.notices) store.events.emit('event', { type: 'notice', ...n });
      for (const a of outcome.actions) {
        await app.request(`/control/v1/nodes/${a.nodeId}/actions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.CONTROLLER_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            action: a.action,
            idempotency_key: `${a.reason}:${a.nodeId}:${Date.now()}`,
            reason: a.reason,
          }),
        });
      }
    } catch (err) {
      logger.error({ err, component: 'rules' }, 'rule evaluation failed');
    }
  }, env.CONTROLLER_RULES_INTERVAL_S * 1000);
  rules.unref();

  const sync = setInterval(() => {
    reconcile(store, provider).catch((err) =>
      logger.warn({ err, component: 'reconcile' }, 'reconcile failed'),
    );
  }, env.CONTROLLER_RECONCILE_S * 1000);
  sync.unref();

  const server = serve(
    { fetch: app.fetch, port: env.CONTROLLER_PORT, hostname: env.CONTROLLER_HOST },
    (info) =>
      logger.info(
        { port: info.port, provider: provider.id, store: sql ? 'postgres' : 'memory' },
        'controller listening',
      ),
  );
  const stop = () => {
    clearInterval(rules);
    clearInterval(sync);
    server.close(() => {
      void sql?.end({ timeout: 2 });
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void boot();
