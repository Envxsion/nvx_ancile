/**
 * ------------------------------------------------------------------
 *  Title    |  /control/v1: the control plane
 *  Ref      |  DESIGN.md §4.3, contracts/controller.ts
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Nodes, actions with confirmation chains, costs, rules,
 *           |  routes, and the event streams the Cockpit renders.
 *  How      |  POST actions answers 202 with an operation id at once;
 *           |  the executor runs in the background and every step is
 *           |  pushed on /operations/:id/stream and /events.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { ActionRequest, Rule } from '@nvx/contracts/controller';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { computeCosts, monthOf } from '../costs/compute';
import { type AppEnv, apiError, trace } from '../http';
import { componentLogger } from '../logger';
import { register } from '../nodes';
import { type ExecutorDeps, runOperation } from '../operations/executor';
import { advance, createOperation, isTerminal, precheck, resolveIdempotency } from '../operations/machine';
import { ProviderError } from '../providers/types';
import type { NodeRecord, Store, StoreEvent } from '../store';

export interface ControlDeps extends ExecutorDeps {
  store: Store;
  costCapUsd: number;
  newId?: (prefix: 'opn' | 'rul') => string;
}

const ulidish = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`;

export function publicNode(n: NodeRecord) {
  const { createdAt: _c, terminatedAt: _t, runningSince: _r, ...rest } = n;
  return rest;
}

export function controlRoutes(deps: ControlDeps) {
  const { store } = deps;
  const newId = deps.newId ?? ulidish;
  const now = deps.now ?? (() => new Date());
  const app = new Hono<AppEnv>();
  // Also mounted standalone (wake path, rule runner), so it sets its own trace id.
  app.use('*', trace);

  app.get('/nodes', async (c) => c.json({ items: (await store.listNodes()).map(publicNode) }));

  const RegisterBody = z.object({
    provider_ref: z.string().min(1).max(500),
    name: z.string().min(1).max(120).optional(),
    served_models: z.array(z.string().min(1).max(200)).max(50).optional(),
    storage_rate_month: z.number().nonnegative().max(100_000).optional(),
  });

  // Bring an existing pod (or a LAN machine) under management.
  app.post('/nodes', async (c) => {
    const parsed = RegisterBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return apiError(
        c,
        422,
        'request.invalid',
        'The node could not be added',
        'Send {provider_ref} with the pod id (RunPod) or the server URL (local network).',
      );
    try {
      const node = await register(store, deps.provider, parsed.data, now());
      return c.json(publicNode(node), 201);
    } catch (err) {
      if (err instanceof ProviderError)
        return apiError(
          c,
          422,
          `provider.${err.error.code}`,
          err.error.provider_message,
          err.error.suggestion,
        );
      throw err;
    }
  });

  app.delete('/nodes/:id', async (c) => {
    const id = c.req.param('id');
    if (await store.liveOperationFor(id))
      return apiError(
        c,
        409,
        'node.busy',
        'This node has an operation in progress',
        'Wait for it to confirm or time out, then remove the node.',
      );
    return (await store.deleteNode(id))
      ? c.body(null, 204)
      : apiError(c, 404, 'node.not_found', 'No such node', 'Refresh the node list.');
  });

  app.get('/nodes/:id/operations', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 10) || 10, 50);
    return c.json({ items: await store.listOperations(c.req.param('id'), limit) });
  });

  app.get('/nodes/:id', async (c) => {
    const node = await store.getNode(c.req.param('id'));
    if (!node) return apiError(c, 404, 'node.not_found', 'No such node', 'Refresh the node list.');
    return c.json(publicNode(node));
  });

  app.post('/nodes/:id/actions', async (c) => {
    const parsed = ActionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return apiError(
        c,
        422,
        'request.invalid',
        'The action request was not in the expected shape',
        'Send {action, idempotency_key} with an 8+ character key.',
        {
          context: { issues: parsed.error.issues },
        },
      );
    }
    const { action, idempotency_key, reason } = parsed.data;
    const nodeId = c.req.param('id');
    const node = await store.getNode(nodeId);
    if (!node) return apiError(c, 404, 'node.not_found', 'No such node', 'Refresh the node list.');

    const idem = resolveIdempotency(await store.findOperationByKey(idempotency_key), nodeId, action);
    if (idem.kind === 'replay') return c.json({ operation_id: idem.op.id, replayed: true }, 202);
    if (idem.kind === 'conflict') {
      return apiError(
        c,
        409,
        'operation.idempotency_conflict',
        'That idempotency key was already used for a different action',
        'Generate a new key for each distinct request.',
      );
    }

    let op = createOperation({
      id: newId('opn'),
      nodeId,
      action,
      requestedBy: 'core',
      reason: reason ?? null,
      traceId: c.get('traceId'),
      now: now(),
    });
    const check = precheck(action, node.observed_state, Boolean(await store.liveOperationFor(nodeId)));
    if (!check.ok) {
      op = advance(op, 'failed', check.error.provider_message, now(), check.error);
      await store.putOperation(op, idempotency_key);
      return c.json({ operation_id: op.id }, 202);
    }
    if (check.noop) {
      op = advance(op, 'confirmed', check.detail, now());
      await store.putOperation(op, idempotency_key);
      return c.json({ operation_id: op.id }, 202);
    }
    await store.putOperation(op, idempotency_key);
    const log = componentLogger('operations', op.trace_id);
    void runOperation(op.id, idempotency_key, deps).catch((err) => log.error({ err }, 'executor crashed'));
    return c.json({ operation_id: op.id }, 202);
  });

  app.get('/operations/:id', async (c) => {
    const op = await store.getOperation(c.req.param('id'));
    if (!op)
      return apiError(
        c,
        404,
        'operation.not_found',
        'No such operation',
        'It may have been pruned; check the node instead.',
      );
    return c.json(op);
  });

  app.get('/operations/:id/stream', async (c) => {
    const id = c.req.param('id');
    const first = await store.getOperation(id);
    if (!first) return apiError(c, 404, 'operation.not_found', 'No such operation', 'Check the id.');
    return streamSSE(c, async (stream) => {
      let sent = 0;
      const push = async (op: NonNullable<typeof first>) => {
        for (; sent < op.timeline.length; sent++) {
          await stream.writeSSE({
            id: String(sent),
            event: 'step',
            data: JSON.stringify({ ...op.timeline[sent], operation_id: op.id }),
          });
        }
        if (isTerminal(op.status)) await stream.writeSSE({ event: 'done', data: JSON.stringify(op) });
      };
      const resume = Number(c.req.header('last-event-id'));
      if (Number.isInteger(resume) && resume >= 0) sent = Math.min(resume + 1, first.timeline.length);
      await push(first);
      if (isTerminal(first.status)) return;
      await new Promise<void>((resolve) => {
        const onEvent = (e: StoreEvent) => {
          if (e.type !== 'operation' || e.op.id !== id) return;
          void push(e.op).then(() => {
            if (isTerminal(e.op.status)) done();
          });
        };
        const done = () => {
          store.events.off('event', onEvent);
          resolve();
        };
        store.events.on('event', onEvent);
        stream.onAbort(done);
      });
    });
  });

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let seq = 0;
      await new Promise<void>((resolve) => {
        const onEvent = (e: StoreEvent) => {
          const data =
            e.type === 'operation'
              ? {
                  type: 'node.operation',
                  operation_id: e.op.id,
                  node_id: e.op.node_id,
                  action: e.op.action,
                  status: e.op.status,
                  detail: e.op.timeline.at(-1)?.detail ?? '',
                }
              : e.type === 'node'
                ? { type: 'node.updated', node: publicNode(e.node) }
                : { type: 'notice', level: e.level, title: e.title, body: e.body };
          void stream.writeSSE({
            id: String(++seq),
            data: JSON.stringify({ ...data, seq, at: new Date().toISOString() }),
          });
        };
        store.events.on('event', onEvent);
        const heartbeat = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15_000);
        stream.onAbort(() => {
          clearInterval(heartbeat);
          store.events.off('event', onEvent);
          resolve();
        });
      });
    }),
  );

  app.get('/costs', async (c) => {
    const month = c.req.query('month') ?? monthOf(now());
    if (!/^\d{4}-\d{2}$/.test(month))
      return apiError(c, 422, 'request.invalid', 'month must be YYYY-MM', 'For example ?month=2026-10.');
    const nodes = await store.listNodes();
    const summary = computeCosts({
      month,
      now: now(),
      cap: deps.costCapUsd,
      intervals: await store.intervals(),
      nodes: nodes.map((n) => ({
        nodeId: n.id,
        hourlyRate: n.hourly_rate,
        storageRateMonth: n.storage_rate_month,
        createdAt: n.createdAt,
        terminatedAt: n.terminatedAt,
        runningNow: n.observed_state === 'running',
      })),
    });
    return c.json(summary);
  });

  app.get('/rules', async (c) => c.json({ items: await store.listRules() }));

  app.post('/rules', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = Rule.safeParse({ ...body, id: body?.id ?? newId('rul') });
    if (!parsed.success)
      return apiError(
        c,
        422,
        'rule.invalid',
        'The rule is not valid',
        'Check the kind and its config fields.',
        { context: { issues: parsed.error.issues } },
      );
    if (parsed.data.kind === 'schedule') {
      try {
        const { parseCron } = await import('../rules/schedule');
        parseCron(parsed.data.config.cron);
        new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.config.tz });
      } catch (err) {
        return apiError(
          c,
          422,
          'rule.invalid_schedule',
          'The schedule could not be read',
          String((err as Error).message),
        );
      }
    }
    await store.putRule(parsed.data);
    return c.json(parsed.data, 201);
  });

  app.delete('/rules/:id', async (c) =>
    (await store.deleteRule(c.req.param('id')))
      ? c.body(null, 204)
      : apiError(c, 404, 'rule.not_found', 'No such rule', 'Refresh the rules list.'),
  );

  const RouteBody = z.object({
    alias: z.string().min(1),
    targets: z
      .array(
        z.object({
          node_id: z.string().optional(),
          upstream: z.string().url().optional(),
          weight: z.number().optional(),
          max_queue_s: z.number().optional(),
        }),
      )
      .min(1),
    policy: z.record(z.string(), z.unknown()).default({}),
  });
  app.get('/routes', async (c) => c.json({ items: await store.listRoutes() }));
  app.put('/routes/:alias', async (c) => {
    const parsed = RouteBody.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      alias: c.req.param('alias'),
    });
    if (!parsed.success)
      return apiError(
        c,
        422,
        'route.invalid',
        'The route is not valid',
        'Each route needs at least one target with node_id or upstream.',
      );
    await store.putRoute(parsed.data);
    return c.json(parsed.data);
  });

  return app;
}
