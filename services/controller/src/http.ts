/**
 * Shared HTTP helpers: the one error shape (DESIGN.md §11.3), bearer auth,
 * trace propagation.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { logger, traceIdFrom } from './logger';

export type AppEnv = { Variables: { traceId: string } };

export function apiError(
  c: Context<AppEnv>,
  status: 400 | 401 | 402 | 404 | 409 | 422 | 500 | 501 | 503,
  code: string,
  title: string,
  hint: string,
  extra: { detail?: string; retryable?: boolean; context?: Record<string, unknown> } = {},
) {
  return c.json(
    {
      error: {
        code,
        title,
        detail: extra.detail,
        hint,
        retryable: extra.retryable ?? false,
        trace_id: c.get('traceId'),
        attempts: [],
        context: { service: 'controller', ...extra.context },
      },
    },
    status,
  );
}

export const trace: MiddlewareHandler<AppEnv> = async (c, next) => {
  const traceId = traceIdFrom(c.req.header('traceparent'));
  c.set('traceId', traceId);
  const started = performance.now();
  await next();
  c.header('x-trace-id', traceId);
  // One access line per request with the caller's trace id, so a request
  // can be followed from Core into the Controller in the log viewer.
  const line = {
    trace_id: traceId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Math.round(performance.now() - started),
  };
  if (
    c.req.header('x-ancile-probe') === 'background' ||
    ((c.req.path === '/health' || c.req.path === '/ready') && !c.req.header('traceparent'))
  )
    logger.debug(line, 'request');
  else logger.info(line, 'request');
};

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function bearer(token: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const presented = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!presented || !safeEqual(presented, token)) {
      return apiError(
        c,
        401,
        'auth.controller_token_invalid',
        'The request did not carry a valid Controller token',
        'Set CONTROLLER_TOKEN to the same value in Core and the Controller.',
      );
    }
    await next();
  };
}
